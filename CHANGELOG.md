# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.4.1] - 2026-09-23

仓库转为公开，顺带修正文档里一个早就过期的数字。

### 新增

- **公开安装方式**：`dsh plugin --profile web add github:ffyfox/dsh-linux-desktop`。这是本插件第一个不需要克隆仓库的安装方式，也是社区通用的装法。已在隔离的 `DSH_HOME` 中实测通过 —— `dsh` 会自动把这一行注册进 profile 的 `dsh.profile.bundles`，不需要手工编辑 `package.json`。README 同时给出了锁定版本的写法（`#v0.4.1`）。

### 修正

- **README 里声明的测试数量早就过期了**。两个 README 都写着「72 项」/「72 checks」，实际是 116 项。拿各 tag 逐个对：v0.1.0 写 61（当时对）、v0.2.0 写 72（当时对）、v0.3.0 写 72（实际 94）、v0.4.0 写 72（实际 116）。
- **给发布前校验加了第 7 节的一条闸**：不再靠人记得改，而是从冒烟测试的真实输出里读出「全部通过：<N> 项」，再核对两个 README 里声明的数量 —— 不一致、或故意不写数量，都阻塞发布。只在 Linux 上核对，因为其它平台会跳过依赖 Linux 的用例。这条闸用三个反例实测过会响（数字改错 / 整句删掉 / 只改中文那一处）。

### 变更

- **仓库可见性由私有改为公开。** 公开前的审计结论：全部历史里没有密钥、没有真实邮箱（提交者是 `299493445+ffyfox@users.noreply.github.com`）、没有内网地址、没有凭证文件，提交信息与作者身份都不需要重写历史。

## [0.4.0] - 2026-09-22

加入 GNOME 支持。与 KDE / Hyprland 不同，这一版**不写任何配置** —— 因为实测证明 GNOME 根本不需要窗口规则。

### 新增

- **GNOME 尺寸现实检查**（`src/gnome.js`，**只读**）
  - `dsh-desktop install` / `status` / `doctor` 在 GNOME 上新增 `gnome-window-size` 一项：读一次逻辑工作区（`gdctl show`）与 `org.gnome.mutter auto-maximize`，判断配置的窗口尺寸会不会被 Mutter 的 auto-maximize 吃掉。
  - 超过阈值时升级为 `warning`，并给出算出来的真实占比；`doctor` 附带两种解法。
  - 设置页「窗口宽度/高度」的说明文字补上了这条注意事项。

### 变更

- **桌面环境兼容性**：GNOME 从「预期可用但未验证」升级为「部分验证」（窗口尺寸行为已实测）。

### 实测结论（Mutter 50.5，headless 虚拟显示器）

- **GNOME 原生遵循 `--window-size`，不需要任何窗口规则。** GNOME 是堆叠式（浮动）窗口管理器，实测 700x500 / 900x600 / 1024x640 / 1100x700 / 1152x720 / 1200x750 / 1280x800 / 2200x1500 **全部精确遵循**。GNOME 既没有 `kwinrulesrc` 那样的规则文件，也没有对应的 dconf 键。
- **唯一的例外是 auto-maximize。** Mutter 默认开启 `org.gnome.mutter auto-maximize`：窗口面积超过工作区一定比例时直接最大化，请求的尺寸被丢弃。源码常量是 `MAX_UNMAXIMIZED_WINDOW_AREA = .8`（`window-private.h:212`），而实测翻转点在 **83.2%~83.8%** 之间 —— 两者对不上，原因未查明。**告警因此取更保守的 0.8。**
- **因果链已验证**：关掉 auto-maximize 后，连正好满屏的 2560x1600 都被遵循。
- **GNOME 无法像 Hyprland 那样嵌套测试。** GNOME 49 起 X11 会话默认关闭、50 起移除，Mutter 50.5 的 `--help` 里已没有 `--nested`。测试台改用 `--headless --virtual-monitor`（走渲染节点但不做 mode setting，不影响正在运行的桌面）。
- **位置设不了**：Wayland 没有让客户端给自己定位的协议，`--window-position` 在 GNOME 下无效。
- **没有可用的第三方窗口规则扩展**：扩展生态里最接近的 Smart Auto Move NG（2.0 万下载）与 Deja Window（6,598 下载）都是「学习并恢复」型，不接受外部写入的规则；Deja Window 的 `window-app-configs` 是私有 JSON 格式，耦合它会随扩展升级而损坏。**故不集成。**

### 已知限制

- 尚未在**完整 GNOME 会话**（而非 headless）下验证桌面入口与图标显示。
- `gdctl show` 读不出来时（例如不在 GNOME 会话里）会降级成不带数字的提示，不影响窗口本身。

## [0.3.0] - 2026-09-21

加入 Hyprland 支持。默认保持平铺，需要固定窗口尺寸的用户可以显式打开。

### 新增

- **Hyprland 窗口尺寸规则**（`src/hyprland.js`）
  - 新增配置项 `manageHyprlandRules`，**默认 `false`**；设置页新增「托管 Hyprland 窗口规则」开关，CLI 新增 `--hyprland`。
  - 打开后把窗口规则内联进 Hyprland 配置，强制该窗口浮动并使用 `window` 里的宽高；关闭时窗口遵循平铺布局，宽高设置不生效。

### 变更

- **桌面环境兼容性**：Hyprland 从「预期可用但未验证」升级为「部分验证」（app_id 推导与窗口尺寸规则已实测）。

### 实测结论（Hyprland 0.56.2，嵌套会话）

- **平铺会吞掉一切尺寸。** 不写规则时窗口铺满工作区，浏览器传的 `--window-size` 被完全忽略；`size` 规则**只对浮动窗口有效**，必须同时给 `float`，否则静默失效。
- **配置有两套格式。** 0.56 起全新安装生成 `hyprland.lua`（Lua 语法），老用户升级上来的仍是 `hyprland.conf`（hyprlang 语法）；两者同时存在时 **`.lua` 优先**。
- **写错配置会让 Hyprland 拒绝启动。** 旧语法 `windowrulev2` 在 0.56 是硬错误（`--verify-config` 退出码 1），`source =` 指向不存在的文件同样是硬错误。因此规则内联 + 注释标记，且写入前先离线校验。
- app_id 公式在 Hyprland 上与 KDE 一致（`chrome-127.0.0.1__-Default`），无需改动。

### 已知限制

- 需要 Hyprland 0.53 及以上。更早的版本只有 `windowrulev2` 老语法，未做实测，插件会跳过并说明原因。
- 尚未在**完整 Hyprland 会话**（而非嵌套）下验证桌面入口与图标显示。

## [0.2.0] - 2026-09-20

桌面集成第一次拥有图形配置界面，并换上了自己的图标。

### 新增

- **Web 设置页的「桌面集成」卡片**（`src/settings.js` + `src/client.js`）
  - 宿主半侧注册 settings 命名空间 `linux-desktop`，分层为「schema 默认值 → `config.json` → `settings.yaml` 用户覆盖」，因此 0.1.x 已有的配置文件**继续生效**。
  - 浏览器半侧是手写的 lazy-CJS factory bundle（`dsh.client` + `exports["./client"]`），把卡片注册进 keyed slot `settings.plugin.item` 的 `linux-desktop` 键。不引入构建步骤，与本项目「纯 ESM、零构建」一致。
  - 卡片可编辑 `profileMode` / `browser` / 窗口尺寸 / `autoInstall` / `manageKwinRules` / `terminalAction` / `terminalCommand`，逐字段显示「已覆盖」并提供重置。保存后触发幂等安装，改动立即生效。
  - `host` 与 `port` **刻意不进命名空间**：它们必须与 `dsh web` 实际绑定的地址一致，放进卡片只会制造两份矛盾的真相。
  - 新增运行期依赖 `@deepseek-ai/schemastery`（仅用于注册命名空间）。本地 `link:` 方式安装时 pnpm 不解析被链接包的依赖，因此 `src/settings.js` 还带一条退路：从正在运行的 `dsh` 安装目录里加载它；两条路都不通时安静降级为「没有卡片」，其余功能不受影响。

### 变更

- **桌面集成图标换成 `whale-girl.png`**（`src/assets/whale-girl.png`，512×512 位图）
  - 图标源从矢量改为位图，因此不再安装 `hicolor/scalable` 下的 SVG，改为写入 128 / 256 / 512 三档位图，app_id 别名图标同步。
  - 源尺寸那一档是纯复制，不需要任何外部转换器 —— 即使系统上没有 ImageMagick，`Icon=deepseek-harness` 也一定能解析到；更小的档位才尽力缩放。
  - 卸载时会一并清理 0.1.x 留下的旧 SVG，否则图标主题可能继续命中旧图。
- **精简「后台运行」通知文案**：原文三行解释「为什么不停」，改为两行 —— 服务仍在后台运行，并给出停止命令。

### 修复

- **桌面入口右键的「以终端界面运行 (dsh-tui)」点了没反应**（`src/installer.js`）
  - 原因：动作写的是裸 `dsh`，而桌面入口由桌面环境经 systemd 用户会话启动，那里的 `PATH` 只有 `/usr/local/bin:/usr/bin:...`，**不含** `~/.npm-global/bin`。终端找不到 `dsh`，于是打印 `Warning: Could not find 'dsh', starting '/usr/bin/bash' instead.` 并退化成一个普通 bash。
  - 改为内嵌 `dsh` 的绝对路径（经 `resolveDshBin` 解析，独立 token 位置按 FreeDesktop 规则转义），从此与 `PATH` 无关。实测：旧形式在桌面 `PATH` 下 `command not found`（退出码 127），新形式正常进入 dsh-tui。

- **未启动服务时打开桌面端，侧栏里没有任何工作区，像全新安装**（`src/assets/launcher.sh.tpl`）
  - 原因：启动器拿到「带 token 的地址」就立刻开窗，而插件是**尽早发布**运行时文件的 —— 端口 ~3.0 秒可连、运行时文件 ~4.1 秒就出现，但服务端整棵 Loader 树要晚得多才落定。窗口比工作区 / 会话这些 API 控制器注册完早开了一大截，前端首屏请求拿不到数据就渲染成空侧栏，而且不会自己重试。
  - 自启路径改为**两道闸门**：先等 `dsh web:` 那一行（dsh-web-app 在整棵树加载完之后才打印），再等一次真实的鉴权 API 调用成功（`POST /api/session/list` 返回 `"ok":true`）。两道都过才开窗。
  - 复用别人已跑着的服务时不会白等：用 `log_is_fresh` 判断日志是不是本次产生的，不是就立刻返回。
  - 探测用的 cookie 罐用完即删。launch token 可重复交换（实测连续 3 次都是 303 + 种 cookie），因此探测不会把 token 用掉。

- **设置卡片里「窗口宽度」「窗口高度」不在同一行**（`src/client.js`）
  - 两个值本来属于同一个 `window` 对象，拆成上下两行既浪费纵向空间，也看不出它们是一对。现在合成一行两个等宽单元格，各自保留标签、覆盖徽标与重置按钮，提示与校验信息在整行下方共用。
  - 一并修掉一个布局细节：单元格里的输入框必须显式 `box-sizing:border-box`。`.dsld_input` 有 12px 左右内边距，默认的 `content-box` 下 `width:100%` 会连内边距一起算出去，两个输入框会横向重叠 18px（实测单元格 257px，输入框却渲染成 283px）。

- **关窗通知的第一句不够醒目**（`src/assets/launcher.sh.tpl`）
  - 「dsh web 服务仍在后台运行」改为走**通知标题**并去掉句号，第二句「停止：dsh-desktop stop」原样留在正文。
  - 之所以用标题而不是正文标记：FreeDesktop 通知的正文标记只支持 `<b>/<i>/<u>/<a>/<img>`，**没有字号**；唯一能让一段文字「较大且较粗」的字段就是 summary，KDE Plasma、GNOME、dunst 都会把标题渲染得比正文更大更粗。

- **仓库根目录的 `whale-girl.png` 已删除**，并清理了唯一一处指向它的引用（Dolphin 的 `.directory` 文件夹图标设置）。`.directory` 记录的是本机绝对路径，已加进 `.gitignore`。进包的那份 `src/assets/whale-girl.png`（512×512）不受影响。

### 已知限制

- 设置页卡片需要 `@deepseek-ai/schemastery`。本地 `link:` 安装且找不到该包时，卡片不会出现（桌面集成本身照常工作）。
- 卡片暂不提供安装状态的只读展示（app_id、探测到的浏览器、启动器路径），仍由 `dsh-desktop status` / `doctor` 负责。

## [0.1.0] - 2026-09-20

首个可用版本。

### 新增

- **Cordis 宿主插件行**（`src/index.js`）
  - 通过 `inject: ['connection', 'webServer']` 声明依赖，在 tui / headless 等 profile 中保持 PENDING 不激活。
  - 服务绑定后调用 `ctx.connection.authenticatedUrl()` 取得带 token 的鉴权地址，写入 XDG 运行时目录（`runtime.env` 供 shell 解析，`runtime.json` 供工具读取，权限 0600）。
  - 进程退出时清理运行时状态，且通过 pid 校验避免误删新进程刚写下的状态。
  - 每次 `dsh web` 启动幂等自愈桌面集成；所有副作用包在 try/catch 中，绝不向上抛。

- **桌面启动器**（`src/assets/launcher.sh.tpl`，安装时生成到 `~/.local/bin/dsh-desktop-app`）
  - `flock` 单实例锁，保证只有一个实例管理服务生命周期。
  - 端口探测把 401 也算作「服务在监听」。
  - 未在监听时用 `setsid` 静默拉起 `dsh web --no-open`，并记录「是我启的」。
  - 轮询等待带 token 的地址出现（插件运行时文件优先，启动日志兜底），避免拿着裸地址开窗口导致 401。
  - 用 Chromium `--app` + 独立 `--user-data-dir` 打开纯净窗口，通过等待浏览器进程可靠感知窗口关闭。
  - 仅停止自己启动的服务；复用他人服务时绝不接管。
  - 调试日志中的 token 打码为 `<REDACTED>`。

- **安装器**（`src/installer.js`）
  - 幂等安装：内容未变则不触碰文件。
  - 覆盖前备份为 `*.dsh-backup`（首次备份不被后续覆盖）。
  - 生成 XDG 桌面入口、app_id 别名入口、矢量图标与 128×128 位图图标（含别名）。
  - KWin 窗口规则读写（逐行保留原文、备份、用最大数字 id + 1 避免撞号），并通过 qdbus6/qdbus/dbus-send 通知重载。
  - 刷新 `update-desktop-database` / `kbuildsycoca6` / `gtk-update-icon-cache` 缓存，失败只记警告。
  - `status` 诊断与 `uninstall` 幂等清理。

- **CLI**（`dsh-desktop`）：`install` / `uninstall` / `status` / `doctor` / `config` / `set` / `open` / `stop` / `restart` / `runtime`。
  - 安装时在 `~/.local/bin/dsh-desktop` 写入 CLI 垫片。该 bin 本身位于 profile 的 `node_modules/.bin/`，**不在用户 PATH 上** —— 没有垫片的话 README 里那些命令根本没法照做。
  - `stop` / `restart` 面向「用户明确发起」的场景。启动器只能管自己启的服务（安全底线），所以需要一个由用户主动触发、能停掉任意 dsh web 的入口。它们仍会读 `/proc/<pid>/cmdline` 校验目标确实是 dsh web，不是则拒绝并提示 `--force`。
  - 沙箱模式（`--root` / `DSH_DESKTOP_ROOT`）下禁用「按端口找进程」这条退路 —— 端口不是沙箱化的，否则沙箱里的 stop/restart 会误杀真实环境中正在服务的 dsh web（开发中真实踩到过）。

- **配置**：`~/.config/dsh-desktop/config.json`，支持 host / port / 窗口尺寸 / 浏览器 / profileMode / autoInstall / manageKwinRules 等，非法值回落到默认并给出警告。

- **沙箱模式**：`--root <目录>` 或 `DSH_DESKTOP_ROOT`，重定向全部读写（含 HOME 与所有 XDG_* 路径），便于隔离开发与测试。

- **测试**：`test/smoke.mjs`，61 项零依赖冒烟测试，覆盖 app_id 实测样本回归、Exec 转义、kwinrulesrc 安全读写、配置归一化、探测逻辑、模板渲染、沙箱隔离、运行时状态、install/uninstall 端到端、插件行行为（模拟 Cordis 上下文验证发布/不抛异常/卸载清理）、服务查找与启停（进程身份校验、端口查找、沙箱安全闸、优雅停止）与包清单。

- **发布流水线**
  - `scripts/prepublish-check.mjs`：由 `prepublishOnly` 自动触发，校验必要文件、版本号与 CHANGELOG 一致、`repository.url` 不是占位地址、`cordis.patch.yml` 引用正确的包名、冒烟测试全绿、打包产物包含全部运行时文件。目的是让发布失败在本地，而不是失败在不可逆的 registry 上。
  - `.github/workflows/ci.yml`：push/PR 时在 Node 20/22/24 上跑测试，并在 macOS 上额外验证「非 Linux 平台安静地什么都不做」。

### 实测结论（写入代码注释与文档）

- Chromium 的 Wayland `app_id` 为 `chrome-<hostname>_<pathname 中 / 换 _>-<profile 目录名>`，**与端口无关**。
- 仅有 `StartupWMClass` 不足以让合成器关联图标，还需文件名等于 app_id 的 `.desktop` 与同名图标。
- Chrome 已在运行时 `--app` 会移交既有进程，启动器进程立即退出 —— 这是默认采用独立浏览器配置目录的根本原因。

### 已知限制

- 不支持 Firefox（官方已移除 SSB，无法提供无地址栏窗口）。
- `shared` 模式下，当 Chrome 已运行时无法感知窗口关闭，因此不会自动停止服务（会弹通知说明）。
- Web 设置页内的「桌面集成」卡片尚未实现，目前通过 CLI 管理。
- 仅支持回环地址（受 `dsh web` 自身限制）。
