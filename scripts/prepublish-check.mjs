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
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const problems = []
const notes = []

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
const SHIPPED_PATHS = [
  'src',
  'bin',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
]

try {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...SHIPPED_PATHS], {
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

// ---- 结论 ----------------------------------------------------------------
process.stdout.write('\n')
for (const note of notes) process.stdout.write(`  \u001B[2m· ${note}\u001B[0m\n`)

if (problems.length > 0) {
  process.stdout.write(`\n\u001B[31m发布前校验未通过（${problems.length} 项）\u001B[0m\n\n`)
  for (const problem of problems) process.stdout.write(`  \u001B[31m✗\u001B[0m ${problem}\n`)
  process.stdout.write('\n修正后重新执行 npm publish。\n\n')
  process.exit(1)
}

process.stdout.write(`\n\u001B[32m校验通过\u001B[0m，可以发布。\n\n`)
