/**
 * 配置的默认值、读取、校验与写回。
 *
 * 配置只有一个来源：`$XDG_CONFIG_HOME/dsh-desktop/config.json`。CLI 和 dsh web
 * 里的宿主插件都读同一个文件，所以「改一次，两处生效」，不存在两份真相。
 *
 * @module dsh-linux-desktop/config
 */

import fs from 'node:fs'
import path from 'node:path'

/** 当前配置结构版本，将来做迁移时用得上。 */
export const CONFIG_VERSION = 1

/**
 * 默认配置。
 *
 * `port: 3080` 与 `dsh web` 的出厂默认一致；`window` 沿用已在 KDE + Wayland +
 * 200% 缩放下验证舒适的 1200x750。
 */
export function defaultConfig() {
  return {
    configVersion: CONFIG_VERSION,

    /** dsh web 绑定的主机。只支持回环地址（dsh 自身的限制）。 */
    host: '127.0.0.1',
    /** dsh web 监听的端口。 */
    port: 3080,

    /** 独立窗口的初始尺寸（逻辑像素）。 */
    window: { width: 1200, height: 750 },

    /**
     * 使用哪个 Chromium 系浏览器：`auto`（自动探测优先级最高者）、
     * 浏览器 id（chrome/chromium/brave/edge/vivaldi/opera）、或一个可执行文件绝对路径。
     */
    browser: 'auto',

    /**
     * `dedicated`：使用独立浏览器配置目录 —— 进程与窗口同生共死，因此「关闭窗口」
     * 可以被可靠观测，跨 DE/WM 通用。代价是独立的 cookie 罐（首次靠 token 地址登录）。
     * `shared`：复用你的默认浏览器配置（共享登录态，零额外进程），但 Chrome 已在
     * 运行时新窗口会「移交」给既有进程，启动器无法感知窗口何时关闭，此模式下不自动停服务。
     */
    profileMode: 'dedicated',

    /** 是否在 dsh web 启动时幂等地安装/自愈桌面集成。 */
    autoInstall: true,

    /** 是否托管 KWin 窗口规则（仅 KDE Plasma 生效）。 */
    manageKwinRules: true,

    /**
     * 是否托管 Hyprland 窗口规则（仅 Hyprland 生效）。
     *
     * 默认 **关闭**，与 KDE 相反 —— 这是刻意的：Hyprland 是平铺合成器，用户
     * 选它就是要平铺。实测在平铺下窗口会铺满工作区，浏览器传的 `--window-size`
     * 和我们的 `size` 规则都会被忽略；要兑现上面那两个宽高，必须强制窗口浮动。
     * 与其擅自改掉别人的窗口行为，不如默认什么都不写，让想要的人自己打开。
     */
    manageHyprlandRules: false,

    /** 桌面入口显示名。 */
    desktopName: 'DeepSeek Harness',
    /** 桌面入口的中文名（zh_CN 语境下覆盖 desktopName）。 */
    desktopNameZh: 'DeepSeek Harness',

    /** 是否在桌面入口里附带「以终端界面运行」右键动作。 */
    terminalAction: true,
    /** 该动作使用的终端命令。留空则安装时自动探测。 */
    terminalCommand: '',
  }
}

/** 需要保留的顶层键，用于剔除陈旧字段。 */
const KNOWN_KEYS = Object.keys(defaultConfig())

/**
 * 把任意输入归一化成合法配置，非法值回落到默认值。
 *
 * @param {unknown} raw
 * @returns {{ config: ReturnType<typeof defaultConfig>, warnings: string[] }}
 */
export function normalizeConfig(raw) {
  const defaults = defaultConfig()
  const warnings = []
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('配置文件不是一个 JSON 对象，已整体回落到默认配置。')
  }

  const config = { ...defaults }

  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.includes(key)) warnings.push(`忽略未知配置项：${key}`)
  }

  if (typeof input.host === 'string' && input.host.trim().length > 0) {
    config.host = input.host.trim()
  } else if (input.host !== undefined) {
    warnings.push('host 必须是非空字符串，已使用默认值 127.0.0.1')
  }

  config.port = normalizePort(input.port, defaults.port, warnings, 'port')

  if (input.window && typeof input.window === 'object') {
    config.window = {
      width: normalizeDimension(input.window.width, defaults.window.width, warnings, 'window.width'),
      height: normalizeDimension(input.window.height, defaults.window.height, warnings, 'window.height'),
    }
  } else if (input.window !== undefined) {
    warnings.push('window 必须是 { width, height } 对象，已使用默认值')
  }

  if (typeof input.browser === 'string' && input.browser.trim().length > 0) {
    config.browser = input.browser.trim()
  } else if (input.browser !== undefined) {
    warnings.push('browser 必须是非空字符串，已使用 auto')
  }

  if (input.profileMode === 'dedicated' || input.profileMode === 'shared') {
    config.profileMode = input.profileMode
  } else if (input.profileMode !== undefined) {
    warnings.push("profileMode 只能是 'dedicated' 或 'shared'，已使用 dedicated")
  }

  for (const flag of ['autoInstall', 'manageKwinRules', 'manageHyprlandRules', 'terminalAction']) {
    if (typeof input[flag] === 'boolean') config[flag] = input[flag]
    else if (input[flag] !== undefined) warnings.push(`${flag} 必须是布尔值，已使用默认值 ${defaults[flag]}`)
  }

  for (const key of ['desktopName', 'desktopNameZh', 'terminalCommand']) {
    if (typeof input[key] === 'string') config[key] = input[key]
    else if (input[key] !== undefined) warnings.push(`${key} 必须是字符串，已使用默认值`)
  }

  return { config, warnings }
}

function normalizePort(value, fallback, warnings, label) {
  if (value === undefined) return fallback
  const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    warnings.push(`${label} 必须是 1-65535 的整数，已使用默认值 ${fallback}`)
    return fallback
  }
  return num
}

function normalizeDimension(value, fallback, warnings, label) {
  if (value === undefined) return fallback
  const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isInteger(num) || num < 320 || num > 20000) {
    warnings.push(`${label} 必须是 320-20000 的整数，已使用默认值 ${fallback}`)
    return fallback
  }
  return num
}

/**
 * 读取配置。文件不存在或损坏都**不会抛错** —— 一律回落到默认值并给出警告，
 * 因为一个坏掉的配置文件绝不该让 dsh web 起不来。
 *
 * @param {ReturnType<import('./paths.js').resolvePaths>} paths
 * @returns {{ config: ReturnType<typeof defaultConfig>, warnings: string[], exists: boolean }}
 */
export function readConfig(paths) {
  let text
  try {
    text = fs.readFileSync(paths.configFile, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { config: defaultConfig(), warnings: [], exists: false }
    return { config: defaultConfig(), warnings: [`读取配置失败：${error.message}`], exists: false }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      config: defaultConfig(),
      warnings: [`配置文件不是合法 JSON（${error.message}），已回落到默认配置。`],
      exists: true,
    }
  }

  const { config, warnings } = normalizeConfig(parsed)
  return { config, warnings, exists: true }
}

/**
 * 写入配置（原子写：先写临时文件再 rename）。
 *
 * @param {ReturnType<import('./paths.js').resolvePaths>} paths
 * @param {ReturnType<typeof defaultConfig>} config
 */
export function writeConfig(paths, config) {
  fs.mkdirSync(paths.configDir, { recursive: true, mode: 0o700 })
  const tmp = `${paths.configFile}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, paths.configFile)
}

/** 把 `{ width, height }` 渲染成浏览器 `--window-size` 参数值。 */
export function windowSizeArg(config) {
  return `${config.window.width},${config.window.height}`
}

/**
 * 客户端应该连接的主机名。
 *
 * `dsh web` 的 `--host` 只接受 `127.0.0.1` 与 `0.0.0.0`；绑到 `0.0.0.0` 时
 * 浏览器仍然应该走回环地址去连。而且 Chromium 的 Wayland `app_id` 是由
 * **连接用的 hostname** 推导的，所以启动器、app_id、桌面入口三处必须用同一个
 * 归一化后的值，否则任务栏图标会对不上。
 *
 * @param {{ host: string }} config
 * @returns {string}
 */
export function connectHost(config) {
  const host = String(config.host ?? '').trim()
  if (host === '' || host === '0.0.0.0' || host === '::' || host === '*') return '127.0.0.1'
  return host
}

/** 保证配置目录存在。 */
export function ensureConfigDir(paths) {
  fs.mkdirSync(paths.configDir, { recursive: true, mode: 0o700 })
  return path.dirname(paths.configFile) === paths.configDir
}
