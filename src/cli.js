/**
 * `dsh-desktop` 命令行实现。
 *
 * 刻意不引入 commander 之类的依赖：这个 CLI 的参数面很小，手写解析能保证
 * 插件零运行时依赖 —— 对一个要 `dsh plugin add` 装进用户 profile 的包来说，
 * 依赖越少，装得越快、越不容易和用户已有的包冲突。
 *
 * @module dsh-linux-desktop/cli
 */

import fs from 'node:fs'
import path from 'node:path'

import { connectHost, defaultConfig, normalizeConfig, readConfig, writeConfig } from './config.js'
import { install, pluginVersion, status, uninstall } from './installer.js'
import { resolveDshBin } from './installer.js'
import { resolvePaths } from './paths.js'
import { clearRuntime, inspectRuntime, probePort } from './runtime.js'
import { resolveServerTarget, startServerDetached, stopServerProcess, waitForServer } from './server.js'

const USAGE = `dsh-desktop —— DeepSeek Harness 的 Linux 桌面集成管理

用法：
  dsh-desktop install [选项]     安装 / 修复桌面集成（幂等）
  dsh-desktop uninstall          移除桌面集成（保留配置与备份）
  dsh-desktop status             查看安装状态与健康检查
  dsh-desktop doctor             诊断并给出修复建议
  dsh-desktop config [--edit]    查看配置文件位置与内容
  dsh-desktop set <键> <值>      修改一项配置并重新安装
  dsh-desktop open               直接以独立窗口打开 dsh（等价于点桌面图标）
  dsh-desktop stop               停止当前正在运行的 dsh web
  dsh-desktop restart            重启 dsh web（装完插件后需要重启才生效）
  dsh-desktop runtime            查看当前 dsh web 的运行时状态

stop / restart 选项：
  --force                跳过「目标进程确实是 dsh web」的身份校验（危险，仅在确认后使用）

install 选项：
  --force                忽略「已是最新」，强制重写全部文件
  --port <端口>          指定 dsh web 端口（默认 3080）
  --host <主机>          指定绑定主机（默认 127.0.0.1）
  --size <宽>x<高>       指定窗口初始尺寸（默认 1200x750）
  --browser <id|路径>    指定浏览器：auto/chrome/chromium/brave/edge/vivaldi/opera
  --profile-mode <模式>  dedicated（默认，关窗即停服务）或 shared（复用现有浏览器配置）
  --no-kwin              不托管 KWin 窗口规则
  --hyprland             托管 Hyprland 窗口规则（强制该窗口浮动并使用 --size 尺寸）
  --no-auto-install      关闭「dsh web 启动时自动安装」

通用选项：
  --root <目录>          沙箱模式：把所有读写重定向到该目录（测试用）
  --json                 以 JSON 输出（便于脚本处理）
  -h, --help             显示本帮助
  -v, --version          显示版本
`

/** 极简 ANSI 着色；非 TTY 或设了 NO_COLOR 就自动关闭。 */
function makePainter(stream) {
  const enabled = Boolean(stream.isTTY) && !process.env.NO_COLOR
  const wrap = (code) => (text) => (enabled ? `\u001B[${code}m${text}\u001B[0m` : text)
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('34'),
    enabled,
  }
}

/**
 * 解析 argv。
 *
 * @param {string[]} argv 不含 node 与脚本路径。
 */
export function parseArgs(argv) {
  const flags = {}
  const positional = []
  const alias = { '-h': '--help', '-v': '--version' }

  for (let i = 0; i < argv.length; i += 1) {
    let token = argv[i]
    if (alias[token]) token = alias[token]

    if (token === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      const name = body
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[name] = next
        i += 1
      } else {
        flags[name] = true
      }
      continue
    }
    positional.push(token)
  }

  return { command: positional[0] ?? 'help', positional: positional.slice(1), flags }
}

/** 把 CLI 选项合并进配置。 */
function applyFlagOverrides(config, flags, warnings) {
  const next = structuredClone(config)

  if (flags.port !== undefined) next.port = Number.parseInt(String(flags.port), 10)
  if (flags.host !== undefined) next.host = String(flags.host)
  if (flags.browser !== undefined) next.browser = String(flags.browser)
  if (flags['profile-mode'] !== undefined) next.profileMode = String(flags['profile-mode'])
  if (flags.size !== undefined) {
    const match = /^(\d+)x(\d+)$/.exec(String(flags.size))
    if (!match) warnings.push(`--size 格式应为 <宽>x<高>，收到：${flags.size}`)
    else next.window = { width: Number(match[1]), height: Number(match[2]) }
  }
  if (flags['no-kwin'] !== undefined) next.manageKwinRules = false
  // Hyprland 默认**不**托管（平铺 WM 不该被插件擅自改成浮动），所以要显式打开。
  if (flags.hyprland !== undefined) next.manageHyprlandRules = true
  if (flags['no-auto-install'] !== undefined) next.autoInstall = false

  return normalizeConfig(next).config
}

function printSteps(steps, p, out) {
  const icon = {
    created: p.green('＋ 新建'),
    updated: p.blue('↻ 更新'),
    unchanged: p.dim('＝ 未变'),
    ok: p.green('✓ 正常'),
    skipped: p.dim('－ 跳过'),
    absent: p.dim('－ 不存在'),
    removed: p.yellow('－ 已移除'),
    failed: p.red('✗ 失败'),
    info: p.dim('· 说明'),
    warning: p.yellow('! 注意'),
  }
  for (const step of steps) {
    const label = icon[step.status] ?? step.status
    out.write(`  ${label}  ${step.id.padEnd(20)} ${p.dim(step.detail ?? '')}\n`)
  }
}

/**
 * 运行 CLI。
 *
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [io]
 * @returns {Promise<number>} 退出码
 */
export async function run(argv, io = {}) {
  const env = io.env ?? process.env
  const out = io.stdout ?? process.stdout
  const err = io.stderr ?? process.stderr
  const p = makePainter(out)

  const { command, positional, flags } = parseArgs(argv)

  // 沙箱模式：影响所有路径推导。
  if (typeof flags.root === 'string') env.DSH_DESKTOP_ROOT = flags.root
  const paths = resolvePaths(env)
  const asJson = flags.json !== undefined

  const writeJson = (value) => out.write(`${JSON.stringify(value, null, 2)}\n`)

  switch (command) {
    case 'help':
    case undefined: {
      out.write(USAGE)
      return 0
    }

    case 'version': {
      out.write(`${pluginVersion()}\n`)
      return 0
    }

    case 'install': {
      const read = readConfig(paths)
      const warnings = [...read.warnings]
      const config = applyFlagOverrides(read.config, flags, warnings)

      // 显式改了配置就落盘，让后续 dsh web 启动时读到同一份。
      const configChanged = JSON.stringify(config) !== JSON.stringify(read.config)
      if (configChanged) {
        try {
          writeConfig(paths, config)
        } catch (error) {
          err.write(`${p.red('无法写入配置')}：${error.message}\n`)
          return 1
        }
      }

      const result = install({ paths, config, env, force: flags.force !== undefined })
      warnings.push(...result.warnings)

      if (asJson) {
        writeJson({ ...result, warnings, config, configFile: paths.configFile })
        return result.ok ? 0 : 1
      }

      out.write(`${p.bold('DeepSeek Harness · Linux 桌面集成')}  ${p.dim(`v${pluginVersion()}`)}\n\n`)
      printSteps(result.steps, p, out)
      if (configChanged) out.write(`\n  ${p.green('配置已更新')} → ${paths.configFile}\n`)
      for (const warning of warnings) out.write(`  ${p.yellow('警告')} ${warning}\n`)

      if (!result.ok) {
        out.write(`\n${p.red('安装未完成')}。运行 ${p.bold('dsh-desktop doctor')} 查看诊断。\n`)
        return 1
      }

      out.write(
        result.changed
          ? `\n${p.green('完成')}。现在可以从程序启动器搜索 “DeepSeek Harness” 启动了。\n`
          : `\n${p.green('已是最新')}，无需改动。\n`,
      )
      return 0
    }

    case 'uninstall': {
      const result = uninstall({ paths, env })
      if (asJson) {
        writeJson(result)
        return 0
      }
      out.write(`${p.bold('移除 DeepSeek Harness 桌面集成')}\n\n`)
      printSteps(result.steps, p, out)
      for (const warning of result.warnings) out.write(`  ${p.yellow('警告')} ${warning}\n`)
      out.write(`\n${p.green('完成')}。\n`)
      return 0
    }

    case 'status':
    case 'doctor': {
      // 先探一次端口：运行时文件不存在并不代表服务没在跑。
      const probeConfig = readConfig(paths).config
      const portListening = await probePort(connectHost(probeConfig), probeConfig.port)
      const report = status({ paths, env, portListening })
      if (asJson) {
        writeJson(report)
        return report.healthy ? 0 : 1
      }

      out.write(`${p.bold('DeepSeek Harness · Linux 桌面集成诊断')}  ${p.dim(`v${pluginVersion()}`)}\n\n`)
      out.write(`  ${p.dim('平台')}     ${process.platform} / ${report.desktop.label} / ${report.desktop.session.isWayland ? 'Wayland' : report.desktop.session.isX11 ? 'X11' : '未知'}\n`)
      out.write(`  ${p.dim('app_id')}   ${report.appId}\n`)
      out.write(`  ${p.dim('配置')}     ${paths.configFile}\n`)
      out.write(`  ${p.dim('启动器')}   ${paths.launcherFile}\n\n`)

      for (const check of report.checks) {
        const mark = check.ok ? p.green('✓') : check.level === 'warning' ? p.yellow('!') : check.level === 'info' ? p.dim('·') : p.red('✗')
        out.write(`  ${mark} ${check.id.padEnd(20)} ${p.dim(check.detail)}\n`)
      }

      for (const warning of report.configWarnings) out.write(`\n  ${p.yellow('配置警告')} ${warning}\n`)

      if (command === 'doctor') {
        const advice = buildAdvice(report, paths)
        if (advice.length > 0) {
          out.write(`\n${p.bold('建议')}\n`)
          for (const line of advice) out.write(`  · ${line}\n`)
        }
      }

      out.write(
        report.healthy
          ? `\n${p.green('一切正常')}。\n`
          : `\n${p.yellow('存在问题')}，详见上方 ✗ 项。\n`,
      )
      return report.healthy ? 0 : 1
    }

    case 'config': {
      const read = readConfig(paths)
      if (flags.edit !== undefined) {
        out.write(`${paths.configFile}\n`)
        return 0
      }
      if (asJson) {
        writeJson({ file: paths.configFile, exists: read.exists, config: read.config, warnings: read.warnings })
        return 0
      }
      out.write(`${p.dim('配置文件')} ${paths.configFile} ${read.exists ? '' : p.yellow('（尚未生成，以下为默认值）')}\n\n`)
      out.write(`${JSON.stringify(read.config, null, 2)}\n`)
      for (const warning of read.warnings) out.write(`\n${p.yellow('警告')} ${warning}\n`)
      return 0
    }

    case 'set': {
      const [key, ...rest] = positional
      const value = rest.join(' ')
      if (!key || value.length === 0) {
        err.write(`${p.red('用法')}：dsh-desktop set <键> <值>\n`)
        err.write(`可用键：${Object.keys(defaultConfig()).join(', ')}\n`)
        return 2
      }
      const read = readConfig(paths)
      const raw = { ...read.config }
      if (key === 'window') {
        const match = /^(\d+)x(\d+)$/.exec(value)
        if (!match) {
          err.write(`${p.red('window 需要 <宽>x<高> 格式')}\n`)
          return 2
        }
        raw.window = { width: Number(match[1]), height: Number(match[2]) }
      } else if (['autoInstall', 'manageKwinRules', 'manageHyprlandRules', 'terminalAction'].includes(key)) {
        raw[key] = value === 'true' || value === '1' || value === 'yes'
      } else if (key === 'port') {
        raw.port = Number.parseInt(value, 10)
      } else if (Object.prototype.hasOwnProperty.call(defaultConfig(), key)) {
        raw[key] = value
      } else {
        err.write(`${p.red('未知配置键')}：${key}\n可用键：${Object.keys(defaultConfig()).join(', ')}\n`)
        return 2
      }

      const { config, warnings } = normalizeConfig(raw)
      writeConfig(paths, config)
      out.write(`${p.green('已写入')} ${key} = ${JSON.stringify(config[key])} → ${paths.configFile}\n`)
      for (const warning of warnings) out.write(`${p.yellow('警告')} ${warning}\n`)

      out.write(`\n${p.dim('正在按新配置重新安装…')}\n`)
      const result = install({ paths, config, env, force: true })
      printSteps(result.steps, p, out)
      return result.ok ? 0 : 1
    }

    case 'stop': {
      const stopConfig = readConfig(paths).config
      const host = connectHost(stopConfig)
      const runtime = inspectRuntime(paths, { port: stopConfig.port })

      const target = resolveServerTarget({
        paths,
        port: stopConfig.port,
        runtimeRecord: runtime.record,
        force: flags.force !== undefined,
        // 沙箱模式下禁止按端口找进程：端口不是沙箱化的，这条退路会误伤真实服务。
        allowPortLookup: !paths.sandboxed || flags.force !== undefined,
        env,
      })

      if (!target.ok) {
        if (asJson) writeJson({ ok: false, ...target })
        else {
          out.write(`${p.yellow('没有停止任何进程')}：${target.reason}\n`)
          if (target.hint) out.write(`  ${p.dim(target.hint)}\n`)
        }
        return 1
      }

      const result = await stopServerProcess(target.pid)
      // 只有记录的 pid 就是刚停掉的那个才清理运行时状态，避免误删别人的。
      clearRuntime(paths, { pid: target.pid })

      if (asJson) {
        writeJson({ ok: result.ok, pid: target.pid, source: target.source, forced: result.forced, reason: result.reason })
        return result.ok ? 0 : 1
      }

      if (!result.ok) {
        out.write(`${p.red('停止失败')}：${result.reason}\n`)
        return 1
      }
      out.write(
        `${p.green('已停止')} dsh web（进程 ${target.pid}${result.forced ? '，SIGKILL 强制结束' : '，优雅退出'}）\n`,
      )
      out.write(`  ${p.dim(`来源：${target.source}`)}\n`)
      if (target.command) out.write(`  ${p.dim(`命令：${target.command}`)}\n`)
      return 0
    }

    case 'restart': {
      const restartConfig = readConfig(paths).config
      const host = connectHost(restartConfig)
      const port = restartConfig.port

      // 先停（如果确实在跑）
      const runtime = inspectRuntime(paths, { port })
      const target = resolveServerTarget({
        paths,
        port,
        runtimeRecord: runtime.record,
        force: flags.force !== undefined,
        // 沙箱模式下禁止按端口找进程：端口不是沙箱化的，这条退路会误伤真实服务。
        allowPortLookup: !paths.sandboxed || flags.force !== undefined,
        env,
      })

      if (target.ok) {
        const stopped = await stopServerProcess(target.pid)
        clearRuntime(paths, { pid: target.pid })
        if (!stopped.ok) {
          err.write(`${p.red('停止旧服务失败')}：${stopped.reason}\n`)
          return 1
        }
        out.write(`${p.green('已停止旧服务')}（进程 ${target.pid}）\n`)
      } else {
        out.write(`${p.dim(`没有需要停止的服务：${target.reason}`)}\n`)
      }

      const dshBin = resolveDshBin(env)
      if (!dshBin) {
        err.write(`${p.red('找不到 dsh 可执行文件')}，无法重启。\n`)
        return 1
      }

      const pid = startServerDetached({ dshBin, host, port, logFile: paths.logFile, env })
      out.write(`${p.dim(`已启动 dsh web（进程 ${pid}），等待就绪…`)}\n`)

      const ready = await waitForServer({ host, port, timeoutMs: 45000 })
      if (!ready) {
        err.write(`${p.red('服务未能在预期时间内就绪')}。日志：${paths.logFile}\n`)
        return 1
      }

      if (asJson) {
        writeJson({ ok: true, pid, host, port })
        return 0
      }
      out.write(`${p.green('dsh web 已就绪')} → http://${host}:${String(port)}/\n`)
      out.write(`  ${p.dim(`日志：${paths.logFile}`)}\n`)
      out.write(`  ${p.dim('提示：用 dsh-desktop stop 可以再次停止它。')}\n`)
      return 0
    }

    case 'open': {
      if (!fs.existsSync(paths.launcherFile)) {
        err.write(`${p.red('尚未安装')}。请先运行：dsh-desktop install\n`)
        return 1
      }
      const { spawn } = await import('node:child_process')
      const child = spawn(paths.launcherFile, [], { detached: true, stdio: 'ignore' })
      child.unref()
      out.write(`${p.green('已请求启动')}（独立窗口）。\n`)
      return 0
    }

    case 'runtime': {
      const runtime = inspectRuntime(paths, { port: readConfig(paths).config.port })
      if (asJson) {
        writeJson(runtime)
        return runtime.fresh ? 0 : 1
      }
      if (!runtime.fresh) {
        out.write(`${p.yellow('没有活动的 dsh web 运行时状态')}：${runtime.reason}\n`)
        out.write(`${p.dim('文件位置')} ${paths.runtimeEnvFile}\n`)
        return 1
      }
      out.write(`${p.green('dsh web 正在服务')}\n`)
      out.write(`  端口   ${runtime.record.port}\n`)
      out.write(`  进程   ${runtime.record.pid}\n`)
      out.write(`  地址   ${runtime.record.url}\n`)
      out.write(`  启动于 ${runtime.record.startedAt}\n`)
      return 0
    }

    default: {
      err.write(`${p.red('未知命令')}：${command}\n\n${USAGE}`)
      return 2
    }
  }
}

/** 根据诊断结果给出可操作建议。 */
function buildAdvice(report, paths) {
  const advice = []
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]))

  if (!byId.browser?.ok) {
    advice.push('安装一个 Chromium 系浏览器：sudo pacman -S chromium（Arch）／sudo apt install chromium（Debian）／sudo dnf install chromium（Fedora）')
  }
  if (!byId.launcher?.ok || !byId['desktop-entry']?.ok) {
    advice.push(`运行 dsh-desktop install 生成缺失的文件（预期位置：${paths.launcherFile}）`)
  }
  if (byId['desktop-entry']?.ok && !byId['desktop-entry-alias']?.ok) {
    advice.push('app_id 别名入口缺失 —— 这会让任务栏显示成黄色的通用 Wayland 图标。运行 dsh-desktop install --force 重建。')
  }
  if (byId['app-id-match'] && !byId['app-id-match'].ok) {
    advice.push('桌面入口里的 StartupWMClass 与实际窗口 app_id 不一致。通常是改过 host 配置：运行 dsh-desktop install --force 让入口跟上配置。')
  }
  if (byId['kwin-rule'] && !byId['kwin-rule'].ok) {
    advice.push('KWin 窗口规则缺失：窗口可能在高分屏下纵向拉满。运行 dsh-desktop install --force 重建。')
  }
  if (byId['gnome-window-size'] && !byId['gnome-window-size'].ok) {
    advice.push(
      'GNOME 会把这个尺寸的窗口自动最大化，上面的宽高设置将不生效。两个办法：' +
        '把窗口宽高调小到逻辑工作区的 80% 以下；或执行 gsettings set org.gnome.mutter auto-maximize false ' +
        '（注意这是**全局**设置，会影响所有应用的窗口最大化行为，且可用 gsettings reset 还原）。',
    )
  }
  if (byId['desktop-session'] && !byId['desktop-session'].ok) {
    advice.push('当前没有图形会话 —— 桌面集成只能在登录桌面后生效。')
  }
  if (!report.runtime) {
    const portCheck = report.checks.find((c) => c.id === 'port')
    if (portCheck && /有服务在监听/.test(portCheck.detail)) {
      advice.push('端口上有 dsh web 在跑，但它不是通过插件启动的 —— 启动器会复用它但不会在关窗时停掉它。若希望「关窗即停」，请从桌面图标启动。')
    } else {
      advice.push('当前没有 dsh web 在跑，这是正常的：从程序启动器打开时会自动拉起。')
    }
  }
  return advice
}

export { USAGE }
