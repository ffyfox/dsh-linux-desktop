#!/usr/bin/env node
/**
 * 发布前校验（由 `npm publish` 通过 `prepublishOnly` 自动触发）。
 *
 * 为什么需要它：`npm publish` 是不可逆的 —— 一旦发出去，同名同版本就永远不能
 * 再发第二次（npm 不允许覆盖已发布版本）。所以把「容易忘、忘了很尴尬」的检查
 * 全部前置到这里，让发布失败在本地而不是失败在 registry 上。
 *
 * 校验项：
 *   1. 必要文件齐全（LICENSE / README / CHANGELOG / cordis.patch.yml / bin 入口）
 *   2. package.json 的版本号与 CHANGELOG 最新条目一致
 *   3. repository.url 不是占位地址（占位地址发出去就是一个死链）
 *   4. cordis.patch.yml 引用的包名与 package.json 的 name 一致
 *   5. 冒烟测试全绿
 *   6. 打包产物里包含全部运行时文件
 *   7. README 卫生（没有残留占位符；指向 docs/ 的链接是绝对 URL；声明的用例数量与实际一致）
 *   8. 工作区干净（会进包的文件都已提交 —— npm 打包的是工作区，不是某个提交）
 *   9. 隐私指纹（本机路径 / 用户名 / 主机名 / 密钥 / 邮箱不出现在任何被跟踪文件里）
 *  10. tag 精确指向 HEAD（`--release` 模式下才是致命项，见下）
 *
 * 两个模式开关：
 *   --release     tag 必须精确指向 HEAD。`prepublishOnly` 与 `npm run release` 用它 ——
 *                 这条补的是一个真实漏口：从仓库根直接 `npm publish` 时，第 8 项会拦脏树，
 *                 但**不查 tag**，于是「工作区干净、tag 却指向别的提交」会被放行。
 *                 平时手动 `npm run check` 不加这个开关：那时候没有 tag 指向 HEAD 是
 *                 正常开发状态，不该拦你。
 *   --pre-commit  跳过两项**只在发布那一刻才有意义**的检查：第 6 项（打包产物完整性，
 *                 要起一次 npm）与第 8 项（工作区干净）。git pre-commit 钩子用它。
 *                 第 8 项必须跳过：钩子跑在提交**之前**，那一刻工作区理所当然不干净 ——
 *                 不跳过的话每次提交都会被自己拦下。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { tagForVersion, tagProblem } from './pack-from-tag.mjs'
import { shippedPaths } from './shipped-paths.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const FLAGS = new Set(process.argv.slice(2))
const RELEASE_MODE = FLAGS.has('--release')
const PRE_COMMIT_MODE = FLAGS.has('--pre-commit')

const problems = []
const notes = []

for (const flag of FLAGS) {
  if (flag !== '--release' && flag !== '--pre-commit') notes.push(`忽略了不认识的参数：${flag}`)
}

function fail(message, hint) {
  problems.push(hint ? `${message}\n      → ${hint}` : message)
}

function ok(message) {
  process.stdout.write(`  \u001B[32m✓\u001B[0m ${message}\n`)
}

process.stdout.write('\n\u001B[1m发布前校验\u001B[0m\n')

// ---- 1. 必要文件 ----------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const required = ['LICENSE', 'README.md', 'README.en.md', 'CHANGELOG.md', 'cordis.patch.yml']
for (const file of required) {
  if (fs.existsSync(path.join(ROOT, file))) ok(`${file} 存在`)
  else fail(`缺少必要文件：${file}`)
}

const binRel = pkg.bin?.['dsh-desktop']
if (binRel && fs.existsSync(path.join(ROOT, binRel))) ok(`bin 入口存在（${binRel}）`)
else fail(`bin 入口缺失：${binRel ?? '(package.json 未声明 bin)'}`)

// ---- 2. 版本号与 CHANGELOG 一致 -------------------------------------------
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
const firstVersion = /^##\s*\[([^\]]+)\]/m.exec(changelog)?.[1]
if (firstVersion === pkg.version) {
  ok(`版本号一致：${pkg.version}`)
} else {
  fail(
    `package.json 版本 ${pkg.version} 与 CHANGELOG 最新条目 ${firstVersion ?? '(未找到)'} 不一致`,
    '发版时两处都要改：package.json 的 version，以及 CHANGELOG 顶部新增一节',
  )
}

// ---- 3. repository 不是占位地址 -------------------------------------------
const repoUrl = pkg.repository?.url ?? ''
const PLACEHOLDER = /CHANGE-ME|github\.com\/example|your-?user|yourname|<.*>/i
if (repoUrl.length === 0) {
  fail('package.json 缺少 repository.url', 'npm 页面会没有源码链接；补上真实的 GitHub 地址')
} else if (PLACEHOLDER.test(repoUrl)) {
  fail(
    `repository.url 看起来还是占位地址：${repoUrl}`,
    '改成你真实的 GitHub 仓库地址，例如 git+https://github.com/<你的用户名>/dsh-linux-desktop.git',
  )
} else {
  ok(`repository 已填写：${repoUrl}`)
}

// ---- 4. cordis.patch.yml 引用的包名 ---------------------------------------
const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
if (patch.includes(`name: ${pkg.name}`)) ok(`cordis.patch.yml 引用了正确的包名：${pkg.name}`)
else fail(`cordis.patch.yml 里没有找到 "name: ${pkg.name}"`, '补丁行必须用安装后的包名引用，否则 Node 解析不到模块')

// ---- 5. 冒烟测试 ----------------------------------------------------------
// 注意：测试输出带 ANSI 颜色码，直接正则匹配「全部通过：48」会失败，
// 因为「全部通过」和「：」之间夹着 \u001B[0m。先剥掉颜色码再匹配。
const stripAnsi = (text) => text.replace(/\u001B\[[0-9;]*m/g, '')

// 真实用例总数。第 7 节拿它去核对两个 README —— 那个数字没有任何机制强制
// 同步，每加一条用例就会悄悄过期（本项目就曾在 README 上挂着「72 项」而实际
// 早已是三位数）。
//
// 取「用例共 N 项」而**不是**通过数：通过数会随宿主机有没有位图缩放工具、
// 有没有全局 dsh 而变化。本脚本第一次跑 CI 就栽在这上面 —— 本机 116、runner
// 上 115，于是发布前校验在 CI 上红了。用例总数才是跨环境稳定的那个数。
let measuredTestCount = null

try {
  const output = execFileSync(process.execPath, [path.join(ROOT, 'test/smoke.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  const summary = /用例共\s*(\d+)\s*项/.exec(stripAnsi(output))?.[1]
  if (summary) measuredTestCount = Number(summary)
  ok(`冒烟测试通过${summary ? `（用例共 ${summary} 项）` : ''}`)
} catch (error) {
  const output = stripAnsi(`${error.stdout ?? ''}${error.stderr ?? ''}`)
  const tail = output.split('\n').filter((line) => line.includes('✗')).slice(0, 8).join('\n      ')
  fail(`冒烟测试未通过${tail ? `\n      ${tail}` : ''}`, '先修好测试再发布')
}

// ---- 6. 打包产物完整性 ----------------------------------------------------
// 提交前模式跳过：这一项要起一次 npm，而且它关心的是「发布时会不会漏文件」——
// 提交前那一刻不需要知道。
if (PRE_COMMIT_MODE) {
  notes.push('跳过了「打包产物完整性」（提交前模式）')
} else {
  try {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    const parsed = JSON.parse(raw)
    // npm 的输出格式随版本变过：老版本是数组，新版本是以包名为键的对象。
    // 两种都兼容，免得升个 npm 就把发布卡住。
    const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
    const files = new Set((entry?.files ?? []).map((file) => file.path))
    const mustShip = [
      'package.json',
      'cordis.patch.yml',
      'bin/dsh-desktop.js',
      'src/index.js',
      'src/client.js',
      'src/settings.js',
      'src/installer.js',
      'src/cli.js',
      'src/assets/whale-girl.png',
      'src/assets/launcher.sh.tpl',
    ]
    const missing = mustShip.filter((file) => !files.has(file))
    if (missing.length === 0) {
      ok(`打包产物包含全部运行时文件（共 ${files.size} 个）`)
    } else {
      fail(
        `打包产物缺少运行时文件：${missing.join(', ')}`,
        '检查 package.json 的 files 字段是否覆盖了这些路径',
      )
    }
    notes.push(`打包体积约 ${Math.round((entry?.size ?? 0) / 1024)} kB，解包后约 ${Math.round((entry?.unpackedSize ?? 0) / 1024)} kB`)
  } catch (error) {
    fail(`无法获取打包清单：${error.message}`)
  }
}

// ---- 7. README 卫生 -------------------------------------------------------
// npm 页面显示的是发布那一刻的 README，所以两类问题一旦发出去就很难看：
//   1. 安装命令里残留占位符（用户照着敲会失败）
//   2. 指向 docs/ 的相对链接 —— docs/ 不在 files 白名单里，npm 上必然是死链
const PLACEHOLDER_IN_README = /你的用户名|<your-?user>|<owner>|<repo>|CHANGE-ME|yourname/i

for (const file of ['README.md', 'README.en.md']) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')

  const placeholder = PLACEHOLDER_IN_README.exec(text)
  if (placeholder) {
    const line = text.slice(0, placeholder.index).split('\n').length
    fail(
      `${file}:${line} 残留占位符「${placeholder[0]}」`,
      '安装命令里必须写真实的用户名/仓库名，否则用户照着敲会失败',
    )
  } else {
    ok(`${file} 没有残留占位符`)
  }

  const relativeDocs = /\]\((?:\.\.?\/)?docs\//.exec(text)
  if (relativeDocs) {
    const line = text.slice(0, relativeDocs.index).split('\n').length
    fail(
      `${file}:${line} 用了指向 docs/ 的相对链接`,
      'docs/ 不在 package.json 的 files 白名单里，不会被发布；改成 GitHub 的绝对 URL',
    )
  } else {
    ok(`${file} 的 docs/ 链接都是绝对 URL`)
  }

  // README 里声明的用例数量必须与实际一致。这个数字是纯手工维护的，
  // 加测试时最容易忘 —— 而它出现在公开仓库首页的开发小节里。
  // 非 Linux 平台会跳过依赖 Linux 的用例，数量天然更少，所以只在 Linux 上核对。
  // 只要求「冒烟测试」之后同一行里出现「数字 + 单位」，允许中间的措辞变化
  // （上一版把「用例共」写成硬编码，改个词就匹配不上了）。
  const claimedCount =
    file === 'README.md'
      ? /冒烟测试[^\d\n]{0,12}(\d+)\s*项/.exec(text)?.[1]
      : /smoke tests?[^\d\n]{0,12}(\d+)\s*checks?/i.exec(text)?.[1]

  if (process.platform !== 'linux') {
    notes.push(`${file} 的用例数量未核对（当前平台 ${process.platform} 会跳过依赖 Linux 的用例）`)
  } else if (!claimedCount) {
    fail(
      `${file} 没有写明冒烟测试的用例数量`,
      '开发小节里要写「冒烟测试，<N> 项」/「smoke tests, <N> checks」——不写就等于绕开本项校验',
    )
  } else if (measuredTestCount === null) {
    notes.push(`${file} 的用例数量未核对（没从测试输出里读到数量）`)
  } else if (Number(claimedCount) !== measuredTestCount) {
    fail(
      `${file} 写的用例数量是 ${claimedCount}，实际是 ${measuredTestCount}`,
      '加了用例就同步改这里 —— 要写用例总数，不是通过数',
    )
  } else {
    ok(`${file} 的用例数量与实际一致（${claimedCount} 项）`)
  }
}

// ---- 8. 工作区干净 --------------------------------------------------------
// `npm publish` 打包的是**工作区**，不是某个提交 —— 任何未提交的改动都会静悄悄
// 进包，而发布不可逆（同名同版本不能重发）。2026-09-25 真踩过一次：发布出去的
// 0.4.1 里 src/client.js 比 tag 多了一处未提交的本地改动，事后逐文件比对才发现。
//
// 只盯会进包的那些路径。未跟踪文件也算 —— 它们同样会被 `files` 白名单收进去。
//
// 路径清单从 package.json 的 `files` 推导（见 scripts/shipped-paths.mjs），
// 与 pack-from-tag.mjs 的状态校验共用同一份定义，免得两处漂移。
//
// 提交前模式必须跳过这一项：钩子跑在提交**之前**，那一刻工作区理所当然不干净
// （你要提交的东西就摆在那儿）。不跳过的话，每一次提交都会被这一项自己拦下来。
if (PRE_COMMIT_MODE) {
  notes.push('跳过了「工作区干净」（提交前模式：那一刻工作区本来就是脏的）')
} else {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', ...shippedPaths(ROOT)], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()
    if (dirty.length === 0) {
      ok('工作区干净（会进包的文件都已提交）')
    } else {
      const lines = dirty.split('\n')
      const shown = lines.slice(0, 8).join('\n      ')
      fail(
        `有未提交改动会被一起打进包（${lines.length} 处）：\n      ${shown}`,
        'npm publish 打包的是工作区而不是某个提交；先提交或撤销，再发布',
      )
    }
  } catch (error) {
    // 不是 git 仓库（例如从 tarball 里发布）时不阻塞，但要说清楚没检查。
    notes.push(`未检查工作区是否干净（git 不可用或不是 git 仓库：${error.code ?? error.message}）`)
  }
}

// ---- 9. 隐私指纹 ----------------------------------------------------------
// 由来：这个插件的开发、日常使用和发布都发生在同一台机器上，工作区里很容易
// 混进只有本机才看得懂的东西 —— 绝对路径、用户名、主机名、内网端点。而公开的
// GitHub 仓库会暴露**全部被跟踪文件**（npm 只发 files 白名单，是它的子集），
// 两者都不可逆。
//
// 分两层，因为它们的适用范围不同：
//
//   A. 环境身份指纹（家目录 / 用户名 / 主机名）—— **只在开发机上生效**。
//      指纹全部在运行时从环境推导，绝不写进仓库：否则这道闸门自己就成了泄露源。
//      CI 上必须跳过：那里的身份是临时的 `runner`，而仓库里本来就有 "runner"
//      这个英文词 —— 第一次跑 CI 就栽在这上面（7 处误报）。临时跑者的身份泄漏
//      不了任何东西，真正要盯的是开发者本人的机器。
//
//   B. 通用模式（绝对家目录路径 / 密钥 / 邮箱 …）—— **任何环境都生效**。
//      其中「绝对家目录路径」是 A 的兜底：它不依赖运行环境，所以即使在 CI 上，
//      `/home/<某人>/…` 这种真实路径照样会被拦下来。
const IN_CI = Boolean(process.env.CI) || Boolean(process.env.GITHUB_ACTIONS)

const PRIVACY_FINGERPRINTS = (() => {
  if (IN_CI) return []

  const collected = []
  const seen = new Set()
  const add = (label, value) => {
    const text = String(value ?? '').trim()
    // 短值做子串匹配会满屏误报，所以 4 个字符以下直接不盯。
    if (text.length < 4 || seen.has(text)) return
    seen.add(text)
    collected.push({ label, text })
  }

  add('家目录', os.homedir())
  add('$HOME', process.env.HOME)
  try {
    add('用户名', os.userInfo().username)
  } catch {
    /* 拿不到就跳过 */
  }
  add('$USER', process.env.USER)
  add('主机名', os.hostname())

  return collected
})()

/** 通用隐私 / 凭证模式。`allow` 命中时不算问题（GitHub 的 noreply 地址是刻意公开的）。 */
const PRIVACY_PATTERNS = [
  { label: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    label: '疑似密钥或令牌',
    re: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  },
  { label: '疑似 JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  // README 里的 `?token=...` 是占位符，够不到这里的长度门槛。
  { label: '疑似真实 launch token', re: /token=[A-Za-z0-9._-]{20,}/ },
  { label: '手机号', re: /(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])/ },
  {
    label: '本机绝对家目录路径',
    // 只认像真实账号名的段（≥3 个 ASCII 字符），所以文档里的占位符
    // `/home/<user>/…` 与示例 `/home/张三/…` 都不会误报。这条不依赖运行环境，
    // 因此在 CI 上也照常生效 —— 它是上面那组身份指纹的兜底。
    re: /(?:^|[^A-Za-z0-9])\/(?:home|Users)\/[A-Za-z0-9._-]{3,}\//,
  },
  {
    label: '邮箱地址',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    // 两类放行，都不是「真实邮箱」：
    //   - GitHub 的 noreply 地址（提交者身份，刻意公开）
    //   - RFC 2606 保留域 example.com/net/org —— 它们**按标准**不可能属于任何人，
    //     正是给文档和测试用的。不放行的话，测试里的假身份会逼着人写一个看着像
    //     真人的地址，那是往反方向推。
    allow: /@(?:users\.noreply\.github\.com|example\.(?:com|net|org))$/i,
  },
]

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const fingerprintRe = (text) => (text.length >= 6 ? escapeRe(text) : `\\b${escapeRe(text)}\\b`)

/**
 * 把命中值打码。
 *
 * 校验输出会进终端、CI 日志，也可能被贴进 issue —— 真扫到凭证时，**不能**把凭证
 * 本身再打印一遍，那等于换个地方泄露。只留前 4 个字符，定位靠文件:行号。
 */
const redact = (text) => (text.length <= 4 ? '****' : `${text.slice(0, 4)}****（已打码，共 ${text.length} 字符）`)

try {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    .split('\0')
    .filter(Boolean)

  const hits = []
  let scanned = 0

  for (const rel of tracked) {
    let buffer
    try {
      buffer = fs.readFileSync(path.join(ROOT, rel))
    } catch {
      continue
    }
    // 位图之类按二进制跳过 —— 它们既读不成行，也不可能"混进"文本指纹。
    if (buffer.subarray(0, 8000).includes(0)) continue
    scanned += 1

    const lines = buffer.toString('utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const where = `${rel}:${index + 1}`

      for (const { label, text } of PRIVACY_FINGERPRINTS) {
        if (new RegExp(fingerprintRe(text)).test(line)) {
          // 标签里**不能**带上指纹原文 —— 输出会进终端和 CI 日志，那等于把
          // 刚发现的东西换个地方再泄露一次。定位靠文件:行号。
          hits.push({ label, where, sample: text })
        }
      }

      for (const { label, re, allow } of PRIVACY_PATTERNS) {
        const matches = line.match(re)
        if (!matches) continue
        const real = matches.filter((match) => !(allow && allow.test(match)))
        if (real.length > 0) hits.push({ label, where, sample: real[0] })
      }
    }
  }

  if (hits.length === 0) {
    const watched = PRIVACY_FINGERPRINTS.map((item) => item.label).join('、')
    const scope = watched ? `${watched}、` : ''
    ok(`隐私指纹干净（扫了 ${scanned} 个被跟踪文件；盯着 ${scope}绝对家目录路径与密钥/邮箱模式）`)
    if (IN_CI) {
      notes.push('身份指纹（家目录 / 用户名 / 主机名）在 CI 上跳过 —— 那里是临时跑者；发布前的本地校验会盯它们')
    }
  } else {
    const shown = hits
      .slice(0, 8)
      .map((hit) => `${hit.where} — ${hit.label}：${redact(hit.sample)}`)
      .join('\n      ')
    fail(
      `有隐私指纹会被公开（${hits.length} 处）：\n      ${shown}`,
      '公开的 GitHub 仓库会暴露全部被跟踪文件；把这些内容挪出仓库或换成占位符再发布',
    )
  }
} catch (error) {
  notes.push(`未检查隐私指纹（git 不可用或不是 git 仓库：${error.code ?? error.message}）`)
}

// ---- 10. tag 精确指向 HEAD ------------------------------------------------
// 补的是这个漏口：从仓库根直接敲 `npm publish`（不带 tgz 参数）时，`prepublishOnly`
// 会跑到这里，第 8 项能拦住脏树，但**拦不住「工作区干净、tag 却指向别的提交」** ——
// 而那正是 0.4.1 事故的另一半（那次 tag 打在一个跟修复毫无关系的提交上）。
//
// 默认只当提示：平时 `npm run check` 的时候 HEAD 上本来就没有 tag，那是正常开发
// 状态，拦下来只会让人不再跑这个命令。`--release` 才升级成致命项。
try {
  let describedTag = null
  try {
    describedTag = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()
  } catch {
    // 没有精确 tag 时 git describe 以非零退出 —— 这是预期结果，不是命令故障。
    describedTag = null
  }

  const issue = tagProblem({ version: pkg.version, describedTag })
  if (!issue) {
    ok(`tag ${tagForVersion(pkg.version)} 精确指向 HEAD`)
  } else if (RELEASE_MODE) {
    fail(issue, 'tag 打在哪，发布出去的就是哪；先让 tag 指向当前提交再发布')
  } else {
    notes.push(`tag 未指向 HEAD（正式发布前必须解决）：${issue.split('\n')[0]}`)
  }
} catch (error) {
  notes.push(`未检查 tag 是否指向 HEAD（git 不可用：${error.code ?? error.message}）`)
}

// ---- 结论 ----------------------------------------------------------------
// 措辞随模式变：提交前模式说「可以发布」是误导 —— 它根本没检查那两件发布才关心的事。
const goal = PRE_COMMIT_MODE ? '提交' : '发布'

process.stdout.write('\n')
for (const note of notes) process.stdout.write(`  \u001B[2m· ${note}\u001B[0m\n`)

if (problems.length > 0) {
  process.stdout.write(`\n\u001B[31m发布前校验未通过（${problems.length} 项）\u001B[0m\n\n`)
  for (const problem of problems) process.stdout.write(`  \u001B[31m✗\u001B[0m ${problem}\n`)
  process.stdout.write(`\n修正后重新执行（目标：${goal}）。\n\n`)
  process.exit(1)
}

process.stdout.write(`\n\u001B[32m校验通过\u001B[0m，可以${goal}。\n\n`)
