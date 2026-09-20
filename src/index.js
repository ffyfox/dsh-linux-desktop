/**
 * `dsh-linux-desktop` 的宿主插件行。
 *
 * 这一行跑在 `dsh web` 进程内部，只做两件事：
 *
 * 1. **发布运行时状态**：服务绑定端口之后，把「端口 / 进程号 / 带 token 的地址」
 *    写进 XDG 运行时目录。这是整个方案的信任基石 —— 桌面启动器因此能拿到
 *    鉴权地址，而不是只能去 grep 自己写的日志。
 *
 * 2. **幂等自愈桌面集成**：把桌面入口、图标、启动脚本、KWin 规则同步到当前版本。
 *    内容没变就不碰文件，所以每次启动的额外开销接近于零。
 *
 * 安全约定（对应需求「不应影响任何 dsh web 本身功能」）：
 *   - 通过 `inject` 声明依赖，缺少 connection / webServer 的 profile（tui、headless）
 *     里这一行会停在 PENDING 而不激活 —— 不会在任何其它 profile 里产生副作用。
 *   - 所有副作用都包在 try/catch 里，任何一步失败都只写日志，绝不向上抛。
 *   - 非 Linux 直接返回。
 *
 * @module dsh-linux-desktop
 */

import { connectHost, readConfig } from './config.js'
import { detectDesktopEnvironment } from './detect.js'
import { install, pluginVersion } from './installer.js'
import { resolvePaths } from './paths.js'
import { clearRuntime, writeRuntime } from './runtime.js'

/** Cordis 插件名（出现在 Loader 树与诊断里）。 */
export const name = 'linux-desktop'

/**
 * 声明依赖的两个宿主服务。
 *
 * 这是一个「声明式开关」：`dsh web` 里有它们，插件才会激活；`dsh --profile tui`
 * 里没有，插件就永远停在 PENDING。桌面集成因此天然只作用于 web 界面。
 */
export const inject = ['connection', 'webServer']

/**
 * Cordis 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  if (process.platform !== 'linux') return

  const env = process.env
  const paths = resolvePaths(env)
  const version = pluginVersion()

  const log = (...args) => {
    try {
      const logger = ctx.logger?.('linux-desktop')
      if (logger?.info) logger.info(...args)
      else if (env.DSH_DESKTOP_DEBUG === '1') console.error('[linux-desktop]', ...args)
    } catch {
      // 日志本身绝不能成为失败源。
    }
  }
  const warn = (...args) => {
    try {
      const logger = ctx.logger?.('linux-desktop')
      if (logger?.warn) logger.warn(...args)
      else if (env.DSH_DESKTOP_DEBUG === '1') console.error('[linux-desktop]', ...args)
    } catch {
      /* ignore */
    }
  }

  ctx.effect(() => {
    const publish = (reason) => {
      try {
        const port = ctx.webServer?.port
        if (typeof port !== 'number' || port <= 0) {
          // 端口 0 表示还没 bind（或由 OS 分配且尚未确定），等下一次机会。
          return false
        }
        const config = readConfig(paths).config
        const host = connectHost(config)
        const base = `http://${host}:${String(port)}/`
        const url = ctx.connection.authenticatedUrl(base)
        writeRuntime(paths, { pid: process.pid, host, port, url, version })
        log(`运行时状态已发布（${reason}）：${host}:${String(port)} → ${paths.runtimeEnvFile}`)
        return true
      } catch (error) {
        warn(`发布运行时状态失败（${reason}）：${error?.message ?? String(error)}`)
        return false
      }
    }

    // 发布两次，是刻意的「双保险」：
    //   - 立刻发布一次：HTTP 服务在行激活时就 bind 了，此时桌面启动器可能已经在
    //     轮询运行时文件。越早出现，启动器拿到带 token 地址的窗口期就越短。
    //   - Loader 树落定后再发布一次：与 dsh-web-app 自己「打印 URL」的时机对齐，
    //     确保最终落盘的是权威值。
    // 两次写的是同一份内容（token 在进程生命周期内不变），重复写没有副作用。
    publish('immediate')

    try {
      const loader = ctx.get('loader')
      const settled = typeof loader?.await === 'function' ? loader.await() : undefined
      if (settled && typeof settled.then === 'function') {
        settled.then(
          () => publish('after-loader'),
          () => warn('等待 Loader 树落定失败，运行时状态仅保留了即时发布的那一份'),
        )
      }
    } catch (error) {
      warn(`等待 Loader 树时出错：${error?.message ?? String(error)}`)
    }

    return () => {
      // 进程正常退出时清掉运行时状态，避免启动器读到陈旧记录。
      // clearRuntime 内部会校验 pid，不会误删新进程刚写下的状态。
      try {
        clearRuntime(paths, { pid: process.pid })
      } catch {
        /* ignore */
      }
    }
  })

  // ---- 幂等自愈桌面集成 --------------------------------------------------
  try {
    const { config, warnings } = readConfig(paths)
    for (const warning of warnings) warn(warning)

    if (!config.autoInstall) {
      log('配置里关闭了 autoInstall，跳过自动安装')
      return
    }

    const desktop = detectDesktopEnvironment(env)
    if (!desktop.session.hasDisplay) {
      log('当前没有图形会话，跳过自动安装')
      return
    }

    const result = install({ paths, config, env, quiet: true })
    if (!result.ok) {
      const failure = result.steps.find((step) => step.status === 'failed')
      warn(`桌面集成自动安装未完成：${failure?.detail ?? '原因未知'}（可运行 dsh-desktop doctor 诊断）`)
      return
    }
    log(result.changed ? '桌面集成已安装 / 更新完成' : '桌面集成已是最新')
  } catch (error) {
    // 自动安装失败绝不能让 dsh web 起不来。
    warn(`桌面集成自动安装异常：${error?.message ?? String(error)}`)
  }
}
