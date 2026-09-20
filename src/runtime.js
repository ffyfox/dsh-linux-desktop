/**
 * 运行时状态发布：把「正在服务的 dsh web 的端口 / 进程号 / 带 token 的地址」
 * 写到 XDG 运行时目录，供桌面启动器读取。
 *
 * 为什么需要它？因为 dsh web 有鉴权围栏：不带 cookie 访问 `/` 会得到 401，
 * 而 launch token 只存在于**启动那个进程的终端输出**里。启动器如果只能靠
 * grep 自己写的日志，就永远拿不到「别人（比如你手动在终端）启动的服务」的 token。
 *
 * 插件运行在 dsh web 进程内部，可以直接调用 `ctx.connection.authenticatedUrl()`，
 * 所以由它来发布这份状态是最可靠的。
 *
 * 同时写两份：
 *   - `runtime.env`：`key=value` 纯文本，专供 shell 启动器解析（不引入 jq 依赖）。
 *   - `runtime.json`：结构化版本，供 `dsh-desktop status` 等工具读取。
 *
 * @module dsh-linux-desktop/runtime
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/**
 * 写入运行时状态。
 *
 * @param {ReturnType<import('./paths.js').resolvePaths>} paths
 * @param {{ pid: number, host: string, port: number, url: string, version?: string }} state
 * @returns {{ envFile: string, jsonFile: string }}
 */
export function writeRuntime(paths, state) {
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 })

  const startedAt = new Date().toISOString()
  const record = {
    pid: state.pid,
    host: state.host,
    port: state.port,
    url: state.url,
    startedAt,
    pluginVersion: state.version ?? null,
  }

  // 0600：带 token 的地址等同于一张临时通行证，不能让同机其它用户读到。
  const envText = [
    `pid=${record.pid}`,
    `host=${record.host}`,
    `port=${record.port}`,
    `url=${record.url}`,
    `started=${record.startedAt}`,
    '',
  ].join('\n')

  atomicWrite(paths.runtimeEnvFile, envText, 0o600)
  atomicWrite(paths.runtimeJsonFile, `${JSON.stringify(record, null, 2)}\n`, 0o600)

  return { envFile: paths.runtimeEnvFile, jsonFile: paths.runtimeJsonFile }
}

/**
 * 清理运行时状态。
 *
 * 只有当文件里记录的 pid 就是自己（或调用方显式指定 `force`）时才删除，
 * 避免「新进程刚写完、旧进程退出时顺手删掉」的竞态。
 *
 * @param {ReturnType<import('./paths.js').resolvePaths>} paths
 * @param {{ pid?: number, force?: boolean }} [options]
 * @returns {boolean} 是否真的删除了。
 */
export function clearRuntime(paths, options = {}) {
  const { pid, force = false } = options
  if (!force && typeof pid === 'number') {
    const current = readRuntime(paths)
    if (current && current.pid !== pid) return false
  }
  let removed = false
  for (const file of [paths.runtimeEnvFile, paths.runtimeJsonFile]) {
    try {
      fs.rmSync(file)
      removed = true
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        // 清理失败不该影响主流程。
      }
    }
  }
  return removed
}

/**
 * 读取运行时状态。
 *
 * @param {ReturnType<import('./paths.js').resolvePaths>} paths
 * @returns {{ pid: number, host: string, port: number, url: string, startedAt: string, pluginVersion: string|null } | null}
 */
export function readRuntime(paths) {
  let text
  try {
    text = fs.readFileSync(paths.runtimeJsonFile, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 判断运行时状态是否仍然「新鲜」：记录的进程还活着，且端口与预期一致。
 *
 * @param {ReturnType<import('./paths.js').resolvePaths>} paths
 * @param {{ port?: number }} [expect]
 * @returns {{ fresh: boolean, record: object | null, reason: string }}
 */
export function inspectRuntime(paths, expect = {}) {
  const record = readRuntime(paths)
  if (!record) return { fresh: false, record: null, reason: '没有运行时状态文件' }

  if (typeof record.pid !== 'number') {
    return { fresh: false, record, reason: '运行时状态缺少进程号' }
  }
  if (!isProcessAlive(record.pid)) {
    return { fresh: false, record, reason: `记录的进程 ${record.pid} 已不存在（陈旧状态）` }
  }
  if (expect.port !== undefined && record.port !== expect.port) {
    return { fresh: false, record, reason: `记录的端口 ${record.port} 与预期 ${expect.port} 不符` }
  }
  return { fresh: true, record, reason: 'ok' }
}

/** 进程是否存活（信号 0 探测）。 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但不属于当前用户 —— 仍算存活。
    return Boolean(error && error.code === 'EPERM')
  }

  // 信号探测成功说明 pid 还在进程表里，但**僵尸进程**（已退出、等父进程回收）
  // 也在表里。对我们来说僵尸不算「还在跑」——否则停止服务时会一直等一个永远
  // 不会消失的 pid，最后误判成「SIGKILL 之后仍然存在」。
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (stat.slice(close + 2, close + 3) === 'Z') return false
  } catch {
    // 非 Linux 或读不到 /proc：按「存活」处理（保守）。
  }
  return true
}

/**
 * 探测某个回环端口上是否有人在监听。
 *
 * 诊断时用得上：运行时文件不存在**不等于**服务没在跑 —— 服务可能是从终端启动的，
 * 或者启动时插件还没装。只看文件会把这种情况误报成「没有服务」。
 *
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function probePort(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }

    const socket = net.connect({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function atomicWrite(file, content, mode) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content, { mode })
  fs.renameSync(tmp, file)
  return path.dirname(file)
}
