# dsh-linux-desktop

> 让 DeepSeek Harness 在 Linux 桌面上像一个原生应用：从程序启动器点开、独立无边框窗口，以及由它启动的服务随窗口关闭而停止。

这是一个 DSH bundle。它复用系统已有的 Chromium 系浏览器，用标准 XDG 桌面入口把 `dsh web` 接入桌面环境，并且不修改 `dsh web` 自身的行为。

**分发状态**：已发布到 npm，也可以直接从 GitHub 安装。

---

## 它做什么

`dsh web` 提供完整的 Web 界面，但它在 Linux 桌面上有三处不便：没有独立的任务栏与 Alt-Tab 条目；服务生命周期依附于终端；社区的桌面类插件主要面向 Windows 与 macOS，截至 2026 年 9 月尚未见到面向 Linux XDG 桌面入口的实现（如有遗漏，欢迎指正）。

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

```bash
dsh plugin --profile web add dsh-linux-desktop
```

安装后重启一次 `dsh web`。

想跟着 `main` 走就换成从 GitHub 装：

```bash
dsh plugin --profile web add github:ffyfox/dsh-linux-desktop
```

两种来源都能锁定版本：

```bash
dsh plugin --profile web add dsh-linux-desktop@0.4.2
dsh plugin --profile web add github:ffyfox/dsh-linux-desktop#v0.4.2
```

改代码时改用本地检出：

```bash
dsh plugin --profile web add /path/to/dsh-linux-desktop
```

> **三种来源都实测过**，各自在隔离的 `DSH_HOME` 里跑通，装完 `dsh` 会自动把这一行注册进 profile 的 `dsh.profile.bundles`，不需要手工编辑 `package.json`。按包名走 registry 最快；从 GitHub 装要克隆整个仓库，慢一个数量级。
>
> 本插件是纯 ESM JavaScript，没有构建步骤，所以从任何来源安装都不需要给 pnpm 授予 `allowBuilds` 权限。

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

`install` 的选项：`--force`、`--port`、`--host`、`--size`、`--browser`、`--profile-mode`、`--no-kwin`、`--hyprland`、`--no-auto-install`。
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
| `profile` | 桌面图标启动哪个 dsh profile。默认 `web`（与 `dsh web` 等价）。 |
| `devProfile` | 非空时，桌面入口右键菜单多一个「以开发配置运行」。见下文「日常那套与开发那套」。 |
| `autoInstall` | 是否在 `dsh web` 启动时自动安装或自愈。 |
| `manageKwinRules` | 是否托管 KWin 窗口规则，仅 KDE 生效。 |
| `manageHyprlandRules` | 是否托管 Hyprland 窗口规则，仅 Hyprland 生效。**默认关闭**，见下文「Hyprland 与窗口尺寸」。 |
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

### 日常那套与开发那套

`dsh web` 与 `dsh --profile web` 完全等价，而桌面图标走的就是它。所以默认情况下，**图标启动的 profile 就是你的日常环境**。

如果你在开发插件（把源码仓库 `link:` 进 profile），那么工作区**就是**正在跑的插件：存一下客户端文件它立刻热更进浏览器，写错一行宿主代码重启就起不来。把 `devProfile` 指向另一个 profile，日常和开发就能彻底分家：

```json
{
  "profile": "web",
  "devProfile": "web-dev"
}
```

- **点图标** → `web`（建议装已发布的冻结版本，稳定）
- **右键 →「以开发配置运行」** → `web-dev`（建议 `link:` 到源码仓库）

那个右键动作会自动带上三个环境变量：

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_PROFILE` | 切到 `devProfile` 指定的 profile。 |
| `DSH_DESKTOP_PORT` | 换成 `port + 1`。不换端口的话，第二套的服务探测会命中第一套并直接复用它 —— 右键点开看到的还是日常那套。 |
| `DSH_DESKTOP_ROOT` | 沙箱根目录（`$XDG_CACHE_HOME/dsh-desktop-dev`）。**这一项不能省**：插件的自动安装会写 `~/.local/bin` 与 `~/.local/share/applications`，而这些**不随 profile 分家**。没有沙箱，用开发版代码启动一次就会覆盖掉日常那套的启动器与桌面入口。 |

三个变量都能在命令行上手动覆盖，所以不用右键动作也可以这样起开发那套：

```bash
DSH_DESKTOP_ROOT=~/.cache/dsh-desktop-dev dsh --profile web-dev --no-open --port 3081
```

`dsh-desktop` 的 `start` / `restart` 走 `profile` 指定的那套；`stop` 按进程命令行识别服务，两种写法（`dsh web` 与 `dsh --profile <名字>`）都认。

## Hyprland 与窗口尺寸

Hyprland 是平铺合成器，而「固定窗口尺寸」和「平铺」天然冲突。实测（Hyprland 0.56.2）：

| 是否托管 | 结果 |
|---|---|
| 不托管（**默认**） | 窗口按平铺布局铺满工作区。此时 `window` 里的宽高**不起作用** —— 平铺下浏览器传的 `--window-size` 会被合成器忽略。 |
| 托管 | 强制该窗口浮动，并使用 `window` 里的宽高。 |

默认关闭是刻意的：选了平铺 WM 的用户就是要平铺，插件不该擅自把它改成浮动。想要固定尺寸就在设置页打开「托管 Hyprland 窗口规则」，或用 `dsh-desktop install --hyprland`。

规则会被内联进你的 Hyprland 配置，并用注释标记包起来：

```ini
# dsh-desktop begin
windowrule = match:class ^(chrome-127\.0\.0\.1__-Default)$, float on, size 1200 750
# dsh-desktop end
```

Hyprland 0.56 起全新安装生成的是 Lua 格式的 `hyprland.lua`，老用户升级上来的仍是 `hyprland.conf`；插件会按实际生效的那一份写入对应语法（两者同时存在时 `.lua` 优先，与 Hyprland 自身行为一致）。

写入前会先用 `Hyprland --verify-config` 离线校验，校验不过就一个字都不写 —— 因为 Hyprland 遇到配置错误会直接拒绝启动，而你的整个桌面都挂在那个配置上。同理，插件**不会**替尚未运行过 Hyprland 的用户创建配置文件，也不会用 `source =` 引入外部文件（目标文件一旦缺失同样会导致整个配置加载失败）。

需要 Hyprland 0.53 及以上（更早的版本只有 `windowrulev2` 老语法，未做实测，插件会跳过并说明原因）。

## GNOME 与窗口尺寸

**GNOME 不需要窗口规则，插件也一行都不写。**

GNOME 是堆叠式（浮动）窗口管理器 —— 和 Hyprland 正好相反。窗口本来就自由浮动，Mutter 会直接接受浏览器传的 `--window-size`。实测（Mutter 50.5，headless 虚拟显示器）：

| `--window-size` | 实测窗口 |
|---|---|
| 900,600 | 900x600 |
| 1200,750 | 1200x750 |
| 1280,800 | 1280x800 |
| 2200,1500 | 2200x1500 |

全部**精确遵循**。GNOME 既没有 `kwinrulesrc` 那样的规则文件，也没有对应的 dconf 键 —— 这不是「还没支持」，是 GNOME 的设计如此。所以插件在 GNOME 下不写任何配置。

### 唯一的例外：auto-maximize

Mutter 默认开启 `org.gnome.mutter auto-maximize`：**窗口面积超过工作区约 80% 时直接把它最大化，请求的尺寸被丢弃。**

所以 `dsh-desktop status` / `doctor` 会读一次逻辑工作区（**只读**，用 `gdctl show`），并在你的 `window` 尺寸会触发这条规则时告警：

```
! gnome-window-size    窗口 2400x1500 占逻辑工作区 2560x1600 的 88%，超过 80% —— GNOME 会把它最大化，尺寸设置将不生效。
```

两个解决办法：

1. 把窗口宽高调到逻辑工作区的 80% 以下（推荐 —— 不影响其它应用）；
2. `gsettings set org.gnome.mutter auto-maximize false`。注意这是**全局**设置，会让**所有**应用都不再自动最大化。插件**不会**替你改它，因为那不是「针对某个窗口的规则」。用 `gsettings reset org.gnome.mutter auto-maximize` 还原。

阈值取 80%：源码常量是 `MAX_UNMAXIMIZED_WINDOW_AREA = .8`，而实测翻转点在 83.2%~83.8% 之间（原因未查明）。**宁可早一点提醒，也不要让你遇到「我明明设了尺寸却没生效」。**

### 位置设不了

Wayland 没有让客户端给自己定位的协议，GNOME 用自己的摆放算法。`--window-position` 在 GNOME 下无效 —— 这不是插件没做，是协议层没有这个能力。

## 卸载

```bash
dsh plugin --profile web exec dsh-desktop uninstall
```

移除启动脚本、`dsh.desktop`、app_id 别名入口、图标与 KWin 规则。
保留 `~/.config/dsh-desktop/`，其中包含配置与备份。

## 兼容性

| 维度 | 状态 |
|---|---|
| DSH | **已验证**：0.1.7-rc.1（客户端设置服务 `configForms`）。**向后兼容**：0.1.7 之前用 `settingsScope` 的宿主同样可用 |
| 桌面环境 | **已验证**：KDE Plasma 6。**部分验证**：Hyprland 0.56.2（app_id 推导与窗口尺寸规则已实测，见「Hyprland 与窗口尺寸」；完整桌面会话下的桌面入口未验证）。**部分验证**：GNOME / Mutter 50.5（窗口尺寸行为已实测，见「GNOME 与窗口尺寸」；完整桌面会话下的桌面入口未验证）。**预期可用但未验证**：Sway 等其它 wlroots 系、Xfce、MATE、Cinnamon、i3 —— 窗口与桌面入口均为标准 XDG，窗口规则只在 KDE 与 Hyprland 下写入 |
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
| Hyprland 下窗口铺满整个工作区，宽高设置没反应 | 这是**默认行为**：平铺布局下尺寸设置不生效。要固定尺寸，请在设置页打开「托管 Hyprland 窗口规则」，或执行 `dsh-desktop install --hyprland`。 |
| Hyprland 下开了托管，窗口仍然铺满 | 检查 `~/.config/hypr/hyprland.conf`（或 `hyprland.lua`）里是否有 `dsh-desktop begin` 标记块。没有就说明写入被跳过了，执行 `dsh-desktop doctor` 看 `hyprland-rule` 一项给出的原因（常见：Hyprland 版本低于 0.53、尚未生成配置文件）。 |
| GNOME 下窗口一开就最大化，宽高设置没反应 | 触发了 Mutter 的 auto-maximize（窗口面积超过逻辑工作区约 80%）。把宽高调到屏幕的 80% 以下，或自行执行 `gsettings set org.gnome.mutter auto-maximize false`（全局设置，插件不会代改）。`dsh-desktop doctor` 的 `gnome-window-size` 一项会算出具体占比。 |
| GNOME 下 `gnome-window-size` 只说「原生遵循」但没给数字 | 读不到逻辑工作区（`gdctl show` 失败，例如不在 GNOME 会话里，或 GNOME 版本过旧）。这是正常降级，不影响窗口本身 —— GNOME 本来就遵循 `--window-size`。 |
| 启动器没有反应 | 以 `DSH_DESKTOP_DEBUG=1 ~/.local/bin/dsh-desktop-app` 运行查看调试输出。日志位于 `$XDG_RUNTIME_DIR/dsh-desktop-web.log`。 |
| 右键「以终端界面运行 (dsh-tui)」打开的是一个普通 bash，并提示 `Could not find 'dsh'` | 入口里写的是裸 `dsh`，而桌面会话的 `PATH` 不含用户级 bin。执行 `dsh-desktop install --force` 刷新入口，动作会改用 `dsh` 的绝对路径。 |
| 服务是刚由启动器拉起的，窗口要等十几秒才出现 | 有意的：自启路径会先等 `dsh web:` 落定行，再等一次会话 API 探测成功，两道都过才开窗。服务端插件集越大，这段等待越长；窗口出现时后端一定是可用的。 |
| 关闭窗口后服务仍在运行 | 当前为 `shared` 模式，或服务由别处启动，本插件不接管。改用 `dedicated` 并从桌面图标启动服务。 |
| 启动时报 `dsh-linux-desktop: pending (waiting for service: settingsScope)`，`dsh web` 起不来 | DSH 0.1.7 起把设置服务从 `settingsScope` 改名成了 `configForms`，0.4.1 及更早的版本会一直等那个不存在的服务。升级到 0.4.2 及以上。 |
| 设置页「插件配置」里没有「桌面集成」卡片 | 宿主没注册命名空间。确认 `dsh web` 已重启过，且 `@deepseek-ai/schemastery` 可被加载；本地检出方式安装时见上文「设置页卡片与 config.json 的关系」。 |

## 开发

在仓库根目录执行：

```bash
node test/smoke.mjs                                   # 冒烟测试，用例共 135 项，零依赖
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
