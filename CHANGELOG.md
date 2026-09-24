# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.5.1] - 2026-09-25

把发布流程里剩下的机械步骤也收进命令，并堵上一个发布校验的漏口。

### 修正

- **`prepublishOnly` 现在要求 tag 精确指向 HEAD。** 原先它只查「工作区是否干净」，拦不住「工作区干净、tag 却指向别的提交」—— 而那正是 0.4.1 事故的另一半。手动跑 `npm run check` 时仍只把 tag 当提示：平时 HEAD 上本来就没有 tag，那是正常开发状态，拦下来只会让人不再跑这个命令。

### 新增

- **`npm run release`** —— 一条命令跑完校验（`--release`）→ 从 tag 产出制品 → 打印可直接复制的发布命令。它**故意不发布**：npm 要求浏览器确认，而且「要不要发」是判断，不是机械步骤。
- **`npm run verify:published`** —— 下载 npm 上的包，先确认 registry 上真有这个版本（不存在就当场报错，不去等五分钟），再与 registry 记的 `dist.shasum` 比 sha1，最后与 tag 逐文件比对。这是唯一能真正坐实「发布 == tag」的一步，0.4.1 那次正是靠事后做这件事才发现的。加 `-- --version <版本>` 可以核对任意已发布版本。
- **`.githooks/pre-commit` 与 `npm run hooks:install`** —— 提交前自动跑 `check:fast`（约 5 秒）。README 里的用例数量、隐私指纹、测试是否全绿，都是「改完很容易忘、忘了要到发布那一刻才暴露」的东西。
- 校验新增两个模式：`--fast`（跳过「打包产物完整性」，给钩子用）、`--release`（tag 检查升级为致命项）。
- `tagProblem` 从 `verifyReleaseState` 里抽出来，两个调用方各自决定严重程度。

### 其它

- 新增用例 6 项（152 → 158）。

## [0.5.0] - 2026-09-25

让「日常用的那套」和「开发用的那套」能彻底分家，并给发布加了一道隐私闸门。

### 新增

- **`profile` 配置项**：桌面图标启动哪个 dsh profile，默认 `web`（与 `dsh web` 等价）。启动器与 `dsh-desktop start` 统一改用 `dsh --profile <名字>` 拉起。
- **`devProfile` 配置项**：非空时，桌面入口右键菜单多一个「以开发配置运行」。该动作自动带上三个环境变量 —— `DSH_DESKTOP_PROFILE`（切 profile）、`DSH_DESKTOP_PORT`（`port + 1`）、`DSH_DESKTOP_ROOT`（`$XDG_CACHE_HOME/dsh-desktop-dev` 沙箱）。
- 启动脚本认这三个变量覆盖；设了 `DSH_DESKTOP_ROOT` 时按 `paths.js` 的同一套规则重算运行时目录与日志路径。

### 为什么

`dsh web` 就是 `dsh --profile web`，而图标走的就是它。所以当插件以 `link:` 方式装着的时候，**工作区就是正在跑的插件**：存一下客户端文件它立刻热更进浏览器，写错一行宿主代码重启就起不来 —— 而那正是你唯一能跟 agent 对话的窗口。

分家之后：点图标跑冻结版本，右键跑源码仓库。两者端口不同（`port` 与 `port + 1`），可以同时开着对照。

⚠️ 沙箱不能省：插件的自动安装会写 `~/.local/bin` 与 `~/.local/share/applications`，而这些**不随 profile 分家**。只设 `XDG_*` 也不够 —— `paths.js` 的 `binDir` 写死在 `$HOME/.local/bin`。

### 修正

- **`isDshWebProcess` 原先只认 `web` 子命令。** 拉起命令改成 `--profile <名字>` 后 argv 里不再有 `web`，`dsh-desktop stop` 会认不出自己刚拉起的服务并拒绝停它。现在两种写法都认，且不接受 `--profile` 后面跟的是另一个选项。

### 发布前校验

- **新增第 9 项：隐私指纹。** 扫描全部被跟踪文件，拦截本机家目录、用户名、主机名，以及绝对家目录路径、私钥块、疑似密钥 / JWT / launch token、手机号、邮箱。命中时输出打码，只留文件:行号。
  - 身份指纹在**运行时从环境推导，不写进仓库**（否则闸门自己就成了泄露源），且**只在开发机上生效**：CI 上的身份是临时跑者 `runner`，而仓库里本来就有 "runner" 这个英文词，第一次跑 CI 就误报了 7 处。
  - 因此另有一条**不依赖运行环境**的「绝对家目录路径」规则作为兜底 —— 它在 CI 上照样拦得住 `/home/<某人>/…`。
  - 邮箱放行两类，都不是真实地址：GitHub 的 noreply 提交身份，以及 RFC 2606 保留域 `example.com/net/org`（按标准不可能属于任何人，正是给文档与测试用的）。

### 发布流程

- **制品只从 tag 产出：新增 `scripts/pack-from-tag.mjs`（`npm run pack:tag`）。** 它先校验三件事 —— 会进包的文件都已提交、`HEAD` 被 `v<版本>` 精确指着、该 tag 存在；然后把 tag 的树 `git archive` 到临时目录，**在临时目录里**执行 `npm pack`，最后拿 tgz 里每个文件的字节与导出树逐个比对，任何一处不同都打不出来。理由是 0.4.1 那次事故：`npm publish` 打包的是**工作区**，一处未提交的 `src/client.js` 改动被一起发到了 npm，于是 GitHub 上的 v0.4.1 与 npm 上的 0.4.1 内容不同，而 tag 还打在一个跟该修复毫无关系的提交上。已有的「工作区干净」闸门只能发现脏就拒绝，防不住「提交了却把 tag 打错位置」；从 tag 导出再逐文件核对才是结构性保证。
- **新增 `scripts/snapshot.mjs`（`npm run snapshot -- --profile <名字>`）。** 打包后把该 profile 的插件依赖改成 `file:<tgz 绝对路径>`，再跑 `dsh plugin --profile <名字> install`，让日常那套跑的是「即将发出去的那个制品」而不是工作区；安装失败会把 `package.json` 回滚成改动前的内容。`--profile` 必填且没有默认值。
- 发布流程收敛成四步：`npm run check` → `git tag v<版本>` → `npm run pack:tag` → `npm publish <上一步打印的 tgz>`。
- 「会进包的路径清单」抽成 `scripts/shipped-paths.mjs`，**直接从 `package.json` 的 `files` 推导**，脏树闸门与 `pack:tag` 共用一份。以后往 `files` 里加路径，闸门自动覆盖到。

### 其它

- 新增用例 17 项（135 → 152）。

## [0.4.2] - 2026-09-25

修掉 DSH 0.1.7 一次服务改名导致插件行卡死的问题，并发布到 npm。

### 修正

- **DSH 0.1.7 起 `settingsScope` 服务改名为 `configForms`，旧代码会让插件行永远停在 pending，整个 `dsh web` 起不来。** 症状是启动时报：

  ```
  Failed to load plugins
  web boot: 2 entries did not activate
  dsh-linux-desktop: pending (waiting for service: settingsScope)
  ```

  两处改动：

  1. 客户端插件行的 `inject` 不再声明 `settingsScope` —— 声明一个不存在的服务，这一行就会一直等它。
  2. 改成 `ctx.get('settingsScope')?.bind?.(…) ?? ctx.get('configForms')?.get(…)`，新旧宿主都能工作。

  必须用 `ctx.get(...)` 而不是 `ctx.settingsScope?.bind?.(...)`：Cordis 的上下文代理在读取**未声明**的服务属性时直接抛异常（`cannot get property "<名字>" without inject`），可选链根本来不及生效。

  另补一道兜底：两个服务都没有时安静跳过、不注册卡片，而不是抛出去 —— 客户端插件行抛异常会连累整个 web 界面。

- **0.4.1 发布出去的那份 README 里有两句话不再成立**：「尚未发布到 npm」和「`add dsh-linux-desktop`（按包名）暂不可用」。npm 页面渲染的就是包里的 README，所以这两句只能靠一个新版本才能修掉 —— 这正是「发版前先改文档」的原因。

### 新增

- **npm 发布**：`dsh plugin --profile web add dsh-linux-desktop`。这是最省事的一条安装路径 —— 不克隆仓库，装完即用。已在隔离的 `DSH_HOME` 中实测通过，`dsh` 会自动把这一行注册进 profile 的 `dsh.profile.bundles`。安装一节现在按 **npm → GitHub → 本地检出** 排列，三种来源都实测过。
- `package.json` 补上 `author` / `homepage` / `bugs` 三个字段 —— npm 页面上原本这几项都是空的。
- **发布前校验新增第 8 项：会进包的文件有未提交改动时拒绝发布。** `npm publish` 打包的是**工作区**而不是某个提交 —— 0.4.1 就是这么把一处未提交的本地改动带进包的（发布后逐文件比对才发现包里 `src/client.js` 比 tag 多一个 hunk）。
- 冒烟测试新增 4 项，覆盖上面那条服务改名兼容性；用例总数 117 → 121。新增的用例把 `src/client.js` 当浏览器 bundle 真跑一遍（假 `window` + 假 `require`），因此客户端插件行第一次有了测试。

### 实测记录

- 三种来源各自跑通：按包名（走 registry，秒级）、`github:ffyfox/dsh-linux-desktop`（要克隆整个仓库，分钟级）、本地 `link:`。
- 发布过程本身踩了两个坑，记在这里以免下次再踩：
  - `NODE_OPTIONS=--use-env-proxy`（Node 26 的内建代理）会让 npm 的 fetch 直接失败 —— 表现为 `npm login` 卡在 `web login before first POST` 一动不动。
  - 本机 `~/.npmrc` 的默认 registry 是 `registry.npmmirror.com`（只读镜像），发布必须显式加 `--registry=https://registry.npmjs.org`。

## [0.4.1] - 2026-09-23

仓库转为公开，顺带修正文档里一个早就过期的数字。

### 新增

- **公开安装方式**：`dsh plugin --profile web add github:ffyfox/dsh-linux-desktop`。这是本插件第一个不需要克隆仓库的安装方式，也是社区通用的装法。已在隔离的 `DSH_HOME` 中实测通过 —— `dsh` 会自动把这一行注册进 profile 的 `dsh.profile.bundles`，不需要手工编辑 `package.json`。README 同时给出了锁定版本的写法（`#v0.4.1`）。

### 修正

- **README 里声明的测试数量早就过期了**。两个 README 都写着「72 项」/「72 checks」，实际是 116 项。拿各 tag 逐个对：v0.1.0 写 61（当时对）、v0.2.0 写 72（当时对）、v0.3.0 写 72（实际 94）、v0.4.0 写 72（实际 116）。
- **给发布前校验加了第 7 节的一条闸**：不再靠人记得改，而是从冒烟测试的真实输出里读出「用例共 N 项」，再核对两个 README 里声明的数量 —— 不一致、或故意不写数量，都阻塞发布（只在 Linux 上核对，其它平台会跳过依赖 Linux 的用例）。

  这道闸第一次跑 CI 就红了，而它顺带暴露的两个问题比数字本身更值得记。**「通过数」根本不该被锚定**：它随宿主机环境变化 —— CI runner 既没有位图缩放工具，也没有全局 dsh，本地通过 116 项而 runner 上只有 115 项。改成锚**用例总数**（跨环境稳定，两边都是 117）之后才成立。

  顺着查出计数本身有个 bug：有一条用例在自己的回调里调 `skipTest`，于是**同时**被记成「通过」和「跳过」，用例总数跟着环境漂移。已在 `test()` 里修掉。另外那条用例写死了 `~/.npm-global/...` 一处路径 —— 那是作者本机的安装位置，对任何别人都必然落空，等于这条用例形同不存在，现已放宽成候选链。

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
