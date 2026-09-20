# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
