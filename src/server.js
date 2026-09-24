/**
 * dsh web 服务的查找、启停。
 *
 * 这一层存在的理由：桌面启动器只能管理「它自己启动的」服务 —— 这是安全底线，
 * 否则会误杀用户在终端里手动跑的 dsh web。但这样一来就有两个缺口：
 *
 *   1. 用户在终端起了一个 dsh web，点桌面图标只是「复用」，关窗不会停它 ——
 *      用户会以为坏了，而且没有任何办法从桌面侧把它停掉。
 *   2. `profileMode: shared` 下启动器自己起的服务，会因为窗口「移交给既有浏览器
 *      进程」而无法感知关闭时刻，最终留下一个孤儿进程。
 *
 * 所以需要一组「用户主动发起的」启停能力：`dsh-desktop stop` / `restart`。
 * 它们和启动器的区别是**意图来源**：启动器是自动的，必须保守；这两个命令是
 * 用户明确要求的，可以动手，但仍然要先确认目标进程真的是 dsh web。
 *
 * @module dsh-linux-desktop/server
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'

import { isProcessAlive } from './runtime.js'

/**
 * 读取进程的 argv。
 *
 * @param {number} pid
 * @returns {string[] | null} 读不到（进程不存在 / 无权限 / 非 Linux）返回 null。
 */
export function readProcessCommand(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8')
    const argv = raw.split('\0').filter((part) => part.length > 0)
    return argv.length > 0 ? argv : null
  } catch {
    return null
  }
}

/**
 * 判断某个 pid 是不是一个 dsh web 进程。
 *
 * 这是所有「停止服务」操作的最后一道闸：宁可拒绝停一个可疑进程，也不能误杀
 * 用户别的东西。所以判据只认「命令行里既有 dsh，又确实在跑 web 界面」。
 *
 * 实测的 cmdline 有两种等价写法，**都必须认**：
 *   ['node', '/home/<user>/.npm-global/bin/dsh', 'web', '--no-open', '--port', '3080']
 *   ['node', '/home/<user>/.npm-global/bin/dsh', '--profile', 'web-dev', '--no-open', …]
 *
 * 第二种是 0.5.0 起启动器与 `dsh-desktop start` 的统一写法。它**不含 `web` 这个词** ——
 * 只认子命令的话，`dsh-desktop stop` 会认不出自己刚拉起的服务并拒绝停它。
 *
 * @param {number} pid
 * @returns {{ ok: boolean, reason: string, command: string | null }}
 */
export function isDshWebProcess(pid) {
  const argv = readProcessCommand(pid)
  if (argv === null) {
    return { ok: false, reason: `读不到进程 ${pid} 的命令行（可能已退出或权限不足）`, command: null }
  }

  const command = argv.join(' ')
  const mentionsDsh = argv.some((arg) => /(^|[/\\])dsh(\.js)?$/.test(arg)) || /@deepseek-ai[/\\]dsh/.test(command)
  const hasWebSubcommand = argv.includes('web')

  // `--profile` 后面必须跟一个不像选项的值，否则 `--profile --no-open` 也会被当成
  // 「指定了 profile」，把判据放得过宽。
  const profileAt = argv.indexOf('--profile')
  const profileValue = profileAt >= 0 ? argv[profileAt + 1] : undefined
  const hasProfile = typeof profileValue === 'string' && profileValue.length > 0 && !profileValue.startsWith('-')

  if (!mentionsDsh) return { ok: false, reason: `进程 ${pid} 的命令行里没有 dsh：${command}`, command }
  if (!hasWebSubcommand && !hasProfile) {
    return { ok: false, reason: `进程 ${pid} 既不是 web 子命令，也没有 --profile：${command}`, command }
  }
  return { ok: true, reason: 'ok', command }
}

/**
 * 找出正在监听某个端口的进程号。
 *
 * 优先用 `ss`（iproute2，几乎处处都有），退回 `lsof`。两者都拿不到就返回 null。
 *
 * @param {number} port
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ pid: number, via: string } | null}
 */
export function findListeningPid(port, env = process.env) {
  const attempts = [
    ['ss', ['-ltnp', `sport = :${String(port)}`], (out) => /pid=(\d+)/.exec(out)?.[1]],
    ['ss', ['-ltnp'], (out) => {
      // 退一步：不过滤，自己在输出里找该端口那一行。
      const line = out.split('\n').find((row) => row.includes(`:${String(port)} `) && row.includes('pid='))
      return line ? /pid=(\d+)/.exec(line)?.[1] : undefined
    }],
    ['lsof', ['-ti', `tcp:${String(port)}`, '-sTCP:LISTEN'], (out) => out.trim().split('\n')[0]],
  ]

  for (const [cmd, args, extract] of attempts) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', timeout: 5000, env })
      const pid = extract(out)
      if (pid && /^\d+$/.test(pid)) return { pid: Number(pid), via: cmd }
    } catch {
      // 换下一个探测方式。
    }
  }
  return null
}

/**
 * 决定「要停的是哪个进程」，并给出可信度。
 *
 * 两条来源：
 *   - `runtime`：插件发布的运行时状态里记录的 pid。可信度最高，因为那一定是我们
 *     自己的插件写下的，且带端口校验。
 *   - `port`：直接看谁占着端口。运行时状态不存在时（服务启动时插件还没装，
 *     或者服务是从终端起的）才走这条路。
 *
 * @param {object} options
 * @param {ReturnType<import('./paths.js').resolvePaths>} options.paths
 * @param {number} options.port
 * @param {{ record: object } | null} [options.runtimeRecord]
 * @param {boolean} [options.force] 跳过 dsh web 身份校验。
 * @param {boolean} [options.allowPortLookup] 是否允许「按端口找进程」这条退路。
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{ ok: true, pid: number, source: string, command: string | null }
 *          | { ok: false, reason: string, hint?: string }}
 */
export function resolveServerTarget({
  paths,
  port,
  runtimeRecord,
  force = false,
  allowPortLookup = true,
  env = process.env,
}) {
  /** @type {Array<{ pid: number, source: string }>} */
  const candidates = []

  if (runtimeRecord && typeof runtimeRecord.pid === 'number' && runtimeRecord.port === port) {
    candidates.push({ pid: runtimeRecord.pid, source: 'runtime' })
  }

  // 沙箱模式下**必须**关掉「按端口找进程」这条退路。
  //
  // 原因（本项目真实踩过的坑）：沙箱只重定向插件的桌面文件路径，**端口不是沙箱
  // 化的**。于是在沙箱里跑 stop/restart 时，这条退路会找到并杀掉真实环境里那个
  // 正在服务的 dsh web —— 一次疏忽就把用户正在用的服务重启了。
  // 而沙箱下的运行时状态只可能指向沙箱内的进程，所以关掉它既安全又不影响测试。
  const listening = allowPortLookup ? findListeningPid(port, env) : null
  if (listening && !candidates.some((c) => c.pid === listening.pid)) {
    candidates.push({ pid: listening.pid, source: `port(${listening.via})` })
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `没有找到监听端口 ${port} 的进程，也没有对应的运行时状态`,
      hint: '可能本来就没有在跑；可以用 dsh-desktop status 确认。',
    }
  }

  for (const candidate of candidates) {
    if (!isProcessAlive(candidate.pid)) continue
    const identity = isDshWebProcess(candidate.pid)
    if (identity.ok) {
      return { ok: true, pid: candidate.pid, source: candidate.source, command: identity.command }
    }
    if (force) {
      return {
        ok: true,
        pid: candidate.pid,
        source: `${candidate.source} (--force)`,
        command: identity.command,
      }
    }
    return {
      ok: false,
      reason: `端口 ${port} 上的进程 ${candidate.pid} 看起来不是 dsh web：${identity.reason}`,
      hint: '如果确认要停它，加上 --force。',
    }
  }

  return { ok: false, reason: `端口 ${port} 上记录的进程都已经不存在了（陈旧的运行时状态）` }
}

/**
 * 停止一个进程：先 SIGTERM，超时再 SIGKILL。
 *
 * 刻意写成 **async**：早先的版本用 `Atomics.wait` 做同步睡眠，结果**阻塞了事件
 * 循环**，Node 无法回收子进程，被停掉的进程一直以僵尸态留在进程表里，于是
 * 「等它消失」永远等不到。用真正的定时器既修掉这个问题，也更符合 Node 习惯。
 *
 * @param {number} pid
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, forced: boolean, reason?: string }>}
 */
export async function stopServerProcess(pid, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000
  if (!isProcessAlive(pid)) return { ok: true, forced: false, reason: '进程本来就不存在' }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    return { ok: false, forced: false, reason: `发送 SIGTERM 失败：${error.message}` }
  }

  if (await waitForExit(pid, timeoutMs)) return { ok: true, forced: false }

  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    return { ok: false, forced: true, reason: `发送 SIGKILL 失败：${error.message}` }
  }

  if (await waitForExit(pid, 3000)) return { ok: true, forced: true }
  return { ok: false, forced: true, reason: '进程在 SIGKILL 之后仍然存在' }
}

/**
 * 轮询等待进程消失。
 *
 * @param {number} pid
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return !isProcessAlive(pid)
}

/**
 * 以脱离终端的方式启动 dsh web。
 *
 * `detached: true` + `unref()`：新进程自成进程组，关掉当前终端不会连带打死它，
 * 也不会在终端退出时收到 SIGHUP。
 *
 * @param {object} options
 * @param {string} options.dshBin
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} [options.profile] 要启动的 dsh profile，默认 `web`。
 * @param {string} options.logFile
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {number} 新进程的 pid
 */
export function startServerDetached({ dshBin, host, port, profile = 'web', logFile, env = process.env }) {
  fs.mkdirSync(logFile.replace(/\/[^/]+$/, ''), { recursive: true })
  const out = fs.openSync(logFile, 'a')

  // 统一用 `--profile <名字>` 而不是 `web` 子命令：两者完全等价（`dsh web` 就是
  // `dsh --profile web`），但只有前者能表达自定义 profile。改这里必须同步改
  // isDshWebProcess —— 它的身份判据要认这种新写法。
  const child = spawn(dshBin, ['--profile', profile, '--no-open', '--port', String(port), '--host', host], {
    detached: true,
    stdio: ['ignore', out, out],
    env,
  })
  child.unref()
  return child.pid
}

/**
 * 轮询等待服务可连。
 *
 * @param {{ host: string, port: number, timeoutMs?: number, isAlive?: () => boolean }} options
 * @returns {Promise<boolean>}
 */
export async function waitForServer({ host, port, timeoutMs = 40000, isAlive }) {
  const { probePort } = await import('./runtime.js')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probePort(host, port, 700)) return true
    if (typeof isAlive === 'function' && !isAlive()) return false
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}
