/**
 * XDG / FreeDesktop 路径解析。
 *
 * 所有路径都在这里集中推导，绝不散落在各处 —— 这样隔离测试只需要设置一个
 * 环境变量 `DSH_DESKTOP_ROOT`，就能把全部读写重定向到沙箱目录，不会碰到
 * 真实用户目录。
 *
 * @module dsh-linux-desktop/paths
 */

import os from 'node:os'
import path from 'node:path'

/** 应用在 XDG 目录里使用的统一目录名。 */
export const APP_DIRNAME = 'dsh-desktop'

/** 图标主题里注册的图标名（不含扩展名）。 */
export const ICON_NAME = 'deepseek-harness'

/** 桌面入口的 basename（不含 .desktop）。 */
export const DESKTOP_ENTRY_ID = 'dsh'

/** 由本插件生成的启动脚本文件名。 */
export const LAUNCHER_FILENAME = 'dsh-desktop-app'

/**
 * 放到 `~/.local/bin` 的 CLI 垫片文件名。
 *
 * 为什么需要它：`dsh-desktop` 这个 bin 装完在 `<profile>/node_modules/.bin/` 里，
 * **不在用户的 PATH 上**。于是「dsh-desktop stop」这种提示就没法照做。垫片把
 * 绝对路径固化下来，让命令真的能用。
 */
export const CLI_SHIM_FILENAME = 'dsh-desktop'

/**
 * 推导全部相关路径。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量来源，默认 `process.env`。
 * @returns {{
 *   home: string, sandboxed: boolean,
 *   configHome: string, dataHome: string, runtimeHome: string,
 *   binDir: string, configDir: string, configFile: string,
 *   applicationsDir: string, desktopEntryFile: string,
 *   iconScalableDir: string, iconScalableFile: string,
 *   iconBitmapDir: string, iconBitmapFile: string,
 *   launcherFile: string,
 *   chromeProfileDir: string,
 *   runtimeDir: string, runtimeEnvFile: string, runtimeJsonFile: string,
 *   logFile: string, backupsDir: string, kwinRulesFile: string,
 * }}
 */
export function resolvePaths(env = process.env) {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : os.homedir()
  const sandbox = env.DSH_DESKTOP_ROOT && env.DSH_DESKTOP_ROOT.length > 0 ? env.DSH_DESKTOP_ROOT : null
  const sandboxed = sandbox !== null

  // 沙箱模式下把 home 也换掉，并**忽略所有 XDG_* 变量** —— 否则一旦用户环境里
  // 设了 XDG_CONFIG_HOME / XDG_DATA_HOME，隔离测试就会写进真实目录。
  const effectiveHome = sandboxed ? path.join(sandbox, 'home') : home

  const xdgConfigHome = !sandboxed && env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : path.join(effectiveHome, '.config')
  const xdgDataHome = !sandboxed && env.XDG_DATA_HOME ? env.XDG_DATA_HOME : path.join(effectiveHome, '.local', 'share')

  // XDG_RUNTIME_DIR 是「本次登录会话」的临时目录，注销即清空 —— 正好适合放
  // 运行时状态（端口 / 进程号 / 带 token 的地址）。沙箱模式或没有该变量时
  // 退回到一个按 uid 隔离的临时目录（沙箱下则退回沙箱内部，保证完全隔离）。
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nobody'
  const xdgRuntimeHome = sandboxed
    ? path.join(sandbox, 'runtime')
    : env.XDG_RUNTIME_DIR
      ? env.XDG_RUNTIME_DIR
      : path.join(os.tmpdir(), `dsh-desktop-runtime-${uid}`)

  const configDir = path.join(xdgConfigHome, APP_DIRNAME)
  const applicationsDir = path.join(xdgDataHome, 'applications')
  const iconScalableDir = path.join(xdgDataHome, 'icons', 'hicolor', 'scalable', 'apps')
  const iconBitmapDir = path.join(xdgDataHome, 'icons', 'hicolor', '128x128', 'apps')

  const runtimeDir = path.join(xdgRuntimeHome, APP_DIRNAME)

  return {
    home: effectiveHome,
    sandboxed,

    configHome: xdgConfigHome,
    dataHome: xdgDataHome,
    runtimeHome: xdgRuntimeHome,

    binDir: path.join(effectiveHome, '.local', 'bin'),
    configDir,
    configFile: path.join(configDir, 'config.json'),

    applicationsDir,
    desktopEntryFile: path.join(applicationsDir, `${DESKTOP_ENTRY_ID}.desktop`),

    iconScalableDir,
    iconScalableFile: path.join(iconScalableDir, `${ICON_NAME}.svg`),
    iconBitmapDir,
    iconBitmapFile: path.join(iconBitmapDir, `${ICON_NAME}.png`),

    launcherFile: path.join(effectiveHome, '.local', 'bin', LAUNCHER_FILENAME),
    cliShimFile: path.join(effectiveHome, '.local', 'bin', CLI_SHIM_FILENAME),

    // 专用浏览器配置目录：独立进程 → 窗口关闭时进程结束 → 启动器可以可靠地
    // 等到「窗口已关闭」这一事实。见 README 的「生命周期」一节。
    chromeProfileDir: path.join(xdgDataHome, APP_DIRNAME, 'chromium-profile'),

    runtimeDir,
    runtimeEnvFile: path.join(runtimeDir, 'runtime.env'),
    runtimeJsonFile: path.join(runtimeDir, 'runtime.json'),

    logFile: path.join(xdgRuntimeHome, `${APP_DIRNAME}-web.log`),
    backupsDir: path.join(configDir, 'backups'),

    kwinRulesFile: path.join(xdgConfigHome, 'kwinrulesrc'),
  }
}
