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
  hyprland.js       Hyprland 配置（hyprlang / lua）安全读写
  gnome.js          GNOME/Mutter 窗口尺寸现实检查（**只读，不写任何配置**）
  runtime.js        运行时状态发布
  server.js         端口探测 / 进程校验 / 启停
  assets/           图标位图 whale-girl.png + 启动器 bash 模板
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

### 4.3 被修改的文件：`kwinrulesrc` 与 Hyprland 配置

其余都是新增文件。有两处例外，都是**用户已有的配置文件**：

**KDE 的 `~/.config/kwinrulesrc`**：

- **逐行保留原文**，只改我们自己那一段和 `[General]` 的两行。用户手写的其它规则（比如给桌面宠物加 `skiptaskbar`）必须一字不差地留着 —— 所以 `kwin.js` **刻意不做「整体解析再重新序列化」**。
- **改之前备份**成 `kwinrulesrc.dsh-backup`。
- **新规则 id 取「所有数字段名的最大值 + 1」**，而不是 `count + 1`。用户删过规则时后者会撞号并覆盖别人的规则。
- 规则值 `sizerule = 3` 是 **Apply Initially** —— 只在窗口创建时应用一次，之后不干扰用户拖拽。

**Hyprland 的 `~/.config/hypr/hyprland.conf`（或 `hyprland.lua`）** —— 风险比 KDE 高一档，因为 Hyprland 遇到配置错误会**拒绝启动**，用户的整个桌面都挂在那个文件上。所以 `hyprland.js` 有足足四道闸，全部通过才落盘：

1. **配置文件不存在就跳过。** 不替用户抢先创建 —— Hyprland 首次运行会自己生成一份默认配置，我们抢先建一个只有规则的文件会让用户失去它。
2. **版本读不出来就跳过**（`Hyprland --version-json`）。
3. **版本低于 0.53 就跳过**：更早的版本只有 `windowrulev2` 老语法，本机无法实测，不拿用户的配置冒险。
4. **`Hyprland --verify-config` 校验不过就跳过**：离线校验，不起合成器、不占屏幕。只校验我们自己那块，不校验合并结果 —— 合并结果里可能有 `source = 相对路径`，复制到临时目录会解析不到，反而产生假失败。

另外两条硬性约定：

- **规则内联进主配置**，用 `dsh-desktop begin` / `end` 注释标记包起来。**绝不用 `source =`** —— 实测 `source` 指向不存在的文件同样是硬错误，一旦我们的文件被删（清理、同步冲突、卸载不干净），用户的整个配置都会加载失败。
- **两套语法按文件格式选**：`.lua` 用 `hl.window_rule({...})`，`.conf` 用 `windowrule = match:class ...`。两者同时存在时 `.lua` 优先，与 Hyprland 自身行为一致。

### 4.3.1 Hyprland 为什么必须强制浮动

实测（Hyprland 0.56.2）：不写规则时窗口被平铺铺满工作区，**浏览器传的 `--window-size` 被完全忽略**；而 `size` 规则**只对浮动窗口有效**，少了 `float` 就静默失效。所以托管时写的是 `float on, size W H`，`float` 不能省。

正因如此，这个功能**默认关闭**：选了平铺 WM 的用户就是要平铺，插件不该擅自改成浮动。KDE 默认开、Hyprland 默认关，是有意的差异。

### 4.3.2 GNOME：没有可写的东西，所以一行都不写

GNOME 既没有窗口规则配置文件，也没有对应的 dconf 键 —— 这不是「还没支持」，是设计如此。而它也**不需要**：GNOME 是堆叠式（浮动）窗口管理器，Mutter 直接接受 `--window-size`（实测 700x500 / 900x600 / 1200x750 / 1280x800 / 2200x1500 全部精确遵循）。

所以 `gnome.js` **只读不写**，连 `manageGnomeRules` 这样的配置项都不存在。它做两件事：

1. 用 `gdctl show`（随 mutter 一起安装，只读）解析出**主逻辑显示器**尺寸。解析器 `parseGdctlShow` 是纯函数，用真实输出做回归；任何看不懂的结构都返回 `ok: false` 而不是猜一个尺寸 —— 宁可降级成不带数字的提示，也不要给出错的屏幕尺寸。逻辑尺寸 = 物理像素 / 缩放，这一点必须算对：`auto-maximize` 比的是**逻辑**值。
2. 用 `gsettings get org.gnome.mutter auto-maximize`（只读）确认它是否开启。

然后判断：**窗口面积 > 逻辑工作区 × 0.8 就会触发 Mutter 的 auto-maximize，请求的尺寸被丢弃。**

阈值取源码常量 0.8（`src/core/window-private.h:212`、`src/core/place.c:1099`），而不是实测翻转点（83.2%~83.8%，原因未查明）—— 保守取值只会让告警早出现，不会漏报。

**为什么不代用户关掉 auto-maximize**：那是 `org.gnome.mutter` 下的**全局**设置，关掉之后**所有**应用都不再自动最大化。它不是「针对某个窗口的规则」，所以只写进建议文案。测试里有一条断言钉死这一点：installer 在 GNOME 上产生的**每一次** exec 都必须是 `gdctl show` 或 `gsettings get ...`，一旦有人加了 `gsettings set`，用例立刻失败。

**位置设不了**：Wayland 没有让客户端给自己定位的协议，GNOME 用自己的摆放算法。

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
