/**
 * 平台 / 桌面环境 / 浏览器探测。
 *
 * 全部函数都是**纯函数 + 可注入 env/PATH**，不依赖真实系统状态，因此可以在
 * 测试里喂任意组合，验证「KDE / GNOME / Hyprland / 无桌面会话」等分支。
 *
 * @module dsh-linux-integration/detect
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 支持的 Chromium 系浏览器，按优先级排列。
 *
 * 只收 Chromium 系是刻意的：只有它提供 `--app=` 无边框应用窗口。Firefox 官方
 * 已移除 SSB（Site Specific Browser），降级成 `--new-window` 会带上地址栏和
 * 标签页，直接违背「界面仅包含 dsh web ui 本身」的要求 —— 所以宁可明确报错，
 * 也不静默降级。
 */
export const CHROMIUM_CANDIDATES = [
  { cmd: 'google-chrome-stable', id: 'chrome', label: 'Google Chrome' },
  { cmd: 'google-chrome', id: 'chrome', label: 'Google Chrome' },
  { cmd: 'chromium', id: 'chromium', label: 'Chromium' },
  { cmd: 'chromium-browser', id: 'chromium', label: 'Chromium' },
  { cmd: 'brave-browser', id: 'brave', label: 'Brave' },
  { cmd: 'brave', id: 'brave', label: 'Brave' },
  { cmd: 'microsoft-edge-stable', id: 'edge', label: 'Microsoft Edge' },
  { cmd: 'microsoft-edge', id: 'edge', label: 'Microsoft Edge' },
  { cmd: 'vivaldi-stable', id: 'vivaldi', label: 'Vivaldi' },
  { cmd: 'vivaldi', id: 'vivaldi', label: 'Vivaldi' },
  { cmd: 'opera', id: 'opera', label: 'Opera' },
]

/**
 * 在不依赖外部命令的前提下实现 `which`。
 *
 * @param {string} name 可执行文件名，或含 `/` 的绝对/相对路径。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} 绝对路径；找不到返回 null。
 */
export function findExecutable(name, env = process.env) {
  if (!name) return null
  if (name.includes('/')) {
    return isExecutableFile(name) ? path.resolve(name) : null
  }
  const pathValue = env.PATH || '/usr/local/bin:/usr/bin:/bin'
  for (const dir of pathValue.split(':')) {
    if (dir.length === 0) continue
    const candidate = path.join(dir, name)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 是否为 Linux。 */
export function isLinux(platform = process.platform) {
  return platform === 'linux'
}

/**
 * 探测图形桌面会话。
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function detectSession(env = process.env) {
  const desktopRaw = env.XDG_CURRENT_DESKTOP || env.XDG_SESSION_DESKTOP || ''
  const desktopNames = desktopRaw
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean)

  const sessionType = (env.XDG_SESSION_TYPE || '').toLowerCase()
  const isWayland = Boolean(env.WAYLAND_DISPLAY) || sessionType === 'wayland'
  const isX11 = Boolean(env.DISPLAY) && !isWayland
  const hasDisplay = isWayland || Boolean(env.DISPLAY)

  return { desktopNames, desktopRaw, sessionType, isWayland, isX11, hasDisplay }
}

/**
 * 把 `XDG_CURRENT_DESKTOP` 归一化成稳定的桌面环境标识。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ id: string, label: string, session: ReturnType<typeof detectSession> }}
 */
export function detectDesktopEnvironment(env = process.env) {
  const session = detectSession(env)
  const joined = session.desktopNames.join(' ').toLowerCase()

  /** @type {Array<[RegExp, string, string]>} */
  const table = [
    [/kde|plasma/, 'kde', 'KDE Plasma'],
    [/gnome|ubuntu/, 'gnome', 'GNOME'],
    [/hyprland/, 'hyprland', 'Hyprland'],
    [/sway/, 'sway', 'Sway'],
    [/xfce/, 'xfce', 'Xfce'],
    [/mate/, 'mate', 'MATE'],
    [/cinnamon/, 'cinnamon', 'Cinnamon'],
    [/lxqt/, 'lxqt', 'LXQt'],
    [/deepin|dde/, 'deepin', 'Deepin'],
    [/budgie/, 'budgie', 'Budgie'],
    [/i3/, 'i3', 'i3'],
    [/river|wayfire|labwc|niri|cosmic/, 'wlroots', 'wlroots 系合成器'],
  ]

  for (const [pattern, id, label] of table) {
    if (pattern.test(joined)) return { id, label, session }
  }
  if (session.hasDisplay) return { id: 'unknown', label: '未知桌面环境', session }
  return { id: 'none', label: '无图形会话', session }
}

/**
 * 列出系统上可用的 Chromium 系浏览器。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{ cmd: string, id: string, label: string, execPath: string }>}
 */
export function detectBrowsers(env = process.env) {
  const found = []
  const seenPaths = new Set()
  for (const candidate of CHROMIUM_CANDIDATES) {
    const execPath = findExecutable(candidate.cmd, env)
    if (!execPath || seenPaths.has(execPath)) continue
    seenPaths.add(execPath)
    found.push({ ...candidate, execPath })
  }
  return found
}

/**
 * 决定用哪个浏览器启动应用窗口。
 *
 * @param {string} [preferred] `auto`、浏览器 id（如 `brave`）、或一个可执行文件路径。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: true, browser: { cmd: string, id: string, label: string, execPath: string } }
 *          | { ok: false, reason: string, available: Array<object> }}
 */
export function resolveBrowser(preferred = 'auto', env = process.env) {
  const available = detectBrowsers(env)

  if (preferred && preferred !== 'auto') {
    // 显式给的绝对/相对路径
    if (preferred.includes('/')) {
      const execPath = findExecutable(preferred, env)
      if (execPath) return { ok: true, browser: { cmd: path.basename(execPath), id: 'custom', label: execPath, execPath } }
      return { ok: false, reason: `配置指定的浏览器不存在或不可执行：${preferred}`, available }
    }
    const match = available.find((b) => b.id === preferred || b.cmd === preferred)
    if (match) return { ok: true, browser: match }
    return {
      ok: false,
      reason: `配置指定的浏览器未安装：${preferred}（可用：${available.map((b) => b.id).join(', ') || '无'}）`,
      available,
    }
  }

  if (available.length === 0) {
    return {
      ok: false,
      reason:
        '未找到任何 Chromium 系浏览器。本插件依赖 Chromium 的 --app 模式提供无地址栏的纯净窗口，' +
        'Firefox 无法做到（官方已移除 SSB）。请安装 google-chrome / chromium / brave / edge 之一。',
      available,
    }
  }
  return { ok: true, browser: available[0] }
}
