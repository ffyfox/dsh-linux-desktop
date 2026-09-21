# dsh-linux-desktop

> 让 DeepSeek Harness 在 Linux 桌面上像一个原生应用：从程序启动器点开、独立无边框窗口、关掉窗口后台服务自动停止。

这是一个 DSH bundle。它复用系统已有的 Chromium 系浏览器，用标准 XDG 桌面入口把 `dsh web` 接入桌面环境，并且不修改 `dsh web` 自身的行为。

**分发状态**：本仓库当前为私有，npm 上的包已下架。安装方式见下文。

---

## 它做什么

`dsh web` 提供完整的 Web 界面，但它在 Linux 桌面上有三处不便：没有独立的任务栏与 Alt-Tab 条目；服务生命周期依附于终端；社区的桌面类插件面向 Windows 与 macOS，没有面向 Linux XDG 桌面入口的实现。

本插件补齐这三处。它做五件事：

1. 在 `~/.local/share/applications/` 写入标准 XDG 桌面入口，使 `dsh web` 可以从程序启动器启动。
2. 用 Chromium 的 `--app` 模式打开窗口，窗口中只有 dsh web 界面，没有地址栏、标签页或书签栏。
3. 在 `dsh web` 未运行时启动它，并在窗口关闭后停止由自己启动的服务。
4. 幂等地维护上述文件：`dsh web` 每次启动时同步到当前版本，内容未变化时不改动文件。
5. 在 Web 设置页的「插件 → 插件配置」里提供一张「桌面集成」卡片，用于编辑下面那组配置。

## 系统要求

- Linux
- 一个 Chromium 系浏览器：Google Chrome、Chromium、Brave、Microsoft Edge、Vivaldi 或 Opera
- `dsh` 已安装（安装时会把它的绝对路径固化进启动器与右键动作，因此不要求桌面会话的 `PATH` 里能找到它）
- 可选：`curl`（缺失时回退到 bash 内建的 `/dev/tcp` 做端口探测）

Firefox 不受支持：Firefox 已移除 SSB（Site Specific Browser），无法提供无地址栏的独立窗口。降级为 `firefox --new-window` 会带回地址栏与标签页，因此本插件在该情况下直接报错，而不是静默降级。

## 安装

目前可用的安装方式只有本地检出：

```bash
dsh plugin --profile web add /path/to/dsh-linux-desktop
```

安装后重启一次 `dsh web`。

> **为什么只有这一种方式**：npm 上的 `dsh-linux-desktop` 已下架，本仓库为私有，因此 `add dsh-linux-desktop`（按包名）与 `add github:ffyfox/dsh-linux-desktop` 对其他人不可用。
>
> 本地检出方式在隔离的 `DSH_HOME` 中实测通过。本插件是纯 ESM JavaScript，没有构建步骤，所以从任何来源安装都不需要给 pnpm 授予 `allowBuilds` 权限。

## 使用

从程序启动器（KRunner、应用菜单或任务栏固定项）点击 **DeepSeek Harness**。

启动器按以下顺序工作：

1. 取单实例锁。只有一个实例负责管理服务生命周期。
2. 探测 `dsh web` 是否已在监听。HTTP 401 也算作「在监听」。
3. 若未在监听，启动一个 `dsh web`，并记录「这是本实例启动的」。
4. 轮询等待带 token 的鉴权地址出现。
5. 用 `--app` 模式打开独立窗口。
6. 等待窗口进程退出。

窗口关闭后，如果服务是本实例启动的，就向进程组发送 `SIGTERM`；超时后发送 `SIGKILL`。

**不是本实例启动的服务不会被停止。** 这包括你在终端中手动启动的 `dsh web`。因此「关闭窗口后服务仍在运行」在某些情况下是正确行为。

### 关于带 token 的地址

`dsh web` 有一道鉴权围栏：不带 cookie 访问 `/` 返回 HTTP 401（`dsh web authentication required`）。进程每次启动会生成一个随机的 launch token，只有 `GET /?token=...` 这一次交换会种下签名 cookie，之后裸地址才可用。该 cookie 绑定 host 与 port，有效期 30 天。

因此首次启动、cookie 过期后，或使用一个从未登录过的浏览器配置目录时，都需要 token。本插件的做法是让运行在 `dsh web` 进程内部的插件行调用官方 API `ctx.connection.authenticatedUrl()`，把结果写入运行时文件供启动器读取。这样无论服务由谁启动，插件都能取得 token。

## 命令

安装时会写入一个 CLI 垫片到 `~/.local/bin/dsh-desktop`，因此下列命令可以直接执行。

| 命令 | 作用 |
|---|---|
| `dsh-desktop install` | 安装或修复桌面集成（幂等） |
| `dsh-desktop uninstall` | 移除桌面集成，保留配置与备份 |
| `dsh-desktop status` | 查看安装状态与健康检查 |
| `dsh-desktop doctor` | 诊断并给出修复建议 |
| `dsh-desktop config` | 查看配置文件位置与内容 |
| `dsh-desktop set <键> <值>` | 修改一项配置并重新安装 |
| `dsh-desktop open` | 以独立窗口打开 dsh，等价于点击桌面图标 |
| `dsh-desktop stop` | 停止正在运行的 `dsh web` |
| `dsh-desktop restart` | 重启 `dsh web` |
| `dsh-desktop runtime` | 查看当前 `dsh web` 的运行时状态 |

`install` 的选项：`--force`、`--port`、`--host`、`--size`、`--browser`、`--profile-mode`、`--no-kwin`、`--no-auto-install`。
`stop` 与 `restart` 的选项：`--force`。
通用选项：`--root <目录>`（沙箱模式，把所有读写重定向到该目录）、`--json`。

`dsh-desktop` 这个 bin 安装在 profile 的 `node_modules/.bin/` 下，不在 `PATH` 上。垫片把绝对路径固化下来；每次安装或自愈都会刷新它。不使用垫片的等价写法是：

```bash
dsh plugin --profile web exec dsh-desktop <子命令>
```

`stop` 与 `restart` 是你明确发起的操作，因此会执行，但仍会先读取 `/proc/<pid>/cmdline` 校验目标进程确实是 `dsh web`，校验失败则拒绝并提示 `--force`。

> `dsh-desktop runtime` 会明文打印带 token 的完整地址。启动器的调试日志会把 token 打码为 `<REDACTED>`，但这个命令不会 —— 它输出的地址本身就是它的用途。注意不要把它的输出贴到公开场合。

## 配置

配置文件位于 `~/.config/dsh-desktop/config.json`，首次安装时自动生成。

| 键 | 说明 |
|---|---|
| `host` / `port` | 启动器启动 `dsh web` 时使用的地址。 |
| `window` | 独立窗口的初始尺寸，逻辑像素。 |
| `browser` | `auto`，或 `chrome` / `chromium` / `brave` / `edge` / `vivaldi` / `opera`，或浏览器可执行文件的绝对路径。 |
| `profileMode` | `dedicated`（默认）或 `shared`。 |
| `autoInstall` | 是否在 `dsh web` 启动时自动安装或自愈。 |
| `manageKwinRules` | 是否托管 KWin 窗口规则，仅 KDE 生效。 |
| `terminalAction` / `terminalCommand` | 桌面入口右键菜单中的「以终端界面运行」。留空则自动探测已安装的终端。 |

修改配置有三种方式。推荐第一种：

```bash
# 1. 在 Web 设置页里改：插件 → 插件配置 → 桌面集成。保存后立即生效。
# 2. 直接编辑后重新安装
$EDITOR ~/.config/dsh-desktop/config.json
dsh plugin --profile web exec dsh-desktop install

# 3. 或用 CLI 修改，会自动重新安装
dsh plugin --profile web exec dsh-desktop set window 1400x900
```

### 设置页卡片与 config.json 的关系

卡片写入的是 DSH 的 `settings.yaml`（命名空间 `linux-desktop`），它叠在 `config.json` **之上**：生效值 = schema 默认值 → `config.json` → `settings.yaml` 用户覆盖。因此已有的 `config.json` 继续生效，不需要迁移；卡片里改过的字段会显示「已覆盖」，点「重置」即回落到 `config.json` 的值。

`host` 与 `port` 不在卡片里。它们必须与 `dsh web` 实际绑定的地址一致，只由 `config.json` 决定。

卡片依赖 `@deepseek-ai/schemastery`（安装时会作为依赖装上）。若用本地检出（`link:`）方式安装且该包不可用，卡片不会出现，桌面集成其余部分照常工作。

### profileMode

Chrome 已在运行时执行 `chrome --app=URL` 会把窗口移交给既有浏览器进程，启动器进程随即退出。此时无法通过等待进程来感知窗口关闭。

| 模式 | 行为 | 代价 |
|---|---|---|
| `dedicated`（默认） | 用 `--user-data-dir` 指向独立配置目录，浏览器进程与窗口同生共死，因此可以可靠地感知窗口关闭 | 多一个浏览器进程；独立的 cookie 罐，首次通过 token 地址登录，之后 30 天免登录 |
| `shared` | 复用默认浏览器配置目录 | 共享登录态，无额外进程；但 Chrome 已在运行时无法感知窗口关闭，因此不会自动停止服务，此时会弹出通知说明 |

## 卸载

```bash
dsh plugin --profile web exec dsh-desktop uninstall
```

移除启动脚本、`dsh.desktop`、app_id 别名入口、图标与 KWin 规则。
保留 `~/.config/dsh-desktop/`，其中包含配置与备份。

## 兼容性

| 维度 | 状态 |
|---|---|
| 桌面环境 | **已验证**：KDE Plasma 6。**预期可用但未验证**：GNOME、Hyprland/Sway 等 wlroots 系、Xfce、MATE、Cinnamon、i3 —— 窗口与桌面入口均为标准 XDG，KWin 规则只在 KDE 下写入 |
| 显示协议 | **已验证**：Wayland。**预期可用但未验证**：X11 |
| 浏览器 | **已验证**：Google Chrome。**预期可用但未验证**：Chromium、Brave、Edge、Vivaldi、Opera |
| 发行版 | **已验证**：Arch Linux |

已验证环境：Arch Linux、KDE Plasma 6、Wayland、200% 缩放（逻辑分辨率 1536×960）。

上表中标注「未验证」的条目来自架构推断，尚未在对应环境中实测。若你在其中某个环境上运行，`dsh-desktop doctor` 的输出可作为验证结果。

## 故障排查

```bash
dsh plugin --profile web exec dsh-desktop doctor
```

| 现象 | 原因与处理 |
|---|---|
| 任务栏显示黄色圆圈加白色 W | app_id 别名入口或别名图标缺失。执行 `dsh-desktop install --force`。 |
| 窗口显示 `dsh web authentication required` | 未取得带 token 的地址，且独立配置目录中没有有效 cookie。重启一次 `dsh web`。 |
| 窗口开在默认浏览器配置中而非独立窗口 | 有意的兜底：未取得 token 且独立配置目录从未登录时，改用默认配置以避免 401。重启一次 `dsh web` 后恢复。 |
| 窗口纵向拉满并贴住上下边缘 | KWin 规则未生效。检查 `~/.config/kwinrulesrc` 中是否存在某一段的 `description = DeepSeek Harness Window Rule`（段名是数字，不是这句话），然后执行 `qdbus6 org.kde.KWin /KWin reconfigure`。 |
| 启动器没有反应 | 以 `DSH_DESKTOP_DEBUG=1 ~/.local/bin/dsh-desktop-app` 运行查看调试输出。日志位于 `$XDG_RUNTIME_DIR/dsh-desktop-web.log`。 |
| 右键「以终端界面运行 (dsh-tui)」打开的是一个普通 bash，并提示 `Could not find 'dsh'` | 入口里写的是裸 `dsh`，而桌面会话的 `PATH` 不含用户级 bin。执行 `dsh-desktop install --force` 刷新入口，动作会改用 `dsh` 的绝对路径。 |
| 服务是刚由启动器拉起的，窗口要等十几秒才出现 | 有意的：自启路径会先等 `dsh web:` 落定行，再等一次会话 API 探测成功，两道都过才开窗。服务端插件集越大，这段等待越长；窗口出现时后端一定是可用的。 |
| 关闭窗口后服务仍在运行 | 当前为 `shared` 模式，或服务由别处启动，本插件不接管。改用 `dedicated` 并从桌面图标启动服务。 |
| 设置页「插件配置」里没有「桌面集成」卡片 | 宿主没注册命名空间。确认 `dsh web` 已重启过，且 `@deepseek-ai/schemastery` 可被加载；本地检出方式安装时见上文「设置页卡片与 config.json 的关系」。 |

## 开发

```bash
git clone https://github.com/ffyfox/dsh-linux-desktop.git
cd dsh-linux-desktop
node test/smoke.mjs                                   # 冒烟测试，72 项，零依赖
node scripts/prepublish-check.mjs                     # 发布前校验
npm pack --dry-run                                    # 校验打包产物
node bin/dsh-desktop.js install --root /tmp/sandbox   # 沙箱安装，不触碰真实目录
```

以上前三条是 CI 在每次 push 与 PR 时执行的命令，也是合并前必须通过的门。CI 覆盖 Node 20、22、24，并在 macOS 上额外验证「非 Linux 平台安静地不执行任何操作」。

`--root <目录>` 或环境变量 `DSH_DESKTOP_ROOT` 会把全部读写重定向到沙箱，包括 `HOME` 与所有 `XDG_*` 路径。端口不在沙箱范围内，测试时注意不要影响正在使用的服务。

## 架构决策

**[docs/internals.md](https://github.com/ffyfox/dsh-linux-desktop/blob/main/docs/internals.md)** 记录了本项目的设计取舍与实测结论：目录结构、运行时状态的产生与消费、三条决定架构的实测结论，以及「不影响 dsh web 本身」的具体机制。

## 许可证

MIT
