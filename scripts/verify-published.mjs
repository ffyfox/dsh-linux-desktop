#!/usr/bin/env node
/**
 * 发布后核对：把 npm 上刚发出去的那个包，与本地 tag 逐文件比对。
 *
 * 为什么这一步不能省：发布前的一切检查都只能保证「我送出去的东西是对的」，
 * 保证不了「registry 上现在躺着的东西就是我送的那个」。2026-09-25 的 0.4.1 事故
 * 就是靠事后做这件事才发现的 —— 那次 npm 上的包比 tag 多了一个未提交的改动。
 *
 * 三件事：
 *   1. 从 registry 读该版本的 `dist.shasum`（npm 自己算的 sha1）；
 *   2. 下载 tarball，算它的 sha1，与上面比 —— 这一步能发现「传输出错 / 拿错文件」；
 *   3. 解包，与 `git show <tag>:<路径>` 逐字节比 —— 这一步才能发现「发布内容 != tag」。
 *
 * 用法：npm run verify:published [-- --version <版本>]
 *
 * 不带 `--version` 时核对 package.json 里的当前版本。带上的话可以核对任意已发布
 * 版本 —— 补做历史核对、或者刚 bump 完还想确认上一个版本没发错，都用得上。
 */

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { tagForVersion } from './pack-from-tag.mjs'
import { REPO_ROOT } from './shipped-paths.mjs'

const ROOT = REPO_ROOT
const REGISTRY = 'https://registry.npmjs.org'

/**
 * 解析 `[--version <版本>]`。不认识参数直接报错，免得手滑写错却当成默认值跑了。
 * @returns {{ version?: string }}
 */
export function parseVerifyArgs(argv) {
  let version
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--version') {
      const value = argv[index + 1]
      if (!value) throw new Error('--version 后面要跟一个版本号')
      version = value
      index += 1
    } else if (arg.startsWith('--version=')) {
      version = arg.slice('--version='.length)
    } else {
      throw new Error(`不认识的参数：${arg}`)
    }
  }
  return { version }
}

/** tarball 的规范地址。npm 的 tarball 路径规则是固定的，不用去 packument 里翻。 */
export function registryTarballUrl(packageName, version, registry = REGISTRY) {
  return `${registry}/${packageName}/-/${packageName}-${version}.tgz`
}

/**
 * 下载一个 URL 到文件。返回是否成功。
 *
 * 优先用 `curl`：Node 自己的 `fetch` 在本机默认的 `NODE_OPTIONS=--use-env-proxy`
 * 下会直接失败（实测 5 秒超时，去掉该变量 1 秒就返回），而 curl 走同一个代理没问题。
 * 没有 curl 时才退回 fetch。
 */
async function download(url, destination) {
  try {
    execFileSync('curl', ['-fsSL', '-m', '120', '-o', destination, url], { stdio: 'pipe' })
    return true
  } catch (error) {
    if (error.code !== 'ENOENT') return false
    // curl 不存在：退回 fetch。
    try {
      const response = await fetch(url)
      if (!response.ok) return false
      fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
      return true
    } catch {
      return false
    }
  }
}

/**
 * 取 packument（npm 的包元数据）。拿不到返回 null。
 *
 * 先读它有两个用处：一是拿到 `dist.shasum` 做比对，二是**先确认这个版本存在** ——
 * 否则一个根本不存在的版本号会让下面的下载重试白等五分钟（tarball 的 404 与
 * 「刚发布还没就绪」的 404 长得一模一样，只能靠元数据区分）。
 */
async function registryPackument(packageName) {
  const tmp = path.join(os.tmpdir(), `dsh-packument-${process.pid}.json`)
  try {
    if (!(await download(`${REGISTRY}/${packageName}`, tmp))) return null
    return JSON.parse(fs.readFileSync(tmp, 'utf8'))
  } catch {
    return null
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/**
 * 把 tgz 里每个文件与 `git show <tag>:<路径>` 逐字节比对。
 *
 * 走 Buffer 而不是 utf8：包里有 PNG，utf8 解码会把非法序列替换成 U+FFFD，
 * 两边的差异恰好会被这一步抹平，核对就白做了。
 *
 * @returns {{ files: string[], mismatched: string[], missing: string[] }}
 */
export function diffTarballAgainstTag({ tgz, root, tag }) {
  const listed = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const files = []
  const mismatched = []
  const missing = []

  for (const entry of listed) {
    if (entry.endsWith('/')) continue
    if (!entry.startsWith('package/')) {
      mismatched.push(`${entry}（不在 package/ 前缀下，无法定位对应源码）`)
      continue
    }
    const rel = entry.slice('package/'.length)
    files.push(rel)

    let fromTag
    try {
      fromTag = execFileSync('git', ['show', `${tag}:${rel}`], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      missing.push(rel)
      continue
    }

    const packed = execFileSync('tar', ['-xzOf', tgz, '--', entry], { maxBuffer: 64 * 1024 * 1024 })
    if (!fromTag.equals(packed)) mismatched.push(rel)
  }

  return { files, mismatched, missing }
}

async function main() {
  let requested
  try {
    requested = parseVerifyArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n用法：node scripts/verify-published.mjs [--version <版本>]\n`)
    process.exitCode = 2
    return
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const name = pkg.name
  const version = requested.version ?? pkg.version
  const tag = tagForVersion(version)
  const url = registryTarballUrl(name, version)

  if (requested.version && requested.version !== pkg.version) {
    process.stdout.write(`\n\u001B[2m· 核对的是 --version 指定的 ${version}，不是 package.json 里的 ${pkg.version}\u001B[0m\n`)
  }

  process.stdout.write(`\n\u001B[1m发布后核对\u001B[0m ${name}@${version} vs ${tag}\n`)
  process.stdout.write(`  ${url}\n\n`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-published-'))
  const tgz = path.join(tmpDir, `${name}-${version}.tgz`)

  try {
    // ---- 0. 先确认 registry 上真有这个版本。不存在就直接说清楚，别去等 tarball。
    const packument = await registryPackument(name)
    if (packument === null) {
      process.stdout.write('  · registry 元数据读不到（网络或代理问题），跳过「版本是否存在」这一查\n')
    } else if (!packument.versions?.[version]) {
      const published = Object.keys(packument.versions ?? {}).join(', ') || '（无）'
      process.stderr.write(
        `\n✗ registry 上没有 ${name}@${version}。已发布的版本：${published}\n` +
          `  latest 是 ${packument['dist-tags']?.latest ?? '(未知)'}\n\n`,
      )
      process.exitCode = 1
      return
    }

    // ---- 1. 下载。刚发布的包可能先 404 几分钟（npm 提示 "being processed"：
    //         元数据先上线、tarball 后到），所以这里要重试而不是一次就放弃。
    let downloaded = false
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      if (await download(url, tgz)) {
        downloaded = true
        break
      }
      process.stdout.write(`  tarball 还没就绪（第 ${attempt} 次），等 15 秒…\n`)
      await new Promise((resolve) => setTimeout(resolve, 15000))
    }
    if (!downloaded) {
      process.stderr.write('\n✗ 下载失败。刚发布时 tarball 可能要几分钟才出现，稍后再试。\n\n')
      process.exitCode = 1
      return
    }

    // ---- 2. sha1：与 npm 自己记的 dist.shasum 比
    const actual = crypto.createHash('sha1').update(fs.readFileSync(tgz)).digest('hex')
    const expected = packument?.versions?.[version]?.dist?.shasum ?? null
    if (expected === null) {
      process.stdout.write(`  · registry 里读不到 dist.shasum，跳过这一比（下载件 sha1 ${actual}）\n`)
    } else if (expected === actual) {
      process.stdout.write(`  \u001B[32m✓\u001B[0m sha1 与 registry 记录一致：${actual}\n`)
    } else {
      process.stderr.write(`  \u001B[31m✗\u001B[0m sha1 不一致！registry 记的是 ${expected}，下载到的是 ${actual}\n`)
      process.exitCode = 1
    }

    // ---- 3. 逐文件与 tag 比
    const { files, mismatched, missing } = diffTarballAgainstTag({ tgz, root: ROOT, tag })
    if (mismatched.length === 0 && missing.length === 0) {
      process.stdout.write(`  \u001B[32m✓\u001B[0m ${files.length} 个文件与 ${tag} 逐字节一致，不多不少\n`)
      process.stdout.write(`\n\u001B[32m发布 == tag，核对通过。\u001B[0m\n\n`)
    } else {
      if (mismatched.length > 0) {
        process.stderr.write(`  \u001B[31m✗\u001B[0m 与 ${tag} 内容不同：${mismatched.join(', ')}\n`)
      }
      if (missing.length > 0) {
        process.stderr.write(`  \u001B[31m✗\u001B[0m ${tag} 里找不到：${missing.join(', ')}\n`)
      }
      process.stderr.write(`\n\u001B[31m发布内容与 tag 不一致。\u001B[0m\n\n`)
      process.exitCode = 1
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

const INVOKED_DIRECTLY =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (INVOKED_DIRECTLY) main()
