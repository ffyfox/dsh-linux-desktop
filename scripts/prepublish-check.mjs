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
 *   7. README 卫生（没有残留占位符；指向 docs/ 的链接是绝对 URL）
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

try {
  const output = execFileSync(process.execPath, [path.join(ROOT, 'test/smoke.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  const summary = /全部通过[：:]\s*(\d+)/.exec(stripAnsi(output))?.[1]
  ok(`冒烟测试通过${summary ? `（${summary} 项）` : ''}`)
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
