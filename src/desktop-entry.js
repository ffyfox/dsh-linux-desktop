/**
 * FreeDesktop 桌面入口（`.desktop`）与 Wayland `app_id` 映射。
 *
 * @module dsh-linux-desktop/desktop-entry
 */

/**
 * 推导 Chromium 在 Wayland 下为 `--app=` 窗口提交的 `app_id`。
 *
 * 这个公式是**实测反推**出来的（KDE KWin `resourceClass` / `desktopFileName`），
 * 不是从文档抄的 —— Chromium 没有公开承诺过它。实测样本：
 *
 * | `--app=` 目标                        | app_id                          |
 * | ------------------------------------ | ------------------------------- |
 * | `http://127.0.0.1/`                  | `chrome-127.0.0.1__-Default`    |
 * | `http://127.0.0.1:3080`              | `chrome-127.0.0.1__-Default`    |
 * | `http://127.0.0.1:3080/foo`          | `chrome-127.0.0.1__foo-Default` |
 * | `http://127.0.0.1:3080/a/b`          | `chrome-127.0.0.1__a_b-Default` |
 * | `http://localhost:3080/`             | `chrome-localhost__-Default`    |
 * | `https://example.com/`               | `chrome-example.com__-Default`  |
 *
 * 归纳出的规则：`chrome-<hostname>_<pathname 中 / 换成 _>-<profile 目录名>`。
 *
 * 两个关键结论：
 * 1. **端口不出现在 app_id 里** —— 所以把端口做成可配置，不会破坏任务栏图标映射。
 * 2. **app_id 只取决于 hostname + pathname**，而 dsh web 永远服务在 `/`，
 *    所以默认情况下恒为 `chrome-127.0.0.1__-Default`。
 *
 * @param {{ host?: string, urlPath?: string, profileName?: string }} [options]
 * @returns {string}
 */
export function chromiumAppId({ host = '127.0.0.1', urlPath = '/', profileName = 'Default' } = {}) {
  const sanitizedPath = urlPath.replaceAll('/', '_')
  return `chrome-${host}_${sanitizedPath}-${profileName}`
}

/**
 * 按 FreeDesktop 规范转义 `Exec=` 里的单个参数。
 *
 * 规范要求：含保留字符的参数要用双引号包裹，且 `"` `` ` `` `$` `\` 需反斜杠转义。
 * 家目录里带空格（例如 `/home/张三/我的项目`）时，不做这一步就会静默启动失败。
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeExecArg(value) {
  if (value.length > 0 && !/[\s"'`$\\<>~|&;*?#()[\]{}]/.test(value)) return value
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$')}"`
}

/**
 * 渲染主桌面入口。
 *
 * @param {object} options
 * @param {ReturnType<import('./config.js').defaultConfig>} options.config
 * @param {string} options.launcherPath 启动脚本绝对路径。
 * @param {string} options.appId Wayland app_id（写入 StartupWMClass）。
 * @param {string} options.iconName 图标名。
 * @param {string} [options.terminalCommand] 非空则附带「以终端界面运行」动作。
 * @param {{ profile: string, port: number, root: string } | null} [options.devAction]
 *        非空则附带「以开发配置运行」动作。三项都会作为环境变量传给启动器。
 * @param {string} [options.version] 生成者版本，写进注释便于排查。
 * @returns {string}
 */
export function renderDesktopEntry({
  config,
  launcherPath,
  appId,
  iconName,
  terminalCommand,
  devAction = null,
  version = '0.0.0',
}) {
  const lines = []
  lines.push('# 由 dsh-linux-desktop 生成，请勿手工编辑 ——')
  lines.push(`# 版本 ${version}；重新生成请执行：dsh-desktop install --force`)
  lines.push('[Desktop Entry]')
  lines.push('Version=1.0')
  lines.push('Type=Application')
  lines.push(`Name=${config.desktopName}`)
  if (config.desktopNameZh && config.desktopNameZh !== config.desktopName) {
    lines.push(`Name[zh_CN]=${config.desktopNameZh}`)
  }
  lines.push('GenericName=AI Agent Framework')
  lines.push('GenericName[zh_CN]=AI 智能体开发框架')
  lines.push('Comment=Local AI coding agent workspace in a dedicated window')
  lines.push('Comment[zh_CN]=在独立窗口中运行本地 AI 智能体工作区')
  lines.push(`Exec=${escapeExecArg(launcherPath)} %U`)
  lines.push(`Icon=${iconName}`)
  lines.push('Terminal=false')
  lines.push('Categories=Development;IDE;')
  lines.push('StartupNotify=true')
  // 没有这一行，KDE/GNOME 就无法把这个无边框窗口关联回本入口，
  // 任务栏会退化成一个黄色的通用 Wayland 占位图标。
  lines.push(`StartupWMClass=${appId}`)
  lines.push('Keywords=dsh;deepseek;harness;agent;ai;coding;深度求索;智能体;')

  const actions = []
  if (terminalCommand) actions.push('TUI')
  if (devAction) actions.push('Dev')
  if (actions.length > 0) lines.push(`Actions=${actions.join(';')};`)

  if (terminalCommand) {
    lines.push('')
    lines.push('[Desktop Action TUI]')
    lines.push('Name=Open in Terminal (dsh-tui)')
    lines.push('Name[zh_CN]=以终端界面运行 (dsh-tui)')
    lines.push(`Exec=${terminalCommand}`)
  }

  if (devAction) {
    // 用 `env` 而不是 shell —— FreeDesktop 的 `Exec=` 不经过 shell，没有 `VAR=x cmd`
    // 这种语法。`env` 本身在 PATH 上，是规范允许的写法。
    //
    // 三个变量缺一不可：
    //   PROFILE  切到开发那套 profile（插件来自源码仓库）
    //   PORT     换端口，否则会命中已在跑的日常那套并被直接复用
    //   ROOT     沙箱，挡住开发版的 autoInstall 覆盖真实的启动器与桌面入口
    const envArgs = [
      `DSH_DESKTOP_PROFILE=${devAction.profile}`,
      `DSH_DESKTOP_PORT=${String(devAction.port)}`,
      `DSH_DESKTOP_ROOT=${devAction.root}`,
    ]
    lines.push('')
    lines.push('[Desktop Action Dev]')
    lines.push(`Name=Run with development profile (${devAction.profile})`)
    lines.push(`Name[zh_CN]=以开发配置运行 (${devAction.profile})`)
    lines.push(`Exec=env ${envArgs.map(escapeExecArg).join(' ')} ${escapeExecArg(launcherPath)}`)
  }

  return `${lines.join('\n')}\n`
}

/**
 * 别名入口的内容。
 *
 * KDE 与 GNOME 在为窗口找图标时，会先找**文件名等于 app_id** 的 `.desktop`。
 * 所以除了主入口的 `StartupWMClass`，还需要一份同内容的 `chrome-127.0.0.1__-Default.desktop`。
 * 这里直接生成一份完整副本而不是软链接 —— 软链接在部分文件同步工具、Flatpak
 * 门户和 `~/.local/share` 被 rsync 到别的机器时容易断掉。
 *
 * @param {string} mainEntryContent 主入口的完整内容。
 * @returns {string}
 */
export function renderAliasEntry(mainEntryContent) {
  return mainEntryContent.replace(
    '# 由 dsh-linux-desktop 生成，请勿手工编辑 ——',
    '# 由 dsh-linux-desktop 生成，请勿手工编辑 ——\n# 这是 Wayland app_id 别名入口，内容与 dsh.desktop 完全一致。',
  )
}

/** 别名 `.desktop` 的文件名。 */
export function aliasEntryFilename(appId) {
  return `${appId}.desktop`
}

/** 别名图标文件名（不含扩展名），即 app_id 本身。 */
export function aliasIconName(appId) {
  return appId
}
