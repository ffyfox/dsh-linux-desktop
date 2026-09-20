# 实现细节

这份文档面向**想读代码或改代码的人**。用户安装与使用请看 [README](../README.md)。

它记录了三类东西：

1. 代码是怎么组织的；
2. 运行时状态是怎么产生和消费的；
3. 哪些结论是**实测**出来的，而不是从文档抄的 —— 这几条决定了本项目的架构选择，也是改代码时最容易踩回去的坑。

---

## 1. 目录结构

```
src/
  index.js          Cordis 宿主插件行（运行时状态发布 + 幂等自愈）
  installer.js      install / uninstall / status 编排
  cli.js            dsh-desktop 命令行
  paths.js          XDG 路径推导（含沙箱隔离）
  detect.js         桌面环境 / 会话 / 浏览器探测
  config.js         配置默认值、校验、读写
  desktop-entry.js  .desktop 渲染 + app_id 推导
  kwin.js           kwinrulesrc 安全读写
  runtime.js        运行时状态发布
  server.js         端口探测 / 进程校验 / 启停
  assets/           图标 SVG + 启动器 bash 模板
bin/dsh-desktop.js  CLI 可执行入口
scripts/            发布前校验
test/smoke.mjs      冒烟测试
docs/               实现细节
```

项目是**纯 ESM JavaScript，没有构建步骤**。这不是偷懒：DSH 插件通过 pnpm 安装，一旦有构建脚本，用户就必须给 pnpm 授予 `allowBuilds` 权限才能装上 —— 那会把「装一个插件」变成「批准一段在你机器上执行的代码」。保持零构建，装下来就能跑。

---

## 2. 运行时状态：产生与消费

启动器需要「带 token 的地址」才能打开窗口，而这个地址只有 `dsh web` 进程自己知道。产生和消费分处两个进程：

```
dsh web 进程
   └── 插件行 linux-desktop（inject: connection + webServer）
         ├── ctx.connection.authenticatedUrl()  → 带 token 的地址
         ├── ctx.webServer.port                 → 实际端口
         └── 写入 $XDG_RUNTIME_DIR/dsh-desktop/runtime.env   (0600)
                  pid=… / host=… / port=… / url=…
                  ↑ 启动器读它；同时写一份 runtime.json 给工具用
```

关键点：

- **`ctx.connection.authenticatedUrl()` 是官方 API**，不是拼接字符串。它拿到的 token 一定是当前进程有效的那个。
- **发布要发两次**：一次在 `apply()` 里立即发（让已经启动的 `dsh web` 尽快可用），一次等 `ctx.get('loader')?.await()` 返回后再发（此时插件树已稳定，端口等信息才是最终值）。
- **清理要认 pid**：disposer 调用 `clearRuntime(paths, { pid: process.pid })`，只有 pid 匹配才删。否则「关掉旧服务、启动新服务」时，旧进程的退出会把新进程刚写的状态删掉。
- 文件权限 `0600` —— 里面是等同 30 天通行证的 token。

为什么不用「grep 自己的日志」拿 token：那样只能拿到**自己启动的**服务的 token，而插件对「用户手动在终端启动的服务」同样要能工作。

---

## 3. 三条实测得出的关键结论

这些是在 KDE Wayland 上用 KWin 脚本 dump 真实窗口属性、反复试验得出的，不是从文档抄的。**改代码前请先读这一节。**

### 3.1 Chromium 的 Wayland `app_id` 与端口无关

规则是：

```
chrome-<hostname>_<pathname 中 / 换成 _>-<profile 目录名>
```

实测样本（取自 KWin 的 `resourceClass` / `desktopFileName`）：

| `--app=` 目标 | app_id |
|---|---|
| `http://127.0.0.1/` | `chrome-127.0.0.1__-Default` |
| `http://127.0.0.1:3080` | `chrome-127.0.0.1__-Default` |
| `http://127.0.0.1:3080/foo` | `chrome-127.0.0.1__foo-Default` |
| `http://127.0.0.1:3080/a/b` | `chrome-127.0.0.1__a_b-Default` |
| `http://localhost:3080/` | `chrome-localhost__-Default` |
| `https://example.com/` | `chrome-example.com__-Default` |

两个推论：

- **端口不出现在 app_id 里** → 端口可以自由配置而不破坏任务栏图标映射。
- **host 会改变 app_id** → 改 `host` 配置后 `StartupWMClass` 和别名文件必须跟着改（`src/desktop-entry.js` 已自动化这件事）。
- `--user-data-dir` **不**改变它 —— 内部 profile 目录名始终是 `Default`。

### 3.2 只写 `StartupWMClass` 不够（三重映射）

合成器的查找链是：

```
StartupWMClass
   → 一个「文件名等于 app_id」的 .desktop
      → 一个「图标名等于 app_id」的图标
         → 全部落空 = Wayland 通用的黄色圆圈白 W 占位图标
```

所以 `installer.js` 必须同时写出三样东西：主入口的 `StartupWMClass`、文件名等于 app_id 的别名 `.desktop`、图标名等于 app_id 的别名图标。少任何一层都会退化成占位图标 —— 而症状（黄圈白 W）看起来和「图标没装」一模一样，很容易误诊。

### 3.3 Chrome 已在运行时，`--app` 会移交

Chrome 已在运行时执行 `chrome --app=URL`，日志是 `Opening in existing browser session.`，**启动器进程立刻退出**，窗口移交给既有 Chrome 进程。

后果：「等浏览器进程结束来感知窗口关闭」这条路是断的。这是 `profileMode` 默认 `dedicated` 的根本原因 —— 加了 `--user-data-dir` 之后浏览器进程与窗口同生共死，才**可以可靠等待**。

`shared` 模式保留，但明确不承诺自动停服务。

---

## 4. 「不影响 dsh web 本身」的具体机制

README 里对用户承诺的是结论，这里是兑现结论的手段。

### 4.1 用 `inject` 做声明式开关

插件行声明 `inject: ['connection', 'webServer']`。在 `tui`、`headless` 等没有这两个服务的 profile 里，Cordis 会让这一行停在 **PENDING 状态、不激活** —— 桌面集成天然只作用于 web 界面，不需要任何运行时判断。

### 4.2 副作用绝不外抛

所有副作用（写文件、跑外部命令）都包在 `try/catch` 里，任何一步失败只写日志，**绝不向上抛**。自动安装失败不会让 `dsh web` 起不来 —— 对一个在宿主进程里跑的插件行，这是底线。

### 4.3 唯一被修改的文件：`kwinrulesrc`

其余都是新增文件。KDE 的 `~/.config/kwinrulesrc` 是唯一例外，处理方式：

- **逐行保留原文**，只改我们自己那一段和 `[General]` 的两行。用户手写的其它规则（比如给桌面宠物加 `skiptaskbar`）必须一字不差地留着 —— 所以 `kwin.js` **刻意不做「整体解析再重新序列化」**。
- **改之前备份**成 `kwinrulesrc.dsh-backup`。
- **新规则 id 取「所有数字段名的最大值 + 1」**，而不是 `count + 1`。用户删过规则时后者会撞号并覆盖别人的规则。
- 规则值 `sizerule = 3` 是 **Apply Initially** —— 只在窗口创建时应用一次，之后不干扰用户拖拽。

### 4.4 安全底线：不是自己启的服务绝不接管

启动器只停**它自己启动的**服务（`STARTED_BY_US` 闸门）。这就是「关掉窗口后服务还在」有时是**正确行为**的原因：那个服务是你在终端里手动启的。

`dsh-desktop stop` / `restart` 是**你明确发起**的操作，所以它们会动手，但仍然先读 `/proc/<pid>/cmdline` 确认目标真的是 `dsh web`，不是就拒绝并提示 `--force`。

> 开发提示：沙箱模式（`DSH_DESKTOP_ROOT`）能隔离**文件**，但**隔离不了端口**。在沙箱里测试 `stop` / `restart` 时，端口查找有可能命中你真实在跑的服务 —— 所以 `resolveServerTarget` 有 `allowPortLookup` 闸门，默认在沙箱下关闭。

---

## 5. 其它踩过的坑

- **`exec` 的重定向陷阱**：bash 里写 `exec 9>lockfile 2>/dev/null`，`exec` 后面**没有命令**时，所有重定向会永久作用于当前 shell —— 那个 `2>/dev/null` 会把脚本后续所有调试日志丢进黑洞。启动器里因此写成 `if exec 9>"$file"; then …`。
- **日志里的 token**：调试输出会打印启动命令，里面含 token。启动器有 `redact()` 把它打码成 `<REDACTED>`。
- **单实例**：重复点击图标会启动第二个启动器实例；若不 `flock`，第二个实例会因为窗口「秒退」而误判并停掉服务。
- **僵尸进程**：判断进程存活时，`/proc/<pid>/stat` 的 state 为 `Z` 要当作已死，否则「等待退出」永远等不到。同理，等待必须用异步定时器 —— 用 `Atomics.wait` 同步阻塞会卡住事件循环，Node 无法回收子进程。
- **`ctx.effect` 而非 `'dispose'` 事件**：Cordis 4 没有 `'dispose'` 事件，清理逻辑要写成 `ctx.effect(() => { …; return () => cleanup() })`。

---

## 相关文档

- [README](../README.md) —— 安装、使用与配置
