#!/usr/bin/env node
/**
 * 从 tag 打包：对外制品只能从某个提交产出，不能从工作区产出。
 *
 * 为什么需要它 —— 2026-09-25 的事故：`npm publish` 打包的是**工作区**，一处未提交的
 * 本地改动（src/client.js 两行）被静悄悄发到了 npm，于是 GitHub 上的 v0.4.1 与 npm
 * 上的 0.4.1 内容不同；而那次的 tag 还打在一个跟该修复毫无关系的提交上。
 *
 * 已有的 prepublish-check 第 8 项只能「发现工作区脏就拒绝」，防不住「提交了却把 tag
 * 打错位置」—— 树是干净的，tag 却指向别的提交。所以这里换一条结构性路线：
 *
 *   1. 先要求 tag 精确指向 HEAD，且会进包的文件都已提交；
 *   2. 把 tag 指向的树 `git archive` 导出到临时目录；
 *   3. **在那个临时目录里**跑 `npm pack`（绝不在仓库根跑）；
 *   4. 把 tgz 里每个文件的字节与导出树逐个比对。
 *
 * 第 4 步是真正兜底的那道：无论 tag 打在哪、工作区什么样，只要产物和 tag 的树有一
 * 个字节不同，就打不出来。tag 打错位置这类错误在发布前一定会暴露。
 *
 * 用法：node scripts/pack-from-tag.mjs [--dest <目录>]
 */

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO_ROOT, shippedPaths } from './shipped-paths.mjs'

const ROOT = REPO_ROOT

/** tag 的命名规则只有这一处，避免 'v' 前缀在几个地方各写一遍。 */
export function tagForVersion(version) {
  return `v${version}`
}

/**
 * 只判「tag 是否精确指向 HEAD」，返回问题描述（null = 没问题）。
 *
 * 单独抽出来是因为它有两个调用方，而两边的**严重程度不同**：
 *   - packFromTag / `npm run release`：致命，直接拒绝出制品。
 *   - prepublish-check：默认只当提示（平时 `npm run check` 当然没有 tag 指向 HEAD，
 *     那是正常开发状态），只有 `--release` 模式（`prepublishOnly` 与
 *     `npm run release` 走的就是它）才升级成致命。
 *
 * 这条检查补的是一个真实的漏口：从仓库根直接敲 `npm publish` 时，`prepublishOnly`
 * 会查「工作区是否干净」，但**不查 tag** —— 于是「工作区干净、tag 却指向别的提交」
 * 会被放行，而那正是 0.4.1 事故的另一半。
 *
 * @param {{ version?: string, describedTag?: string | null }} options
 * @returns {string | null}
 */
export function tagProblem({ version, describedTag }) {
  if (!version) {
    return '读不到 package.json 的 version，无法确定该用哪个 tag\n      → 补上 version 字段再打包'
  }

  const tag = tagForVersion(version)
  const described = String(describedTag ?? '').trim()
  if (described === tag) return null

  // 分开报「没有 tag 指向 HEAD」和「HEAD 被别的 tag 指着」：前者的修法是打 tag，
  // 后者的修法是把 tag 挪过来 —— 两者要敲的命令不一样。
  return described
    ? `HEAD 没有落在 tag ${tag} 上：git describe --tags --exact-match HEAD 得到的是 ${described}\n` +
        `      → tag 打在哪，制品就来自哪。确认该发布的是哪个提交，再 git tag -f ${tag} <提交>`
    : `没有 tag 精确指向 HEAD（按版本号应为 ${tag}）\n` +
        `      → 在当前提交上打 ${tag} 再打包；tag 打错位置正是 0.4.1 那次事故的一半`
}

/**
 * 判断「现在这个状态能不能从 tag 出制品」，返回问题列表（空数组 = 没问题）。
 *
 * 刻意做成纯函数：测试要覆盖「脏工作区 / tag 不匹配 / tag 缺失」这几种情况，而造出
 * 真实的脏树、错 tag、缺 tag 需要动 git，慢且脆。把判断和取数分开，测试只喂字符串。
 *
 * 入参：
 *   version      package.json 里的版本号
 *   porcelain    `git status --porcelain -- <会进包的路径>` 的输出
 *   describedTag `git describe --tags --exact-match HEAD` 的输出（没有精确 tag 时为 null）
 *
 * 「tag 是否存在」不在这里判：那需要额外一次 `git rev-parse --verify`，而本函数的
 * 入参里没有它的位置。调用方（packFromTag）拿到 rev-parse 结果后自行补一条问题。
 */
export function verifyReleaseState({ version, porcelain, describedTag }) {
  // 没有版本号就推导不出 tag，脏树检查也就没有意义了（连要发哪个版本都不知道）。
  if (!version) return [tagProblem({ version, describedTag })]

  const problems = []

  const dirty = String(porcelain ?? '').trim()
  if (dirty.length > 0) {
    const lines = dirty.split('\n')
    const shown = lines.slice(0, 8).join('\n      ')
    problems.push(
      `会进包的文件有未提交改动（${lines.length} 处）：\n      ${shown}\n` +
        '      → 本脚本打包的是 tag 指向的提交，这些改动不在里面；' +
        '先把改动提交并把 tag 指过来，或者确认它们本就不该进包',
    )
  }

  const tagIssue = tagProblem({ version, describedTag })
  if (tagIssue) problems.push(tagIssue)

  return problems
}

/**
 * 推导快照目录的默认位置：`$XDG_DATA_HOME/dsh-lxi/snapshots`，
 * 没设 XDG_DATA_HOME 时退回 `$HOME/.local/share/...`。
 *
 * 按 src/paths.js 里 xdgDataHome 的规则推导，但**不 import 它** —— 那里掺了沙箱
 * 开关、profile 分家等运行时概念，而这个脚本只想要一个纯粹的 XDG 落点，耦合过去
 * 反而会让「快照放哪」随插件配置变化。
 */
function defaultDest(env = process.env) {
  const dataHome =
    env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() ? env.XDG_DATA_HOME : path.join(env.HOME || os.homedir(), '.local', 'share')
  return path.join(dataHome, 'dsh-lxi', 'snapshots')
}

const MAX_BUFFER = 64 * 1024 * 1024

/** 子进程失败时把原始输出一并带出 —— 只说「命令失败」等于让人自己去猜。 */
function commandFailure(command, args, error) {
  const raw = [error.stdout, error.stderr]
    .map((chunk) => (chunk == null ? '' : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)))
    .join('')
    .trim()
  const failure = new Error(
    `命令失败（退出码 ${error.status ?? '未知'}）：${command} ${args.join(' ')}${raw ? `\n${raw}` : ''}`,
  )
  failure.cause = error
  return failure
}

function runText(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
  } catch (error) {
    throw commandFailure(command, args, error)
  }
}

/**
 * 同 runText，但保留原始字节。
 *
 * 逐字节比对必须走 Buffer：包里有 PNG，它的字节不是合法 UTF-8，用 utf8 解码会把
 * 非法序列替换成 U+FFFD —— 两边的差异恰好会被这一步抹平，核对就白做了。
 */
function runBytes(command, args, options = {}) {
  try {
    return execFileSync(command, args, { maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  } catch (error) {
    throw commandFailure(command, args, error)
  }
}

/**
 * 从 tag 打包并核对，返回 `{ tgz, sha1, files, tag }`。
 *
 * 任何一步校验不过就 throw（错误信息里带可操作提示），临时目录一律在 finally 里清掉。
 *
 * @param {object} options
 * @param {string} [options.root]    仓库根目录，默认本脚本所在仓库
 * @param {string} [options.dest]    tgz 落地目录，默认 defaultDest()
 * @param {string} [options.version] 版本号，默认从 root/package.json 读
 * @param {(line: string) => void} [options.log] 进度输出通道
 */
export function packFromTag({ root, dest, version, log = () => {} } = {}) {
  const repoRoot = path.resolve(root ?? ROOT)
  const targetDest = path.resolve(dest ?? defaultDest())
  const targetVersion =
    version ?? JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
  const tag = tagForVersion(targetVersion)

  // ---- 1+2. 状态校验：先确认「要发的东西确实在 tag 里」 --------------------
  const porcelain = runText('git', ['status', '--porcelain', '--', ...shippedPaths(repoRoot)], { cwd: repoRoot })

  // 没有精确 tag 时 describe 以非零退出，这是**预期结果**而不是命令故障，
  // 所以这里吞掉异常、用 null 表示「没有 tag 指向 HEAD」，交给 verifyReleaseState 报。
  let describedTag = null
  try {
    describedTag = runText('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: repoRoot })
  } catch {
    describedTag = null
  }

  const problems = verifyReleaseState({ version: targetVersion, porcelain, describedTag })

  try {
    runText('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: repoRoot })
  } catch {
    problems.push(
      `tag ${tag} 不存在（refs/tags/${tag} 解析不到）\n` +
        `      → 先 git tag ${tag} 再打包；制品必须来自一个真实存在的 tag`,
    )
  }

  if (problems.length > 0) {
    throw new Error(`发布状态校验未通过（${problems.length} 项）：\n    ${problems.join('\n    ')}`)
  }

  // ---- 3. 把 tag 的树导出到临时目录 ---------------------------------------
  // 之后所有动作都在这个目录里做 —— 工作区长什么样都影响不到制品。
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-from-tag-'))
  try {
    const tree = path.join(stage, 'tree')
    fs.mkdirSync(tree)
    const tarball = path.join(stage, 'source.tar')

    // 用 git archive 的 --output 而不是把 tar 流到 stdout：二进制流经 Node 的
    // utf8 管道会被改写，而写文件这条路径完全绕开编码问题。
    runText('git', ['archive', '--format=tar', `--output=${tarball}`, tag], { cwd: repoRoot })
    runText('tar', ['-xf', tarball, '-C', tree])
    log(`已把 tag ${tag} 的源码树导出到临时目录`)

    // ---- 4. 在干净树里打包 ------------------------------------------------
    // 关键：cwd 是临时目录，不是仓库根。在仓库根跑 npm pack 正是 0.4.1 事故的成因。
    fs.mkdirSync(targetDest, { recursive: true })
    const raw = runText('npm', ['pack', '--pack-destination', targetDest, '--json'], { cwd: tree })

    // npm 的输出格式随版本变过：老版本是数组，新版本是以包名为键的对象。两种都兼容。
    const parsed = JSON.parse(raw)
    const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
    if (!entry?.filename) throw new Error(`npm pack 没有返回文件名，原始输出：\n${raw}`)

    const tgz = path.isAbsolute(entry.filename) ? entry.filename : path.resolve(targetDest, entry.filename)
    log(`已在干净树里执行 npm pack：${tgz}`)

    // ---- 5. 核对制品：tgz 里每个文件都必须与导出树逐字节相同 --------------
    const entries = runText('tar', ['-tzf', tgz])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    const files = []
    const mismatched = []
    const missing = []

    for (const entryName of entries) {
      if (entryName.endsWith('/')) continue // 目录条目没有内容可比
      if (!entryName.startsWith('package/')) {
        // npm 的 tgz 固定以 package/ 为前缀；不是的话说明打包方式变了，
        // 与其猜路径，不如直接报出来。
        mismatched.push(`${entryName}（不在 package/ 前缀下，无法定位对应源码）`)
        continue
      }

      const rel = entryName.slice('package/'.length)
      const sourcePath = path.join(tree, rel)

      let sourceBytes
      try {
        sourceBytes = fs.readFileSync(sourcePath)
      } catch {
        missing.push(rel)
        continue
      }

      const packedBytes = runBytes('tar', ['-xzOf', tgz, '--', entryName])
      if (!sourceBytes.equals(packedBytes)) mismatched.push(rel)
      files.push(rel)
    }

    if (missing.length > 0 || mismatched.length > 0) {
      const detail = [
        missing.length > 0 ? `导出树里找不到：${missing.join(', ')}` : '',
        mismatched.length > 0 ? `与导出树不一致：${mismatched.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n      ')
      throw new Error(
        `包内容与 tag ${tag} 不一致：\n      ${detail}\n      → 制品必须逐字节来自 tag；先查清这些文件为什么和 tag 的树不同`,
      )
    }

    const sha1 = crypto.createHash('sha1').update(fs.readFileSync(tgz)).digest('hex')
    return { tgz, sha1, files, tag }
  } finally {
    // 临时目录里有导出树和中间 tar，不清理会一直堆在 /tmp 里。
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** 解析 `[--dest <目录>]`。不认识的参数直接报错，免得手滑写错却当成默认值跑了。 */
function parseArgs(argv) {
  let dest
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dest') {
      const value = argv[index + 1]
      if (!value) throw new Error('--dest 后面要跟一个目录')
      dest = value
      index += 1
    } else if (arg.startsWith('--dest=')) {
      dest = arg.slice('--dest='.length)
    } else if (arg === '--help' || arg === '-h') {
      return { help: true }
    } else {
      throw new Error(`不认识的参数：${arg}`)
    }
  }
  return { dest }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n用法：node scripts/pack-from-tag.mjs [--dest <目录>]\n`)
    process.exitCode = 2
    return
  }

  if (options.help) {
    process.stdout.write('用法：node scripts/pack-from-tag.mjs [--dest <目录>]\n\n从当前版本号对应的 tag 打包并逐文件核对。\n')
    return
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const result = packFromTag({
      root: ROOT,
      dest: options.dest,
      version: pkg.version,
      log: (line) => process.stdout.write(`  ${line}\n`),
    })

    process.stdout.write(`${result.tgz}\n`)
    process.stdout.write(`sha1: ${result.sha1}\n`)
    process.stdout.write(`已核对：包内容与 tag ${result.tag} 逐文件一致\n`)
  } catch (error) {
    process.stderr.write(`\n打包失败：\n${error.message}\n\n`)
    process.exitCode = 1
  }
}

// 只有直接执行才跑 CLI：test/smoke.mjs 会 import 这个文件取那几个纯函数，
// 那时绝不能有任何副作用。
const INVOKED_DIRECTLY =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (INVOKED_DIRECTLY) main()
