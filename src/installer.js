/**
 * 桌面集成的安装 / 卸载 / 诊断。
 *
 * 设计原则：
 * 1. **幂等**：反复执行结果一致，内容没变就不碰文件（避免每次 dsh web 启动都
 *    重写桌面项、触发 KDE 重建菜单缓存）。
 * 2. **可回退**：覆盖任何已有文件之前先备份成 `*.dsh-backup`（只备份第一次，
 *    不覆盖已有备份），这样「插件接管手工原型」是可逆的。
 * 3. **不抛错**：所有副作用都包在 try/catch 里，单步失败只记进报告，绝不把
 *    dsh web 的启动拖挂。
 *
 * @module dsh-linux-desktop/installer
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { connectHost, defaultConfig, normalizeConfig, readConfig, writeConfig } from './config.js'
import { detectDesktopEnvironment, findExecutable, isLinux, resolveBrowser } from './detect.js'
import { aliasEntryFilename, aliasIconName, chromiumAppId, escapeExecArg, renderAliasEntry, renderDesktopEntry } from './desktop-entry.js'
import { inspectGnomeWindowSize } from './gnome.js'
import { reconfigureKwin, removeSizeRule, upsertSizeRule } from './kwin.js'
import {
  MIN_MODERN_VERSION,
  buildRuleBlock,
  detectConfigFile,
  detectHyprlandVersion,
  hasWindowRule,
  reloadHyprland,
  removeWindowRule,
  upsertWindowRule,
  verifyRuleBlock,
  versionAtLeast,
} from './hyprland.js'
import { ICON_NAME, ICON_SIZES, iconDirFor, iconFileFor, resolvePaths } from './paths.js'
import { inspectRuntime } from './runtime.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.join(HERE, 'assets')

/** 本插件版本，从 package.json 读取，避免两处硬编码不一致。 */
export function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 写一个「由本插件托管」的文件：内容相同则不动，不同则先备份再原子替换。
 *
 * @returns {{ status: 'created' | 'updated' | 'unchanged', backup: string | null }}
 */
function writeManagedFile(file, content, { mode = 0o644 } = {}) {
  let existing = null
  let isSymlink = false
  try {
    isSymlink = fs.lstatSync(file).isSymbolicLink()
    if (!isSymlink) existing = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }

  if (!isSymlink && existing === content) return { status: 'unchanged', backup: null }

  fs.mkdirSync(path.dirname(file), { recursive: true })

  let backup = null
  if (isSymlink || existing !== null) {
    backup = `${file}.dsh-backup`
    if (!fs.existsSync(backup)) {
      if (isSymlink) {
        // 记录软链指向，便于人工还原。
        const target = fs.readlinkSync(file)
        fs.writeFileSync(backup, `# 原文件是一个指向以下目标的软链接\n${target}\n`, { mode: 0o644 })
      } else {
        fs.copyFileSync(file, backup)
      }
    }
  }

  // 软链接必须先删掉：往软链写入会改写它指向的文件。
  if (isSymlink) fs.rmSync(file)

  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content, { mode })
  fs.renameSync(tmp, file)
  return { status: isSymlink || existing !== null ? 'updated' : 'created', backup }
}

/**
 * 把位图图标缩放到指定边长；没有任何转换器就返回 null。
 *
 * 源图是位图，所以能用的转换器和矢量的那套不同（rsvg-convert / Inkscape 只
 * 吃 SVG）。调用方只对**非源尺寸**的档位调用它 —— 源尺寸那一档直接复制。
 *
 * @param {string} srcFile 源 PNG。
 * @param {string} pngFile 目标 PNG。
 * @param {number} size 目标边长（像素）。
 * @returns {string | null} 实际用上的转换器名。
 */
function resizePng(srcFile, pngFile, size) {
  const box = `${size}x${size}`
  const attempts = [
    ['magick', [srcFile, '-background', 'none', '-resize', box, pngFile]],
    ['convert', [srcFile, '-background', 'none', '-resize', box, pngFile]],
    ['ffmpeg', ['-y', '-loglevel', 'error', '-i', srcFile, '-vf', `scale=${size}:${size}`, pngFile]],
  ]
  // 转换器不会自己创建输出目录；hicolor/128x128/apps 在干净系统上通常不存在。
  fs.mkdirSync(path.dirname(pngFile), { recursive: true })
  for (const [cmd, args] of attempts) {
    if (!findExecutable(cmd)) continue
    try {
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 20000 })
      if (fs.existsSync(pngFile)) return cmd
    } catch {
      // 换下一个转换器。
    }
  }
  return null
}

/** 文件修改时间（毫秒）；不存在返回 0（用于判断资源是否比产物新）。 */
function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** 两个文件内容是否相同（大小 + 字节比较）。 */
function sameFile(a, b) {
  try {
    const bufA = fs.readFileSync(a)
    const bufB = fs.readFileSync(b)
    return bufA.length === bufB.length && bufA.equals(bufB)
  } catch {
    return false
  }
}

/** 跑一个「刷新缓存」命令，失败只记 warning。 */
function runRefresh(cmd, args, warnings) {
  if (!findExecutable(cmd)) return false
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 20000 })
    return true
  } catch (error) {
    warnings.push(`${cmd} 执行失败（不影响功能）：${error.message}`)
    return false
  }
}

/** 解析 `dsh` 可执行文件路径。 */
export function resolveDshBin(env = process.env) {
  const direct = findExecutable('dsh', env)
  if (direct) return direct

  // 退路：本插件运行在 dsh 进程内部，argv[1] 通常就是 dsh 的入口脚本，
  // 从 `<prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` 反推出 `<prefix>/bin/dsh`。
  const argv1 = process.argv[1]
  if (argv1 && argv1.includes(`${path.sep}@deepseek-ai${path.sep}dsh${path.sep}`)) {
    const prefix = argv1.slice(0, argv1.indexOf(`${path.sep}lib${path.sep}node_modules${path.sep}`))
    const shim = path.join(prefix, 'bin', 'dsh')
    if (fs.existsSync(shim)) return shim
  }
  return null
}

/**
 * 探测一个可用的终端命令，用于桌面入口的右键动作。
 *
 * **必须用 `dsh` 的绝对路径，不能只写 `dsh`。** 桌面入口是由桌面环境
 * （KDE/GNOME）通过 systemd 用户会话启动的，那里的 `PATH` 只有
 * `/usr/local/bin:/usr/bin:...` 这类系统目录 —— **不含** `~/.npm-global/bin`、
 * `~/.local/bin` 等用户级 bin。只写 `dsh` 时终端找不到它，会打印
 * `Warning: Could not find 'dsh', starting '/usr/bin/bash' instead.` 并退化成一个
 * 普通 bash，用户看到的就是「右键菜单点了没反应」。
 *
 * 绝对路径与 `PATH` 无关，因此在任何桌面会话里都能启动。
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string|null} dshBin `dsh` 的绝对路径；为 null 时退回裸 `dsh`（会带警告）。
 * @returns {string}
 */
function detectTerminalCommand(env, dshBin) {
  const bin = dshBin || 'dsh'
  // 独立成 token 的位置用 escapeExecArg（含空格的家目录路径需要引号）；
  // xfce4-terminal 的 -e 本身就要一层双引号，所以那里直接放原值。
  const quoted = escapeExecArg(bin)
  const candidates = [
    ['konsole', (t) => `${t} -e ${quoted} --profile dsh-tui`],
    ['gnome-terminal', (t) => `${t} -- ${quoted} --profile dsh-tui`],
    ['xfce4-terminal', (t) => `${t} -e "${bin} --profile dsh-tui"`],
    ['kitty', (t) => `${t} ${quoted} --profile dsh-tui`],
    ['alacritty', (t) => `${t} -e ${quoted} --profile dsh-tui`],
    ['wezterm', (t) => `${t} start -- ${quoted} --profile dsh-tui`],
    ['xterm', (t) => `${t} -e ${quoted} --profile dsh-tui`],
  ]
  for (const [cmd, build] of candidates) {
    const found = findExecutable(cmd, env)
    if (found) return build(found)
  }
  return ''
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * 安装（或自愈）桌面集成。
 *
 * @param {object} [options]
 * @param {ReturnType<typeof resolvePaths>} [options.paths]
 * @param {object} [options.config] 显式配置；省略则从磁盘读。
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {boolean} [options.force] 忽略「已是最新」的短路，强制重写。
 * @param {boolean} [options.quiet] 不打印日志。
 * @returns {{
 *   ok: boolean,
 *   steps: Array<{ id: string, status: string, detail: string }>,
 *   warnings: string[],
 *   changed: boolean,
 *   appId: string,
 *   browser: object | null,
 *   paths: ReturnType<typeof resolvePaths>,
 * }}
 */
export function install(options = {}) {
  const env = options.env ?? process.env
  const paths = options.paths ?? resolvePaths(env)
  const version = pluginVersion()
  // 注入点：测试里替换掉对 Hyprland / hyprctl 的真实调用。
  const exec = options.exec ?? execFileSync

  /** @type {Array<{ id: string, status: string, detail: string }>} */
  const steps = []
  /** @type {string[]} */
  const warnings = []
  const record = (id, status, detail = '') => steps.push({ id, status, detail })

  const platformOk = isLinux()
  const desktop = detectDesktopEnvironment(env)

  // ---- 配置 -------------------------------------------------------------
  let config
  if (options.config) {
    config = normalizeConfig(options.config).config
  } else {
    const read = readConfig(paths)
    config = read.config
    warnings.push(...read.warnings)
  }

  // 无论配置是调用方传进来的还是从磁盘读的，都要保证磁盘上存在一份**可编辑**的
  // 配置文件 —— 否则用户装完之后根本不知道去哪儿改端口和窗口尺寸。
  if (!fs.existsSync(paths.configFile)) {
    try {
      writeConfig(paths, config)
      record('config', 'created', paths.configFile)
    } catch (error) {
      record('config', 'failed', error.message)
    }
  } else {
    record('config', 'unchanged', paths.configFile)
  }

  // ---- 浏览器 -----------------------------------------------------------
  const browserResult = resolveBrowser(config.browser, env)
  if (!browserResult.ok) {
    record('browser', 'failed', browserResult.reason)
    return { ok: false, steps, warnings, changed: false, appId: '', browser: null, paths }
  }
  const browser = browserResult.browser
  record('browser', 'ok', `${browser.label} (${browser.execPath})`)

  // ---- dsh 可执行文件 ---------------------------------------------------
  const dshBin = resolveDshBin(env)
  if (!dshBin) {
    record('dsh-bin', 'failed', '找不到 dsh 可执行文件，请确认 dsh 已安装并在 PATH 中。')
    return { ok: false, steps, warnings, changed: false, appId: '', browser, paths }
  }
  record('dsh-bin', 'ok', dshBin)

  // ---- app_id -----------------------------------------------------------
  // 必须用「客户端实际连接的主机名」，因为 Chromium 的 app_id 由它推导。
  const host = connectHost(config)
  const appId = chromiumAppId({ host, urlPath: '/' })
  record('app-id', 'ok', appId)

  // ---- 图标 -------------------------------------------------------------
  // 图标源是位图（`src/assets/whale-girl.png`，512x512）。位图没有「一个文件
  // 任意缩放」这回事，所以按 hicolor 的尺寸目录逐个写入：源尺寸那一档直接复制
  // （不需要任何外部转换器，保证 Icon= 一定能解析到），其余档位尽力缩放。
  const iconSource = path.join(ASSETS_DIR, 'whale-girl.png')
  if (!fs.existsSync(iconSource)) {
    record('icon', 'failed', `内置图标资源缺失：${iconSource}`)
    return { ok: false, steps, warnings, changed: false, appId, browser, paths }
  }
  const sourceSize = Math.max(...ICON_SIZES)

  try {
    let installedSizes = 0
    for (const size of ICON_SIZES) {
      const target = iconFileFor(paths.iconThemeDir, size)
      const aliasTarget = path.join(iconDirFor(paths.iconThemeDir, size), `${aliasIconName(appId)}.png`)

      if (size === sourceSize) {
        // 源尺寸：字节级复制，内容相同则不动（保持幂等）。
        if (fs.existsSync(target) && sameFile(iconSource, target)) {
          record(`icon-${String(size)}`, 'unchanged', target)
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.copyFileSync(iconSource, target)
          record(`icon-${String(size)}`, 'created', `${target}（源图直接复制）`)
        }
      } else if (fs.existsSync(target) && mtimeMs(target) >= mtimeMs(iconSource)) {
        record(`icon-${String(size)}`, 'unchanged', target)
      } else {
        const converted = resizePng(iconSource, target, size)
        if (converted) record(`icon-${String(size)}`, 'created', `${target}（由 ${converted} 缩放）`)
        else record(`icon-${String(size)}`, 'skipped', `未找到位图缩放工具（ImageMagick / ffmpeg），跳过 ${String(size)}x${String(size)} 档`)
      }

      if (fs.existsSync(target)) {
        installedSizes += 1
        // app_id 别名图标：合成器找不到它就会退回黄色通用 Wayland 占位图标。
        if (fs.existsSync(aliasTarget) && sameFile(target, aliasTarget)) {
          record(`icon-${String(size)}-alias`, 'unchanged', aliasTarget)
        } else {
          fs.mkdirSync(path.dirname(aliasTarget), { recursive: true })
          fs.copyFileSync(target, aliasTarget)
          record(`icon-${String(size)}-alias`, 'created', aliasTarget)
        }
      }
    }
    if (installedSizes === 0) record('icon', 'failed', '没有任何尺寸档位安装成功')

    // 迁移：0.1.x 在 scalable/apps 下装过矢量图标。图标主题会优先命中矢量图，
    // 留着它就会让新图标永远不生效，所以升级时主动清掉（连同 app_id 别名）。
    const legacyDir = path.join(paths.iconThemeDir, 'scalable', 'apps')
    for (const [id, file] of [
      ['icon-svg-legacy', path.join(legacyDir, `${ICON_NAME}.svg`)],
      ['icon-svg-legacy-alias', path.join(legacyDir, `${aliasIconName(appId)}.svg`)],
    ]) {
      if (!fs.existsSync(file)) continue
      try {
        fs.rmSync(file)
        record(id, 'removed', file)
      } catch (error) {
        record(id, 'failed', `${file}：${error.message}`)
      }
    }
  } catch (error) {
    record('icon', 'failed', error.message)
  }

  // ---- 启动脚本 ---------------------------------------------------------
  const templatePath = path.join(ASSETS_DIR, 'launcher.sh.tpl')
  let launcherWritten = false
  try {
    const template = fs.readFileSync(templatePath, 'utf8')
    const extraPath = [path.dirname(dshBin), path.dirname(process.execPath)].join(':')
    const script = renderTemplate(template, {
      VERSION: version,
      CONFIG_FILE: paths.configFile,
      HOST: host,
      PORT: String(config.port),
      WINDOW_SIZE: `${config.window.width},${config.window.height}`,
      BROWSER: browser.execPath,
      BROWSER_LABEL: browser.label,
      PROFILE_MODE: config.profileMode,
      PROFILE: config.profile,
      PROFILE_DIR: paths.chromeProfileDir,
      RUNTIME_DIR: paths.runtimeDir,
      LOG_FILE: paths.logFile,
      DSH_BIN: dshBin,
      EXTRA_PATH: extraPath,
    })
    const result = writeManagedFile(paths.launcherFile, script, { mode: 0o755 })
    fs.chmodSync(paths.launcherFile, 0o755)
    record('launcher', result.status, paths.launcherFile)
    launcherWritten = true
  } catch (error) {
    record('launcher', 'failed', error.message)
  }

  // ---- CLI 垫片 ---------------------------------------------------------
  // `dsh-desktop` 装完在 profile 的 node_modules/.bin 里，不在用户 PATH 上。
  // 写一个把绝对路径固化的垫片到 ~/.local/bin，命令才真的能用。
  try {
    const shim = [
      '#!/usr/bin/env bash',
      '# 由 dsh-linux-desktop 生成，请勿手工编辑。',
      `# 重新生成请执行：dsh-desktop install --force`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(HERE, '..', 'bin', 'dsh-desktop.js'))} "$@"`,
      '',
    ].join('\n')
    const result = writeManagedFile(paths.cliShimFile, shim, { mode: 0o755 })
    fs.chmodSync(paths.cliShimFile, 0o755)
    record('cli-shim', result.status, paths.cliShimFile)
  } catch (error) {
    record('cli-shim', 'failed', error.message)
    warnings.push(`CLI 垫片写入失败：${error.message}`)
  }

  // ---- 桌面入口 ---------------------------------------------------------
  if (launcherWritten) {
    // 显式配置的 terminalCommand 由用户负责（原样写入）；
    // 自动探测的则必须内嵌 dsh 绝对路径 —— 见 detectTerminalCommand 的注释。
    const terminalCommand = config.terminalAction
      ? config.terminalCommand || detectTerminalCommand(env, dshBin)
      : ''
    if (config.terminalAction && !terminalCommand) {
      warnings.push('未找到可用终端，桌面入口的「以终端界面运行」动作已省略。')
    } else if (config.terminalAction && !config.terminalCommand && !dshBin) {
      warnings.push('未能解析 dsh 的绝对路径，右键动作里的 dsh 依赖桌面会话的 PATH，可能无法启动。')
    }

    // 「以开发配置运行」动作。只在配置了 devProfile 时才生成。
    //
    // 端口取 `port + 1`：两套必须落在不同端口上，否则第二套的 server_up 探测会
    // 命中第一套并直接复用它 —— 右键点开看到的还是日常那套，动作等于失效。
    const devAction = config.devProfile
      ? {
          profile: config.devProfile,
          port: config.port >= 65535 ? config.port - 1 : config.port + 1,
          root: paths.devRootDir,
        }
      : null

    const entryContent = renderDesktopEntry({
      config,
      launcherPath: paths.launcherFile,
      appId,
      iconName: ICON_NAME,
      terminalCommand,
      devAction,
      version,
    })

    try {
      const main = writeManagedFile(paths.desktopEntryFile, entryContent)
      record('desktop-entry', main.status, paths.desktopEntryFile)

      const aliasFile = path.join(paths.applicationsDir, aliasEntryFilename(appId))
      const alias = writeManagedFile(aliasFile, renderAliasEntry(entryContent))
      record('desktop-entry-alias', alias.status, aliasFile)
    } catch (error) {
      record('desktop-entry', 'failed', error.message)
    }
  }

  // ---- KWin 规则（仅 KDE） ----------------------------------------------
  if (config.manageKwinRules && desktop.id === 'kde') {
    try {
      const result = upsertSizeRule({ file: paths.kwinRulesFile, appId, size: config.window })
      record(
        'kwin-rule',
        result.changed ? 'updated' : 'unchanged',
        `规则 [${result.ruleId}] ${config.window.width}x${config.window.height}${result.backupPath ? `（备份：${result.backupPath}）` : ''}`,
      )
      if (result.changed) {
        const reload = reconfigureKwin()
        record('kwin-reload', reload.ok ? 'ok' : 'skipped', reload.ok ? `已通过 ${reload.via} 通知重载` : '未找到 qdbus/dbus-send，规则将在下次登录生效')
      }
    } catch (error) {
      record('kwin-rule', 'failed', error.message)
      warnings.push(`KWin 规则写入失败：${error.message}`)
    }
  } else if (config.manageKwinRules) {
    record('kwin-rule', 'skipped', `当前桌面环境是 ${desktop.label}，不适用 KWin 规则`)
  } else {
    record('kwin-rule', 'skipped', '配置中已关闭 manageKwinRules')
  }

  // ---- Hyprland 窗口规则（仅 Hyprland） ----------------------------------
  applyHyprlandRule({ config, desktop, paths, appId, env, exec, record, warnings })

  // ---- GNOME 尺寸现实检查（仅 GNOME，**只读**） --------------------------
  // GNOME 既没有窗口规则配置文件也没有对应的 dconf 键，所以这里不写任何东西。
  // 它本来就遵循 --window-size，唯一的例外是 auto-maximize 会在大窗口上接管。
  if (desktop.id === 'gnome') {
    try {
      const { assessment } = inspectGnomeWindowSize({ env, exec, size: config.window })
      record('gnome-window-size', assessment.level === 'warning' ? 'warning' : 'info', assessment.message)
      // warnings 会进插件启动日志，所以放「动作」而不是重复一遍「发现」。
      if (assessment.advice) warnings.push(assessment.advice)
    } catch (error) {
      record('gnome-window-size', 'failed', error.message)
    }
  }

  // ---- 刷新缓存 ---------------------------------------------------------
  if (!options.quiet) {
    runRefresh('update-desktop-database', [paths.applicationsDir], warnings)
    if (desktop.id === 'kde') runRefresh('kbuildsycoca6', ['--noincremental'], warnings)
    const themeIndex = path.join(paths.iconThemeDir, 'index.theme')
    if (fs.existsSync(themeIndex)) {
      runRefresh('gtk-update-icon-cache', ['-f', '-t', paths.iconThemeDir], warnings)
    }
  }
  record('cache', 'ok', '已刷新桌面数据库 / KDE 菜单缓存')

  if (!platformOk) {
    warnings.push(`当前平台是 ${process.platform}，本插件只对 Linux 有意义。`)
  }

  const changed = steps.some((step) => step.status === 'created' || step.status === 'updated')
  return { ok: true, steps, warnings, changed, appId, browser, paths }
}

/**
 * 写入 Hyprland 窗口规则。
 *
 * 这里的每一步都在贯彻同一条原则：**宁可什么都不写，也绝不写坏用户的配置。**
 * Hyprland 遇到配置错误会直接拒绝启动（`--verify-config` 退出码 1），而用户的
 * 整个桌面都挂在那个配置上。所以下面有足足四道闸：
 *
 *   1. 配置文件不存在 → 跳过（替用户抢先创建会让它失去 Hyprland 自带的默认配置）
 *   2. 版本读不出来 → 跳过
 *   3. 版本低于 0.53 → 跳过（老语法没实测过，不拿用户的配置冒险）
 *   4. `--verify-config` 校验不过 → 跳过
 *
 * 任何一道没过都只记录 + 警告，绝不落盘。
 */
function applyHyprlandRule({ config, desktop, paths, appId, env, exec, record, warnings }) {
  if (!config.manageHyprlandRules) {
    record('hyprland-rule', 'skipped', '配置中已关闭 manageHyprlandRules（Hyprland 默认保持平铺）')
    return
  }
  if (desktop.id !== 'hyprland') {
    record('hyprland-rule', 'skipped', `当前桌面环境是 ${desktop.label}，不适用 Hyprland 规则`)
    return
  }

  try {
    const found = detectConfigFile({ confFile: paths.hyprlandConfFile, luaFile: paths.hyprlandLuaFile })
    if (!found.file) {
      record('hyprland-rule', 'skipped', '尚未生成 Hyprland 配置（先运行一次 Hyprland 再安装），未做任何改动')
      warnings.push('未找到 Hyprland 配置文件，窗口尺寸规则已跳过。请先启动一次 Hyprland 生成默认配置。')
      return
    }

    const ver = detectHyprlandVersion({ env, exec })
    if (!ver.ok) {
      record('hyprland-rule', 'skipped', `无法确定 Hyprland 版本（${ver.reason}），为避免写坏配置已跳过`)
      warnings.push(`无法确定 Hyprland 版本，窗口尺寸规则已跳过：${ver.reason}`)
      return
    }
    if (!versionAtLeast(ver.version, MIN_MODERN_VERSION)) {
      const v = ver.version.join('.')
      record('hyprland-rule', 'skipped', `Hyprland ${v} 低于 ${MIN_MODERN_VERSION.join('.')}，本插件只写 match:class 新语法`)
      warnings.push(`Hyprland ${v} 版本过低，窗口尺寸规则已跳过（需要 ${MIN_MODERN_VERSION.join('.')} 及以上）。`)
      return
    }

    const block = buildRuleBlock({ format: found.format, appId, size: config.window })
    const verify = verifyRuleBlock({ format: found.format, block, env, exec })
    if (!verify.ok) {
      record('hyprland-rule', 'failed', `规则未通过 Hyprland 校验，已放弃写入：${verify.error}`)
      warnings.push(`Hyprland 窗口规则未通过校验，未做任何改动：${verify.error}`)
      return
    }

    const result = upsertWindowRule({ file: found.file, format: found.format, appId, size: config.window })
    record(
      'hyprland-rule',
      result.changed ? 'updated' : 'unchanged',
      `${found.file}（${found.format}）${config.window.width}x${config.window.height}，强制浮动` +
        (result.backupPath ? `（备份：${result.backupPath}）` : ''),
    )
    if (result.changed) {
      const reload = reloadHyprland({ env, exec })
      record(
        'hyprland-reload',
        reload.ok ? 'ok' : 'skipped',
        reload.ok ? '已通过 hyprctl reload 生效' : '不在 Hyprland 会话内或缺少 hyprctl，规则将在下次登录生效',
      )
    }
  } catch (error) {
    record('hyprland-rule', 'failed', error.message)
    warnings.push(`Hyprland 规则写入失败：${error.message}`)
  }
}

/** 极简模板渲染：把 `@@KEY@@` 换成值，并拒绝未替换的占位符。 */
export function renderTemplate(template, values) {
  let output = template
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`@@${key}@@`, String(value))
  }
  const leftover = /@@([A-Z_]+)@@/.exec(output)
  if (leftover) throw new Error(`启动脚本模板存在未替换的占位符：@@${leftover[1]}@@`)
  return output
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

/**
 * 卸载桌面集成，幂等。
 *
 * 删除的都是「本插件托管的」文件；`.dsh-backup` 备份保留，供人工还原。
 *
 * @param {object} [options]
 * @returns {{ ok: boolean, removed: string[], missing: string[], steps: Array<object>, warnings: string[] }}
 */
export function uninstall(options = {}) {
  const env = options.env ?? process.env
  const paths = options.paths ?? resolvePaths(env)
  const steps = []
  const warnings = []
  const removed = []
  const missing = []

  const targets = [
    ['launcher', paths.launcherFile],
    ['cli-shim', paths.cliShimFile],
    ['desktop-entry', paths.desktopEntryFile],
  ]

  // 图标按尺寸档位逐个安装，所以逐个删除。
  for (const size of ICON_SIZES) {
    targets.push([`icon-${String(size)}`, iconFileFor(paths.iconThemeDir, size)])
  }
  // 0.1.x 装的是 scalable/apps 下的矢量图标。升级不会让旧文件自己消失，留着
  // 会让图标主题继续命中旧图，所以卸载时一并清理。
  const legacyIconDir = path.join(paths.iconThemeDir, 'scalable', 'apps')
  targets.push(['icon-svg-legacy', path.join(legacyIconDir, `${ICON_NAME}.svg`)])

  // 别名文件的文件名取决于 app_id，需要从主入口里读回来。
  try {
    const content = fs.readFileSync(paths.desktopEntryFile, 'utf8')
    const match = /^StartupWMClass=(.+)$/m.exec(content)
    if (match) {
      const appId = match[1].trim()
      targets.push(['desktop-entry-alias', path.join(paths.applicationsDir, `${appId}.desktop`)])
      for (const size of ICON_SIZES) {
        targets.push([`icon-${String(size)}-alias`, path.join(iconDirFor(paths.iconThemeDir, size), `${appId}.png`)])
      }
      targets.push(['icon-svg-legacy-alias', path.join(legacyIconDir, `${appId}.svg`)])
    }
  } catch {
    // 主入口不存在也没关系，说明本来就没装全。
  }

  for (const [id, file] of targets) {
    try {
      fs.rmSync(file)
      removed.push(file)
      steps.push({ id, status: 'removed', detail: file })
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        missing.push(file)
        steps.push({ id, status: 'absent', detail: file })
      } else {
        steps.push({ id, status: 'failed', detail: `${file}：${error.message}` })
        warnings.push(`删除失败：${file}（${error.message}）`)
      }
    }
  }

  // KWin 规则
  const desktop = detectDesktopEnvironment(env)
  try {
    const result = removeSizeRule({ file: paths.kwinRulesFile })
    if (result.changed) {
      removed.push(paths.kwinRulesFile)
      steps.push({ id: 'kwin-rule', status: 'removed', detail: paths.kwinRulesFile })
      reconfigureKwin()
    } else {
      steps.push({ id: 'kwin-rule', status: 'absent', detail: '未找到本插件写入的规则' })
    }
  } catch (error) {
    steps.push({ id: 'kwin-rule', status: 'failed', detail: error.message })
    warnings.push(`KWin 规则清理失败：${error.message}`)
  }

  // Hyprland 规则：只删我们自己那块内联内容，用户其余配置一字不动。
  try {
    const found = detectConfigFile({ confFile: paths.hyprlandConfFile, luaFile: paths.hyprlandLuaFile })
    if (!found.file) {
      steps.push({ id: 'hyprland-rule', status: 'absent', detail: '未找到 Hyprland 配置文件' })
    } else {
      const result = removeWindowRule({ file: found.file, format: found.format })
      if (result.changed) {
        removed.push(found.file)
        steps.push({ id: 'hyprland-rule', status: 'removed', detail: found.file })
        reloadHyprland({ env, exec: options.exec ?? execFileSync })
      } else {
        steps.push({ id: 'hyprland-rule', status: 'absent', detail: '未找到本插件写入的规则' })
      }
    }
  } catch (error) {
    steps.push({ id: 'hyprland-rule', status: 'failed', detail: error.message })
    warnings.push(`Hyprland 规则清理失败：${error.message}`)
  }

  runRefresh('update-desktop-database', [paths.applicationsDir], warnings)
  if (desktop.id === 'kde') runRefresh('kbuildsycoca6', ['--noincremental'], warnings)

  steps.push({ id: 'note', status: 'info', detail: `配置与备份已保留：${paths.configDir}（如需彻底清除请手动删除）` })

  return { ok: true, removed, missing, steps, warnings }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * 诊断当前安装状态，供 `dsh-desktop status` / `doctor` 使用。
 *
 * @param {object} [options]
 * @returns {object} 结构化报告。
 */
export function status(options = {}) {
  const env = options.env ?? process.env
  const paths = options.paths ?? resolvePaths(env)
  // 注入点：测试里替换掉对 gdctl / gsettings 的真实调用。
  const exec = options.exec ?? execFileSync
  const desktop = detectDesktopEnvironment(env)
  const read = readConfig(paths)
  const config = read.config

  const exists = (file) => fs.existsSync(file)
  const readEntry = () => {
    try {
      return fs.readFileSync(paths.desktopEntryFile, 'utf8')
    } catch {
      return null
    }
  }

  const entryContent = readEntry()
  const appIdFromEntry = entryContent ? (/^StartupWMClass=(.+)$/m.exec(entryContent)?.[1]?.trim() ?? null) : null
  const expectedAppId = chromiumAppId({ host: connectHost(config), urlPath: '/' })

  const browserResult = resolveBrowser(config.browser, env)
  const runtime = inspectRuntime(paths, { port: config.port })
  // 端口探测由调用方（CLI）异步完成后传入；未提供时跳过该项诊断。
  const portListening = typeof options.portListening === 'boolean' ? options.portListening : undefined

  const checks = []
  const check = (id, ok, detail, level = 'error') => checks.push({ id, ok, detail, level })

  check('platform', isLinux(), isLinux() ? `Linux（${desktop.label} / ${desktop.session.isWayland ? 'Wayland' : 'X11'}）` : `非 Linux：${process.platform}`)
  check('desktop-session', desktop.id !== 'none', desktop.id === 'none' ? '未检测到图形会话' : `已检测到 ${desktop.label}`, 'warning')
  check('browser', browserResult.ok, browserResult.ok ? `${browserResult.browser.label} → ${browserResult.browser.execPath}` : browserResult.reason)
  check('config', exists(paths.configFile), exists(paths.configFile) ? paths.configFile : '配置文件尚未生成（将在首次安装时创建）', 'warning')
  check('launcher', exists(paths.launcherFile), paths.launcherFile)
  check('cli-shim', exists(paths.cliShimFile), paths.cliShimFile)
  check('desktop-entry', exists(paths.desktopEntryFile), paths.desktopEntryFile)
  const iconFiles = ICON_SIZES.map((size) => iconFileFor(paths.iconThemeDir, size))
  check('icon', iconFiles.some(exists), iconFiles.filter(exists).join(' / ') || iconFiles[0])

  const aliasDesktop = appIdFromEntry ? path.join(paths.applicationsDir, `${appIdFromEntry}.desktop`) : null
  check('desktop-entry-alias', aliasDesktop ? exists(aliasDesktop) : false, aliasDesktop ?? '无法从主入口读出 app_id')
  const aliasIcon = appIdFromEntry
    ? path.join(iconDirFor(paths.iconThemeDir, Math.max(...ICON_SIZES)), `${appIdFromEntry}.png`)
    : null
  check('icon-alias', aliasIcon ? exists(aliasIcon) : false, aliasIcon ?? '无法从主入口读出 app_id')
  check('app-id-match', appIdFromEntry === expectedAppId, `入口内 ${appIdFromEntry ?? '（无）'} / 期望 ${expectedAppId}`, 'warning')

  if (config.manageKwinRules && desktop.id === 'kde') {
    let ruleOk = false
    let ruleDetail = '未找到本插件写入的规则'
    try {
      const text = fs.readFileSync(paths.kwinRulesFile, 'utf8')
      ruleOk = text.includes('DeepSeek Harness Window Rule')
      ruleDetail = ruleOk ? `已在 ${paths.kwinRulesFile} 中注册` : ruleDetail
    } catch {
      ruleDetail = `无法读取 ${paths.kwinRulesFile}`
    }
    check('kwin-rule', ruleOk, ruleDetail, 'warning')
  }

  if (config.manageHyprlandRules && desktop.id === 'hyprland') {
    const found = detectConfigFile({ confFile: paths.hyprlandConfFile, luaFile: paths.hyprlandLuaFile })
    if (!found.file) {
      check('hyprland-rule', false, '尚未生成 Hyprland 配置（先运行一次 Hyprland）', 'warning')
    } else {
      const ok = hasWindowRule({ file: found.file, format: found.format })
      check(
        'hyprland-rule',
        ok,
        ok ? `已在 ${found.file} 中注册（${found.format}）` : `未在 ${found.file} 中找到本插件写入的规则`,
        'warning',
      )
    }
  } else if (desktop.id === 'hyprland') {
    check('hyprland-rule', true, '未托管 Hyprland 规则：窗口遵循平铺布局，宽高设置不生效', 'info')
  }

  // GNOME：没有规则可查，只有「这个尺寸会不会被 auto-maximize 吃掉」这一个现实问题。
  if (desktop.id === 'gnome') {
    try {
      const { assessment } = inspectGnomeWindowSize({ env, exec, size: config.window })
      const bad = assessment.level === 'warning'
      check('gnome-window-size', !bad, assessment.message, bad ? 'warning' : 'info')
    } catch (error) {
      check('gnome-window-size', false, error.message, 'warning')
    }
  }

  check(
    'runtime-state',
    runtime.fresh,
    runtime.fresh
      ? `dsh web 正在服务：端口 ${runtime.record.port}，进程 ${runtime.record.pid}`
      : `没有插件发布的运行时状态（${runtime.reason}）`,
    'info',
  )

  // 运行时文件不存在 ≠ 服务没在跑：服务可能是从终端启动的，或者启动时插件还没装。
  // 所以再直接探一次端口，避免给出误导性的诊断。
  if (!runtime.fresh) {
    const listening = portListening
    if (listening === true) {
      check(
        'port',
        true,
        `端口 ${config.port} 上有服务在监听，但它没有发布运行时状态 —— 启动器将复用它但不会接管其生命周期`,
        'info',
      )
    } else if (listening === false) {
      check('port', true, `端口 ${config.port} 上没有服务在监听（从启动器打开时会自动拉起）`, 'info')
    }
  }

  const errors = checks.filter((c) => !c.ok && c.level === 'error')
  return {
    paths,
    config,
    configWarnings: read.warnings,
    desktop,
    appId: expectedAppId,
    entryAppId: appIdFromEntry,
    browser: browserResult.ok ? browserResult.browser : null,
    browserError: browserResult.ok ? null : browserResult.reason,
    runtime: runtime.fresh ? runtime.record : null,
    runtimeReason: runtime.reason,
    checks,
    healthy: errors.length === 0,
  }
}

export { defaultConfig, readConfig, writeConfig, resolvePaths }
