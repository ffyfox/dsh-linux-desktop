#!/usr/bin/env node
/**
 * 把一个 profile 的插件依赖切到「刚从 tag 打出来的 tgz」。
 *
 * 为什么需要它：开发时插件以 `link:` 指进源码仓库，profile 跑的**就是**工作区 ——
 * 存一下文件浏览器里立刻变。要验证「发出去的那个版本到底能不能用」时，这个状态是
 * 不可信的：你看到的永远是未提交的改动。所以日常那套要指向制品而不是源码。
 *
 * 制品从哪来：pack-from-tag.mjs 从 tag 导出并逐文件核对。于是「日常那套跑的版本」
 * 与「npm 上那个版本」来自同一棵 tag 树，不可能再出现 0.4.1 那种 GitHub 与 npm
 * 内容不同的事。
 *
 * 用法：node scripts/snapshot.mjs --profile <名字>
 *
 * `--profile` 刻意**没有默认值**：默认值意味着敲错一次就可能把日常在用的那套指到
 * 一个临时快照上，而这里改的是真实 profile 的 package.json。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { packFromTag } from './pack-from-tag.mjs'
import { REPO_ROOT } from './shipped-paths.mjs'

const ROOT = REPO_ROOT
const PACKAGE_NAME = 'dsh-linux-integration'

/**
 * 在依赖表里找出「指向本包」的那一项，返回键名；一个都没命中返回 null；命中多个抛错。
 *
 * 三种命中方式对应本项目真实出现过的三种写法：
 *   - 键等于包名            —— 依赖项名就是它，值随便是什么（含 registry 版本号）
 *   - `file:...dsh-linux-integration-<版本>.tgz` —— 指向一个本地快照
 *   - `link:...` 指向本仓库根目录 —— 开发时的链接安装
 *
 * 纯函数（只依赖入参），因为「命中 0 个 / 命中 1 个 / 命中多个」这三种分支都要测，
 * 而真去造三个 profile 太慢。
 *
 * `profileDir` 可选，只用于解析**相对**的 link 目标：相对路径的基准是 profile 目录
 * 而不是仓库，纯函数自己推不出来。绝对路径的 link 不需要它。
 */
export function findPackageDependency(deps, { packageName, repoRoot, profileDir } = {}) {
  const root = path.resolve(repoRoot)
  const hits = []

  for (const [key, value] of Object.entries(deps ?? {})) {
    if (key === packageName) {
      hits.push(key)
      continue
    }
    if (typeof value !== 'string') continue

    // `.*` 允许中间夹目录（file:./snapshots/dsh-linux-integration-1.2.3.tgz 也算）。
    if (/^file:.*dsh-linux-integration-.*\.tgz$/.test(value)) {
      hits.push(key)
      continue
    }

    if (value.startsWith('link:')) {
      const target = value.slice('link:'.length)
      if (target.length === 0) continue
      const resolved = path.isAbsolute(target)
        ? path.resolve(target)
        : path.resolve(profileDir ?? path.join(root, '..'), target)
      if (resolved === root) hits.push(key)
    }
  }

  if (hits.length > 1) {
    throw new Error(
      `有 ${hits.length} 个依赖项都指向本包（${hits.join('、')}），无法确定该改哪一个\n` +
        `      → 只保留一个：删掉多余的 ${PACKAGE_NAME} 依赖项再跑`,
    )
  }

  return hits[0] ?? null
}

/** 解析 `--profile <名字>`。名字限定成安全字符，免得手滑写成 `../../别的目录`。 */
function parseArgs(argv) {
  let profile = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') {
      profile = argv[index + 1] ?? null
      index += 1
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
    } else if (arg === '--help' || arg === '-h') {
      return { help: true }
    } else {
      throw new Error(`不认识的参数：${arg}`)
    }
  }

  if (!profile) {
    throw new Error(
      '必须指定 --profile <名字>（没有默认值：免得手滑把日常在用的那套指到临时快照上）',
    )
  }
  if (!/^[A-Za-z0-9._-]+$/.test(profile) || profile === '.' || profile === '..') {
    throw new Error(`profile 名字不合法：${profile}（只允许字母、数字、点、下划线、连字符）`)
  }

  return { profile }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n用法：node scripts/snapshot.mjs --profile <名字>\n`)
    process.exitCode = 2
    return
  }

  if (options.help) {
    process.stdout.write('用法：node scripts/snapshot.mjs --profile <名字>\n\n从 tag 打包，并把该 profile 的插件依赖指向这个 tgz。\n')
    return
  }

  const { profile } = options

  // DSH_HOME 优先，与 dsh 自己的推导一致；没设时是 ~/.dsh。
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  const profileDir = path.join(dshHome, 'profiles', profile)
  const profilePkgPath = path.join(profileDir, 'package.json')

  if (!fs.existsSync(profilePkgPath)) {
    process.stderr.write(
      `找不到 profile「${profile}」的 package.json：${profilePkgPath}\n` +
        `  → 先让这个 profile 存在（用 \`dsh --profile ${profile}\` 起一次），再跑本脚本\n`,
    )
    process.exitCode = 1
    return
  }

  try {
    process.stdout.write(`从 tag 打包（profile ${profile}）…\n`)
    const { tgz, sha1, tag } = packFromTag({
      root: ROOT,
      log: (line) => process.stdout.write(`  ${line}\n`),
    })
    process.stdout.write(`  已核对：包内容与 tag ${tag} 逐文件一致\n  sha1: ${sha1}\n`)

    const original = fs.readFileSync(profilePkgPath, 'utf8')
    const pkg = JSON.parse(original)
    const dependencies = pkg.dependencies ?? {}

    // 命中多个时 findPackageDependency 直接抛错，错误信息里已经写了怎么修，转述即可。
    const key = findPackageDependency(dependencies, { packageName: PACKAGE_NAME, repoRoot: ROOT, profileDir })

    if (!key) {
      throw new Error(
        `${profilePkgPath} 的 dependencies 里没有指向本包的依赖项\n` +
          `      → 在 dependencies 下加一行 "${PACKAGE_NAME}": "file:<某个 tgz>"（或用 link: 指向 ${ROOT}），再跑本脚本`,
      )
    }

    const previousValue = dependencies[key]
    dependencies[key] = `file:${tgz}`
    pkg.dependencies = dependencies

    // 原样保留其余内容：整个文件重新序列化，缩进跟该文件当前格式（2 空格）一致。
    fs.writeFileSync(profilePkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    process.stdout.write(`  已把 ${PACKAGE_NAME} 的依赖从 ${JSON.stringify(previousValue)} 改为 file:${tgz}\n`)

    try {
      // stdio: 'inherit' —— pnpm 的输出（拉包、链接、报错）要让用户直接看到，
      // 捕获再转述反而会丢掉进度条和失败细节。
      execFileSync('dsh', ['plugin', '--profile', profile, 'install'], {
        cwd: profileDir,
        stdio: 'inherit',
      })
    } catch (error) {
      // 安装失败时 profile 必须回到改动前的样子：留着一个指向临时快照的半成品
      // 依赖，下次启动会直接报模块找不到。
      fs.writeFileSync(profilePkgPath, original)
      // ENOENT 时 status 是 undefined，只报「退出码未知」会让人以为是 dsh 自己失败了，
      // 其实是 PATH 里根本没有 dsh。
      const reason = error.code === 'ENOENT' ? 'PATH 里找不到 dsh' : `退出码 ${error.status ?? '未知'}`
      throw new Error(
        `dsh plugin --profile ${profile} install 失败（${reason}）\n` +
          `      → 已把 ${profilePkgPath} 回滚成改动前的内容`,
      )
    }

    process.stdout.write(
      `\n完成。下一步：重启那一套（点桌面图标，或 \`dsh --profile ${profile}\`），让 ${tag} 的制品生效。\n`,
    )
  } catch (error) {
    process.stderr.write(`\n快照失败：\n${error.message}\n\n`)
    process.exitCode = 1
  }
}

// 只有直接执行才跑 CLI —— test/smoke.mjs 要 import findPackageDependency 做纯函数测试。
const INVOKED_DIRECTLY =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (INVOKED_DIRECTLY) main()
