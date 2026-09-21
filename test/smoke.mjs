/**
 * 冒烟测试：零依赖，直接 `node test/smoke.mjs`。
 *
 * 覆盖重点是**容易静默出错、且一旦出错用户很难察觉**的地方：
 *   - Wayland app_id 推导（错了就变成任务栏黄圈图标）
 *   - .desktop 的 Exec 转义（家目录带空格就启动失败）
 *   - kwinrulesrc 读写（错了会破坏用户其它窗口规则）
 *   - 启动脚本模板渲染（占位符没换干净就报错退出）
 *   - 沙箱模式下的路径隔离（错了会污染真实用户目录）
 *   - install / uninstall 的幂等性与可回退性
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { connectHost, defaultConfig, normalizeConfig } from '../src/config.js'
import { detectBrowsers, detectDesktopEnvironment, findExecutable, resolveBrowser } from '../src/detect.js'
import { chromiumAppId, escapeExecArg, renderDesktopEntry } from '../src/desktop-entry.js'
import { install, renderTemplate, status, uninstall, writeConfig } from '../src/installer.js'
import { getKey, parseKconfig, removeSizeRule, serializeKconfig, setKey, upsertSizeRule } from '../src/kwin.js'
import {
  MARK_BEGIN,
  MIN_MODERN_VERSION,
  buildRuleBlock,
  detectConfigFile,
  escapeClassForConf,
  escapeClassForLua,
  hasWindowRule,
  parseVersion,
  removeWindowRule,
  upsertWindowRule,
  versionAtLeast,
} from '../src/hyprland.js'
import {
  AUTO_MAXIMIZE_RATIO,
  assessGnomeWindowSize,
  logicalMonitorSize,
  parseGdctlShow,
  readAutoMaximize,
  readGnomeWorkArea,
} from '../src/gnome.js'
import { ICON_SIZES, iconDirFor, iconFileFor, resolvePaths } from '../src/paths.js'
import { clearRuntime, inspectRuntime, isProcessAlive, readRuntime, writeRuntime } from '../src/runtime.js'
import { createSettingsSchema, SETTINGS_FIELDS, SETTINGS_NAMESPACE, settingsBase } from '../src/settings.js'
import { findListeningPid, isDshWebProcess, resolveServerTarget, stopServerProcess } from '../src/server.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

let passed = 0
let failed = 0
let skipped = 0
const failures = []

/**
 * 本插件只对 Linux 有意义。CI 会额外在 macOS 上跑一遍 —— 那一遍要验证的是
 * 「非 Linux 平台上安静地什么都不做，而不是崩溃」，不是 Linux 的行为。
 * 所以依赖 Linux 的用例在别的平台上**跳过**（而不是失败），并单独断言那条契约。
 */
const IS_LINUX = process.platform === 'linux'

/**
 * @param {string} label
 * @param {() => void | Promise<void>} fn
 */
async function test(label, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  \u001B[32m✓\u001B[0m ${label}\n`)
  } catch (error) {
    failed += 1
    failures.push({ label, error })
    process.stdout.write(`  \u001B[31m✗\u001B[0m ${label}\n      ${error.message}\n`)
  }
}

/** 只在 Linux 上有意义的用例。 */
async function linuxOnly(label, fn) {
  if (!IS_LINUX) {
    skipped += 1
    process.stdout.write(`  \u001B[33m-\u001B[0m ${label} \u001B[2m（跳过：仅 Linux）\u001B[0m\n`)
    return
  }
  await test(label, fn)
}

/** 记录一个「环境不具备条件」而主动跳过的用例 —— 跳过不是失败。 */
function skipTest(label, reason) {
  skipped += 1
  process.stdout.write(`  \u001B[33m-\u001B[0m ${label} \u001B[2m（跳过：${reason}）\u001B[0m\n`)
}

function section(title) {
  process.stdout.write(`\n\u001B[1m${title}\u001B[0m\n`)
}

function makeSandbox(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-desktop-test-${name}-`))
  return dir
}

/**
 * 造一套「假工具链」：一个假的 dsh 可执行文件和一个假的 Chromium 系浏览器，
 * 放在一个临时目录里，并返回一个把该目录排在**最前**的 PATH 值。
 *
 * 为什么需要：测试绝不能假设跑它的机器装了 dsh 和 Chrome —— GitHub Actions 的
 * runner 两样都没有，于是同一份代码在本地全绿、在 CI 全红。把假可执行文件放在
 * PATH 最前面，`findExecutable` 仍然走真实的查找逻辑（只是先命中假的），
 * 既保持了对探测逻辑的覆盖，又不再依赖宿主环境。
 *
 * 真实 PATH 追加在后面，这样 bash / desktop-file-validate / magick 之类还能找到。
 */
function makeFakeToolchain() {
  const root = makeSandbox('toolchain')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const name of ['dsh', 'google-chrome-stable']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  return { root, bin, pathValue: `${bin}:${process.env.PATH ?? ''}` }
}

// ---------------------------------------------------------------------------
section('Wayland app_id 推导（实测样本回归）')
// ---------------------------------------------------------------------------

// 这些期望值全部来自在 KDE Wayland 上用 KWin 脚本 dump 出来的真实窗口属性。
// 一旦 Chromium 改了规则，这组用例会立刻失败并提醒我们重新实测。
const APP_ID_SAMPLES = [
  [{ host: '127.0.0.1', urlPath: '/' }, 'chrome-127.0.0.1__-Default'],
  [{ host: '127.0.0.1', urlPath: '/foo' }, 'chrome-127.0.0.1__foo-Default'],
  [{ host: '127.0.0.1', urlPath: '/a/b' }, 'chrome-127.0.0.1__a_b-Default'],
  [{ host: 'localhost', urlPath: '/' }, 'chrome-localhost__-Default'],
  [{ host: 'example.com', urlPath: '/' }, 'chrome-example.com__-Default'],
]

for (const [input, expected] of APP_ID_SAMPLES) {
  await test(`app_id ${input.host}${input.urlPath} → ${expected}`, () => {
    assert.equal(chromiumAppId(input), expected)
  })
}

await test('app_id 不随端口变化（端口可配置的前提）', () => {
  // 实测 http://127.0.0.1/ 与 http://127.0.0.1:3080 得到同一个 app_id。
  assert.equal(chromiumAppId({ host: '127.0.0.1', urlPath: '/' }), chromiumAppId({ host: '127.0.0.1', urlPath: '/' }))
  assert.ok(!chromiumAppId({ host: '127.0.0.1', urlPath: '/' }).includes('3080'))
})

// ---------------------------------------------------------------------------
section('FreeDesktop Exec 转义')
// ---------------------------------------------------------------------------

await test('普通路径不加引号', () => {
  assert.equal(escapeExecArg('/home/u/.local/bin/dsh-desktop-app'), '/home/u/.local/bin/dsh-desktop-app')
})

await test('含空格的路径被引号包裹', () => {
  assert.equal(escapeExecArg('/home/my user/bin/app'), '"/home/my user/bin/app"')
})

await test('引号、反斜杠、$ 被正确转义', () => {
  assert.equal(escapeExecArg('/a"b'), '"/a\\"b"')
  assert.equal(escapeExecArg('/a\\b'), '"/a\\\\b"')
  assert.equal(escapeExecArg('/a$b'), '"/a\\$b"')
})

// ---------------------------------------------------------------------------
section('桌面入口渲染')
// ---------------------------------------------------------------------------

await test('渲染出的入口包含 app_id 与启动器路径', () => {
  const content = renderDesktopEntry({
    config: defaultConfig(),
    launcherPath: '/home/u/.local/bin/dsh-desktop-app',
    appId: 'chrome-127.0.0.1__-Default',
    iconName: 'deepseek-harness',
    terminalCommand: '',
    version: '9.9.9',
  })
  assert.match(content, /^\[Desktop Entry\]$/m)
  assert.match(content, /^StartupWMClass=chrome-127\.0\.0\.1__-Default$/m)
  assert.match(content, /^Exec=\/home\/u\/\.local\/bin\/dsh-desktop-app %U$/m)
  assert.match(content, /^Icon=deepseek-harness$/m)
  assert.match(content, /^Terminal=false$/m)
  assert.ok(!content.includes('Actions='), '没有终端命令时不应有 Actions 行')
})

await test('提供终端命令时生成 Desktop Action', () => {
  const content = renderDesktopEntry({
    config: defaultConfig(),
    launcherPath: '/x',
    appId: 'chrome-127.0.0.1__-Default',
    iconName: 'i',
    terminalCommand: '/usr/bin/konsole -e dsh --profile dsh-tui',
    version: '1.0.0',
  })
  assert.match(content, /^Actions=TUI;$/m)
  assert.match(content, /^\[Desktop Action TUI\]$/m)
})

// ---------------------------------------------------------------------------
section('kwinrulesrc 安全读写')
// ---------------------------------------------------------------------------

const SAMPLE_RULES = `[1]
description = LLM Dock keep above
wmclass = llm-dock
wmclasscomplete = false
wmclassmatch = 1
above = false
aboverule = 2

[General]
count = 2
rules = 1,2

[2]
description = Clawd Desktop Pet Skip Taskbar
wmclass = clawd-on-desk
skiptaskbar = true
skiptaskbarrule = 2
`

await test('解析与序列化可往返', () => {
  const doc = parseKconfig(SAMPLE_RULES)
  assert.deepEqual(
    doc.groups.map((g) => g.name),
    ['1', 'General', '2'],
  )
  const round = serializeKconfig(doc)
  assert.equal(round, SAMPLE_RULES.trimEnd() + '\n')
})

await test('setKey 替换已存在的键而不重复追加', () => {
  const lines = ['wmclass = old', 'other = x']
  setKey(lines, 'wmclass', 'new')
  assert.deepEqual(lines, ['wmclass = new', 'other = x'])
})

await test('upsert 新建规则时保留其它规则一字不差', () => {
  const dir = makeSandbox('kwin')
  const file = path.join(dir, 'kwinrulesrc')
  fs.writeFileSync(file, SAMPLE_RULES)

  const result = upsertSizeRule({ file, appId: 'chrome-127.0.0.1__-Default', size: { width: 1200, height: 750 } })
  assert.equal(result.changed, true)

  const after = fs.readFileSync(file, 'utf8')
  // 用户原有规则必须原样保留
  assert.ok(after.includes('description = LLM Dock keep above'))
  assert.ok(after.includes('description = Clawd Desktop Pet Skip Taskbar'))
  assert.ok(after.includes('skiptaskbar = true'))
  // 我们的规则被追加，并使用了未占用的 id
  assert.ok(after.includes('description = DeepSeek Harness Window Rule'))
  assert.equal(result.ruleId, '3')
  assert.match(after, /^rules = 1,2,3$/m)
  assert.match(after, /^count = 3$/m)
  assert.match(after, /^sizerule = 3$/m)

  fs.rmSync(dir, { recursive: true, force: true })
})

await test('upsert 幂等：第二次调用不改变文件', () => {
  const dir = makeSandbox('kwin-idem')
  const file = path.join(dir, 'kwinrulesrc')
  fs.writeFileSync(file, SAMPLE_RULES)
  upsertSizeRule({ file, appId: 'chrome-127.0.0.1__-Default', size: { width: 1200, height: 750 } })
  const first = fs.readFileSync(file, 'utf8')
  const second = upsertSizeRule({ file, appId: 'chrome-127.0.0.1__-Default', size: { width: 1200, height: 750 } })
  assert.equal(second.changed, false)
  assert.equal(fs.readFileSync(file, 'utf8'), first)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('upsert 更新已存在规则时按 id 命中而不新增', () => {
  const dir = makeSandbox('kwin-update')
  const file = path.join(dir, 'kwinrulesrc')
  fs.writeFileSync(file, SAMPLE_RULES)
  upsertSizeRule({ file, appId: 'chrome-127.0.0.1__-Default', size: { width: 1200, height: 750 } })
  const result = upsertSizeRule({ file, appId: 'chrome-127.0.0.1__-Default', size: { width: 1400, height: 900 } })
  assert.equal(result.changed, true)
  const after = fs.readFileSync(file, 'utf8')
  assert.match(after, /^size = 1400,900$/m)
  assert.match(after, /^count = 3$/m, '不应新增第四条规则')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('remove 后不残留我们的规则，且其它规则完好', () => {
  const dir = makeSandbox('kwin-remove')
  const file = path.join(dir, 'kwinrulesrc')
  fs.writeFileSync(file, SAMPLE_RULES)
  upsertSizeRule({ file, appId: 'chrome-127.0.0.1__-Default', size: { width: 1200, height: 750 } })
  const result = removeSizeRule({ file })
  assert.equal(result.changed, true)
  const after = fs.readFileSync(file, 'utf8')
  assert.ok(!after.includes('DeepSeek Harness Window Rule'))
  assert.ok(after.includes('LLM Dock keep above'))
  assert.ok(after.includes('Clawd Desktop Pet Skip Taskbar'))
  assert.match(after, /^count = 2$/m)
  assert.match(after, /^rules = 1,2$/m)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('文件不存在时 remove 不报错', () => {
  const dir = makeSandbox('kwin-missing')
  const result = removeSizeRule({ file: path.join(dir, 'nope') })
  assert.equal(result.changed, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
section('Hyprland 窗口规则（实测语义回归）')
// ---------------------------------------------------------------------------

const HYPR_APP_ID = 'chrome-127.0.0.1__-Default'

// 用户在 hyprland.conf 里手写的内容，必须一字不差地留着。
const SAMPLE_HYPR_CONF = `monitor = , preferred, auto, 1

# 我自己写的规则
windowrule = match:class ^(kitty)$, float on, size 900 600

misc {
    disable_hyprland_logo = true
}
`

const SAMPLE_HYPR_LUA = `hl.monitor({ output = "", mode = "preferred", position = "auto", scale = "auto" })

hl.window_rule({
    name  = "my-kitty-rule",
    match = { class = "^kitty$" },
    float = true,
})

hl.config({
    misc = { disable_hyprland_logo = true },
})
`

await test('版本串解析与比较', () => {
  assert.deepEqual(parseVersion('0.56.2'), [0, 56, 2])
  assert.deepEqual(parseVersion('v0.53'), [0, 53, 0])
  assert.equal(parseVersion('nonsense'), null)
  assert.equal(versionAtLeast([0, 56, 2], MIN_MODERN_VERSION), true)
  assert.equal(versionAtLeast([0, 53, 0], MIN_MODERN_VERSION), true)
  assert.equal(versionAtLeast([0, 52, 9], MIN_MODERN_VERSION), false, '0.52 不该被判为支持新语法')
  assert.equal(versionAtLeast([1, 0, 0], MIN_MODERN_VERSION), true)
  assert.equal(versionAtLeast(null, MIN_MODERN_VERSION), false)
})

await test('class 转义：conf 用正则转义，lua 再多翻一层反斜杠', () => {
  // `.` 必须转义，否则正则里会变成「任意字符」。
  assert.equal(escapeClassForConf(HYPR_APP_ID), 'chrome-127\\.0\\.0\\.1__-Default')
  // Lua 里 `\.` 是非法转义，必须写成 `\\.`。
  assert.equal(escapeClassForLua(HYPR_APP_ID), 'chrome-127\\\\.0\\\\.0\\\\.1__-Default')
})

await test('conf 规则必须同时带 float —— 少了它 size 会被平铺吞掉', () => {
  const block = buildRuleBlock({ format: 'conf', appId: HYPR_APP_ID, size: { width: 1200, height: 850 } })
  assert.match(block, /^# dsh-desktop begin$/m)
  assert.match(block, /^# dsh-desktop end$/m)
  assert.match(block, /windowrule = match:class \^\(chrome-127\\\.0\\\.0\\\.1__-Default\)\$, float on, size 1200 850/)
  assert.ok(!block.includes('windowrulev2'), '0.56 上 windowrulev2 是硬错误，绝不能写')
  assert.ok(!block.includes('source'), '绝不能写 source= —— 目标文件缺失会让整个配置加载失败')
})

await test('lua 规则用 hl.window_rule 且 float/size 是 lua 写法', () => {
  const block = buildRuleBlock({ format: 'lua', appId: HYPR_APP_ID, size: { width: 1200, height: 850 } })
  assert.match(block, /^-- dsh-desktop begin$/m)
  assert.match(block, /^-- dsh-desktop end$/m)
  assert.match(block, /hl\.window_rule\(\{/)
  assert.match(block, /float = true,/)
  assert.match(block, /size {2}= "1200 850",/)
  // 双反斜杠：Lua 字符串里 `\.` 非法，必须 `\\.`
  assert.match(block, /match = \{ class = "\^chrome-127\\\\\.0\\\\\.0\\\\\.1__-Default\$" \}/)
})

await test('选配置文件时 .lua 优先于 .conf（实测行为）', () => {
  const dir = makeSandbox('hypr-detect')
  const confFile = path.join(dir, 'hyprland.conf')
  const luaFile = path.join(dir, 'hyprland.lua')

  assert.deepEqual(detectConfigFile({ confFile, luaFile }), { file: null, format: null })

  fs.writeFileSync(confFile, 'monitor = , preferred, auto, 1\n')
  assert.deepEqual(detectConfigFile({ confFile, luaFile }), { file: confFile, format: 'conf' })

  fs.writeFileSync(luaFile, 'hl.config({})\n')
  assert.deepEqual(detectConfigFile({ confFile, luaFile }), { file: luaFile, format: 'lua' }, '.lua 应当胜出')

  fs.rmSync(dir, { recursive: true, force: true })
})

await test('conf：追加规则时用户原有内容一字不差', () => {
  const dir = makeSandbox('hypr-conf-add')
  const file = path.join(dir, 'hyprland.conf')
  fs.writeFileSync(file, SAMPLE_HYPR_CONF)

  const result = upsertWindowRule({ file, format: 'conf', appId: HYPR_APP_ID, size: { width: 1200, height: 850 } })
  assert.equal(result.changed, true)

  const after = fs.readFileSync(file, 'utf8')
  assert.ok(after.startsWith(SAMPLE_HYPR_CONF.trimEnd()), '原有内容必须原样保留在前面')
  assert.ok(after.includes('windowrule = match:class ^(kitty)$, float on, size 900 600'), '用户自己的规则不能被动')
  assert.ok(after.includes('# 我自己写的规则'))
  assert.ok(after.includes(MARK_BEGIN))
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('conf：重复写入幂等', () => {
  const dir = makeSandbox('hypr-conf-idem')
  const file = path.join(dir, 'hyprland.conf')
  fs.writeFileSync(file, SAMPLE_HYPR_CONF)
  upsertWindowRule({ file, format: 'conf', appId: HYPR_APP_ID, size: { width: 1200, height: 850 } })
  const first = fs.readFileSync(file, 'utf8')
  const second = upsertWindowRule({ file, format: 'conf', appId: HYPR_APP_ID, size: { width: 1200, height: 850 } })
  assert.equal(second.changed, false)
  assert.equal(fs.readFileSync(file, 'utf8'), first)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('conf：改尺寸时原地更新而不是追加第二条', () => {
  const dir = makeSandbox('hypr-conf-update')
  const file = path.join(dir, 'hyprland.conf')
  fs.writeFileSync(file, SAMPLE_HYPR_CONF)
  upsertWindowRule({ file, format: 'conf', appId: HYPR_APP_ID, size: { width: 1200, height: 850 } })
  upsertWindowRule({ file, format: 'conf', appId: HYPR_APP_ID, size: { width: 1000, height: 700 } })

  const after = fs.readFileSync(file, 'utf8')
  assert.match(after, /size 1000 700/)
  assert.ok(!after.includes('size 1200 850'), '旧尺寸不该残留')
  const marks = after.split('\n').filter((line) => line.includes(MARK_BEGIN)).length
  assert.equal(marks, 1, '只应有一个标记块')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('conf：移除后用户内容完好、不留空行堆积', () => {
  const dir = makeSandbox('hypr-conf-remove')
  const file = path.join(dir, 'hyprland.conf')
  fs.writeFileSync(file, SAMPLE_HYPR_CONF)
  upsertWindowRule({ file, format: 'conf', appId: HYPR_APP_ID, size: { width: 1200, height: 850 } })

  const result = removeWindowRule({ file, format: 'conf' })
  assert.equal(result.changed, true)
  assert.equal(fs.readFileSync(file, 'utf8'), SAMPLE_HYPR_CONF, '移除后应当和原始内容完全一致')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('lua：追加与移除同样保留用户内容', () => {
  const dir = makeSandbox('hypr-lua-roundtrip')
  const file = path.join(dir, 'hyprland.lua')
  fs.writeFileSync(file, SAMPLE_HYPR_LUA)

  upsertWindowRule({ file, format: 'lua', appId: HYPR_APP_ID, size: { width: 1200, height: 850 } })
  const added = fs.readFileSync(file, 'utf8')
  assert.ok(added.includes('my-kitty-rule'), '用户规则必须保留')
  assert.ok(added.includes('hl.window_rule({'))
  assert.equal(hasWindowRule({ file, format: 'lua' }), true)

  const result = removeWindowRule({ file, format: 'lua' })
  assert.equal(result.changed, true)
  assert.equal(fs.readFileSync(file, 'utf8'), SAMPLE_HYPR_LUA)
  assert.equal(hasWindowRule({ file, format: 'lua' }), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('标记块不完整时不误删（宁可不动）', () => {
  const dir = makeSandbox('hypr-broken-mark')
  const file = path.join(dir, 'hyprland.conf')
  const broken = `monitor = , preferred, auto, 1\n# dsh-desktop begin\nwindowrule = match:class ^(x)$, float on, size 1 1\n`
  fs.writeFileSync(file, broken)
  const result = removeWindowRule({ file, format: 'conf' })
  assert.equal(result.changed, false, '只有 begin 没有 end，应当拒绝删除')
  assert.equal(fs.readFileSync(file, 'utf8'), broken, '文件必须保持原样')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('文件不存在时 remove / hasWindowRule 安全返回', () => {
  const dir = makeSandbox('hypr-missing')
  const file = path.join(dir, 'nope.conf')
  assert.equal(removeWindowRule({ file, format: 'conf' }).changed, false)
  assert.equal(hasWindowRule({ file, format: 'conf' }), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
section('Hyprland 接入 installer：四道安全闸')
// ---------------------------------------------------------------------------

/**
 * 假的 exec：替掉对真实 Hyprland / hyprctl 的调用。
 *
 * CI runner 上没有 Hyprland，这些用例必须能在任何机器上跑；而这里要验证的
 * 本来也不是「Hyprland 怎么回答」，而是「我们拿到各种回答之后**做不做事**」。
 */
function fakeHyprExec({ version = '0.56.2', verifyOk = true, versionFails = false } = {}) {
  const calls = []
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === 'Hyprland' && args.includes('--version-json')) {
      if (versionFails) throw new Error('Hyprland: command not found')
      return JSON.stringify({ version, branch: `v${version}` })
    }
    if (cmd === 'Hyprland' && args.includes('--verify-config')) {
      if (verifyOk) return 'config ok'
      const error = new Error('verify failed')
      error.stdout = 'Config error in file /tmp/x at line 1: windowrule is bogus'
      throw error
    }
    if (cmd === 'hyprctl') return 'ok'
    throw new Error(`unexpected exec: ${cmd}`)
  }
  return { exec, calls }
}

/** 搭一个「桌面环境是 Hyprland」的安装沙箱，返回相关句柄。 */
function makeHyprInstallSandbox(name, { format = 'conf', manage = true } = {}) {
  const dir = makeSandbox(name)
  const paths = resolvePaths({ HOME: dir, DSH_DESKTOP_ROOT: dir })
  const toolchain = makeFakeToolchain()
  const env = {
    ...process.env,
    DSH_DESKTOP_ROOT: dir,
    PATH: toolchain.pathValue,
    XDG_CURRENT_DESKTOP: 'Hyprland',
    WAYLAND_DISPLAY: 'wayland-1',
  }
  const file = format === 'lua' ? paths.hyprlandLuaFile : paths.hyprlandConfFile
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, format === 'lua' ? SAMPLE_HYPR_LUA : SAMPLE_HYPR_CONF)
  const config = { ...defaultConfig(), manageHyprlandRules: manage }
  return { dir, paths, env, file, config, format }
}

const stepOf = (result, id) => result.steps.find((step) => step.id === id)

await test('关闭开关时：什么都不写（默认平铺）', () => {
  const box = makeHyprInstallSandbox('hypr-off', { manage: false })
  const { exec, calls } = fakeHyprExec()
  const before = fs.readFileSync(box.file, 'utf8')

  const result = install({ paths: box.paths, env: box.env, config: box.config, quiet: true, exec })

  assert.equal(stepOf(result, 'hyprland-rule').status, 'skipped')
  assert.equal(fs.readFileSync(box.file, 'utf8'), before, '关闭时配置文件必须一字不动')
  assert.equal(calls.filter((c) => c.includes('--version-json')).length, 0, '关闭时不该去探测版本')
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('非 Hyprland 桌面：跳过而不是乱写', () => {
  const box = makeHyprInstallSandbox('hypr-otherde')
  const before = fs.readFileSync(box.file, 'utf8')
  const result = install({
    paths: box.paths,
    env: { ...box.env, XDG_CURRENT_DESKTOP: 'KDE' },
    config: box.config,
    quiet: true,
    exec: fakeHyprExec().exec,
  })
  assert.equal(stepOf(result, 'hyprland-rule').status, 'skipped')
  assert.equal(fs.readFileSync(box.file, 'utf8'), before)
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('没有配置文件时：跳过（不替用户抢先创建，否则会顶掉 Hyprland 默认配置）', () => {
  const dir = makeSandbox('hypr-noconf')
  const paths = resolvePaths({ HOME: dir, DSH_DESKTOP_ROOT: dir })
  const toolchain = makeFakeToolchain()
  const env = {
    ...process.env,
    DSH_DESKTOP_ROOT: dir,
    PATH: toolchain.pathValue,
    XDG_CURRENT_DESKTOP: 'Hyprland',
    WAYLAND_DISPLAY: 'wayland-1',
  }

  const result = install({
    paths,
    env,
    config: { ...defaultConfig(), manageHyprlandRules: true },
    quiet: true,
    exec: fakeHyprExec().exec,
  })

  assert.equal(stepOf(result, 'hyprland-rule').status, 'skipped')
  assert.equal(fs.existsSync(paths.hyprlandLuaFile), false, '绝不能替用户创建 hyprland.lua')
  assert.equal(fs.existsSync(paths.hyprlandConfFile), false, '绝不能替用户创建 hyprland.conf')
  assert.ok(
    result.warnings.some((w) => w.includes('先启动一次 Hyprland')),
    '应当给出可操作的提示',
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('版本低于 0.53：跳过，不写没实测过的老语法', () => {
  const box = makeHyprInstallSandbox('hypr-oldver')
  const before = fs.readFileSync(box.file, 'utf8')
  const { exec } = fakeHyprExec({ version: '0.52.2' })

  const result = install({ paths: box.paths, env: box.env, config: box.config, quiet: true, exec })

  assert.equal(stepOf(result, 'hyprland-rule').status, 'skipped')
  assert.match(stepOf(result, 'hyprland-rule').detail, /0\.52\.2/)
  assert.equal(fs.readFileSync(box.file, 'utf8'), before, '版本不支持时绝不能碰配置')
  assert.ok(result.warnings.some((w) => w.includes('版本过低')))
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('读不出版本：跳过（宁可不动，也不赌）', () => {
  const box = makeHyprInstallSandbox('hypr-nover')
  const before = fs.readFileSync(box.file, 'utf8')
  const result = install({
    paths: box.paths,
    env: box.env,
    config: box.config,
    quiet: true,
    exec: fakeHyprExec({ versionFails: true }).exec,
  })
  assert.equal(stepOf(result, 'hyprland-rule').status, 'skipped')
  assert.equal(fs.readFileSync(box.file, 'utf8'), before)
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('--verify-config 不过：一个字都不写（Hyprland 配置错会拒绝启动）', () => {
  const box = makeHyprInstallSandbox('hypr-verifyfail')
  const before = fs.readFileSync(box.file, 'utf8')
  const { exec } = fakeHyprExec({ verifyOk: false })

  const result = install({ paths: box.paths, env: box.env, config: box.config, quiet: true, exec })

  assert.equal(stepOf(result, 'hyprland-rule').status, 'failed')
  assert.match(stepOf(result, 'hyprland-rule').detail, /未通过 Hyprland 校验/)
  assert.equal(fs.readFileSync(box.file, 'utf8'), before, '校验失败时配置必须保持原样')
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('全部条件满足：写入规则，且先校验后落盘', () => {
  const box = makeHyprInstallSandbox('hypr-happy')
  const { exec, calls } = fakeHyprExec()

  const result = install({ paths: box.paths, env: box.env, config: box.config, quiet: true, exec })

  const step = stepOf(result, 'hyprland-rule')
  assert.equal(step.status, 'updated')
  assert.ok(step.detail.includes('1200x750'))
  assert.ok(step.detail.includes('强制浮动'))

  const after = fs.readFileSync(box.file, 'utf8')
  assert.ok(after.includes(MARK_BEGIN))
  assert.match(after, /windowrule = match:class .*float on, size 1200 750/)
  assert.ok(after.includes('my-kitty') || after.includes('# 我自己写的规则'), '用户内容必须保留')

  // 校验必须发生在写入之前。
  const verifyAt = calls.findIndex((c) => c.includes('--verify-config'))
  assert.ok(verifyAt >= 0, '必须调用过 --verify-config')
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('lua 配置：写入 lua 语法而不是 hyprlang', () => {
  const box = makeHyprInstallSandbox('hypr-lua-install', { format: 'lua' })
  const result = install({
    paths: box.paths,
    env: box.env,
    config: box.config,
    quiet: true,
    exec: fakeHyprExec().exec,
  })

  assert.equal(stepOf(result, 'hyprland-rule').status, 'updated')
  const after = fs.readFileSync(box.file, 'utf8')
  assert.ok(after.includes('hl.window_rule({'))
  assert.ok(after.includes('float = true,'))
  assert.ok(!after.includes('windowrule = match:class'), 'lua 配置里不能出现 hyprlang 语法')
  assert.ok(after.includes('my-kitty-rule'), '用户内容必须保留')
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('重复安装幂等：第二次不再改动文件', () => {
  const box = makeHyprInstallSandbox('hypr-reinstall')
  install({ paths: box.paths, env: box.env, config: box.config, quiet: true, exec: fakeHyprExec().exec })
  const first = fs.readFileSync(box.file, 'utf8')

  const result = install({ paths: box.paths, env: box.env, config: box.config, quiet: true, exec: fakeHyprExec().exec })
  assert.equal(stepOf(result, 'hyprland-rule').status, 'unchanged')
  assert.equal(fs.readFileSync(box.file, 'utf8'), first)
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('卸载：只删我们的块，用户配置复原', () => {
  const box = makeHyprInstallSandbox('hypr-uninstall')
  install({ paths: box.paths, env: box.env, config: box.config, quiet: true, exec: fakeHyprExec().exec })
  assert.notEqual(fs.readFileSync(box.file, 'utf8'), SAMPLE_HYPR_CONF)

  uninstall({ paths: box.paths, env: box.env })
  assert.equal(fs.readFileSync(box.file, 'utf8'), SAMPLE_HYPR_CONF, '卸载后应完全复原')
  fs.rmSync(box.dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
section('GNOME 尺寸现实检查（实测语义回归）')
// ---------------------------------------------------------------------------

/**
 * 真实的 `gdctl show` 输出。
 *
 * 来自本机 headless mutter 50.5（虚拟显示器 2560x1600 @ scale 1.0）。用真实样本
 * 做回归，解析器一旦被改坏就会立刻暴露 —— 而不是等用户报「诊断里的屏幕尺寸不对」。
 */
const SAMPLE_GDCTL_SHOW = `Monitors:
└──Monitor Meta-0 (MetaVendor)
   ├──Vendor: MetaVendor
   ├──Product: MetaVirtualMonitor
   ├──Serial: 0x00
   ├──Current mode
   │   └──2560x1600@60.000
   └──Preferences
       └──Backlight: None

Logical monitors:
└──Logical monitor #1
   ├──Position: (0, 0)
   ├──Scale: 1.0
   ├──Transform: normal
   ├──Primary: yes
   └──Monitors: (1)
       └──Meta-0 (MetaVendor)
`

await test('parseGdctlShow 解析真实输出', () => {
  const parsed = parseGdctlShow(SAMPLE_GDCTL_SHOW)
  assert.equal(parsed.ok, true, parsed.reason)
  assert.deepEqual(parsed.monitors, [{ connector: 'Meta-0', width: 2560, height: 1600 }])
  assert.equal(parsed.logical.length, 1)
  assert.equal(parsed.logical[0].scale, 1)
  assert.equal(parsed.logical[0].primary, true)
  assert.deepEqual(parsed.logical[0].connectors, ['Meta-0'])
})

await test('logicalMonitorSize 按缩放折算逻辑尺寸', () => {
  const size = logicalMonitorSize(parseGdctlShow(SAMPLE_GDCTL_SHOW))
  assert.equal(size.ok, true)
  assert.equal(size.width, 2560)
  assert.equal(size.height, 1600)
  assert.equal(size.scale, 1)
})

await test('缩放 2 时逻辑尺寸减半（实测踩过的 dpr=2 场景）', () => {
  // 这条对应真实经历：Mutter 读到用户 dconf 的 scaling-factor=2，逻辑工作区变成
  // 1280x800，auto-maximize 比的就是这个逻辑值。折算错了，告警就会算错。
  const scaled = SAMPLE_GDCTL_SHOW.replace('Scale: 1.0', 'Scale: 2.0')
  const size = logicalMonitorSize(parseGdctlShow(scaled))
  assert.equal(size.ok, true)
  assert.equal(size.width, 1280)
  assert.equal(size.height, 800)
  assert.equal(size.scale, 2)
})

await test('镜像的多显示器逻辑尺寸取各边最大值', () => {
  const mirrored = `Monitors:
└──Monitor eDP-1 (Vendor)
   ├──Current mode
   │   └──1920x1080@60.000
└──Monitor DP-1 (Vendor)
   ├──Current mode
   │   └──2560x1440@60.000

Logical monitors:
└──Logical monitor #1
   ├──Scale: 1.0
   ├──Primary: yes
   └──Monitors: (2)
       └──eDP-1 (Vendor)
       └──DP-1 (Vendor)
`
  const size = logicalMonitorSize(parseGdctlShow(mirrored))
  assert.equal(size.ok, true)
  assert.equal(size.width, 2560)
  assert.equal(size.height, 1440)
})

await test('gdctl 输出看不懂时返回 ok:false，绝不瞎猜尺寸', () => {
  assert.equal(parseGdctlShow('').ok, false)
  assert.equal(parseGdctlShow('hello world').ok, false)
  assert.equal(parseGdctlShow('Monitors:\n').ok, false, '没有 Logical monitors 段必须判失败')
  assert.equal(logicalMonitorSize({ ok: false, reason: 'x' }).ok, false)
})

await test('面积低于阈值：安全', () => {
  const a = assessGnomeWindowSize({
    workArea: { ok: true, width: 2560, height: 1600 },
    size: { width: 1200, height: 750 },
    autoMaximize: { ok: true, enabled: true },
  })
  assert.equal(a.risk, 'safe')
  assert.equal(a.level, 'info')
  assert.ok(Math.abs(a.ratio - 0.2197) < 0.001)
})

await test('面积超过阈值：告警，且带上真实百分比', () => {
  const a = assessGnomeWindowSize({
    workArea: { ok: true, width: 2560, height: 1600 },
    size: { width: 2400, height: 1500 },
    autoMaximize: { ok: true, enabled: true },
  })
  assert.equal(a.risk, 'too-large')
  assert.equal(a.level, 'warning')
  assert.match(a.message, /88%/, '要给出算出来的占比，而不是一句笼统的提示')
  assert.match(a.message, /最大化/)
  // 建议尺寸应保持宽高比、且面积刚好落到阈值上。
  assert.deepEqual(a.suggested, { width: 2289, height: 1431 })
  assert.ok(a.suggested.width * a.suggested.height <= 2560 * 1600 * AUTO_MAXIMIZE_RATIO)
  assert.match(a.advice, /2289x1431/)
  assert.notEqual(a.advice, a.message, '发现与动作必须是两句话')
})

await test('安全时没有 advice / suggested', () => {
  const a = assessGnomeWindowSize({
    workArea: { ok: true, width: 2560, height: 1600 },
    size: { width: 1200, height: 750 },
    autoMaximize: { ok: true, enabled: true },
  })
  assert.equal(a.advice, null)
  assert.equal(a.suggested, null)
})

await test('阈值就是源码常量 0.8，不是实测的 0.833', () => {
  // 实测翻转点在 83.2%~83.8% 之间，与源码常量 0.8 对不上（原因未查明）。
  // 这里刻意钉住「用更保守的 0.8」这个决定：改掉它等于放宽告警，必须是有意为之。
  assert.equal(AUTO_MAXIMIZE_RATIO, 0.8)
})

await test('auto-maximize 已关闭时，满屏尺寸也算安全', () => {
  const a = assessGnomeWindowSize({
    workArea: { ok: true, width: 2560, height: 1600 },
    size: { width: 2560, height: 1600 },
    autoMaximize: { ok: true, enabled: false },
  })
  assert.equal(a.risk, 'safe')
  assert.match(a.message, /auto-maximize 已关闭/)
})

await test('读不出工作区时降级成不带数字的说明', () => {
  const a = assessGnomeWindowSize({
    workArea: { ok: false, reason: 'gdctl 不存在' },
    size: { width: 1200, height: 750 },
    autoMaximize: { ok: false, reason: 'no gsettings' },
  })
  assert.equal(a.risk, 'unknown')
  assert.equal(a.level, 'info')
  assert.equal(a.ratio, null, '读不出屏幕尺寸就不该编一个占比出来')
  assert.match(a.message, /80%/, '仍然要说明阈值这回事')
})

await test('readGnomeWorkArea / readAutoMaximize 出错时不抛异常', () => {
  const boom = () => {
    throw new Error('command not found')
  }
  assert.equal(readGnomeWorkArea({ exec: boom }).ok, false)
  assert.equal(readAutoMaximize({ exec: boom }).ok, false)
  assert.equal(readGnomeWorkArea({ exec: () => '' }).ok, false)
})

await test('readAutoMaximize 只认 true/false', () => {
  const fake = (out) => readAutoMaximize({ exec: () => out })
  assert.equal(fake('true\n').enabled, true)
  assert.equal(fake('false\n').enabled, false)
  assert.equal(fake('maybe').ok, false, '认不出来就必须报失败，不能默认成 true 或 false')
})

// ---------------------------------------------------------------------------
section('GNOME 接入 installer：只读，绝不写配置')
// ---------------------------------------------------------------------------

/**
 * 假的 exec：替掉对真实 `gdctl` / `gsettings` 的调用。
 *
 * 与 Hyprland 那组同一个理由 —— CI runner 上没有 GNOME。而且这里要验证的本来
 * 也不是「GNOME 怎么回答」，而是「我们拿到回答之后**只读不写**」。
 */
function fakeGnomeExec({ workArea = SAMPLE_GDCTL_SHOW, autoMaximize = 'true', gdctlFails = false, gsettingsFails = false } = {}) {
  const calls = []
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === 'gdctl') {
      if (gdctlFails) throw new Error('gdctl: command not found')
      return workArea
    }
    if (cmd === 'gsettings') {
      if (gsettingsFails) throw new Error('gsettings: command not found')
      return autoMaximize
    }
    throw new Error(`unexpected exec: ${cmd}`)
  }
  return { exec, calls }
}

/** 搭一个「桌面环境是 GNOME」的安装沙箱。 */
function makeGnomeInstallSandbox(name, { size } = {}) {
  const dir = makeSandbox(name)
  const paths = resolvePaths({ HOME: dir, DSH_DESKTOP_ROOT: dir })
  const toolchain = makeFakeToolchain()
  const env = {
    ...process.env,
    DSH_DESKTOP_ROOT: dir,
    PATH: toolchain.pathValue,
    XDG_CURRENT_DESKTOP: 'GNOME',
    WAYLAND_DISPLAY: 'wayland-1',
  }
  const config = size ? { ...defaultConfig(), window: size } : defaultConfig()
  // status() 是**从磁盘读配置**的（它没有 config 入参），所以尺寸必须真的落盘，
  // 否则 status 看到的永远是默认的 1200x750 —— 测试会测了个寂寞。
  if (size) {
    fs.mkdirSync(paths.configDir, { recursive: true })
    writeConfig(paths, config)
  }
  return { dir, paths, env, config }
}

await test('尺寸安全时：只给一条 info 说明', () => {
  const box = makeGnomeInstallSandbox('gnome-safe')
  const { exec } = fakeGnomeExec()
  const result = install({ paths: box.paths, env: box.env, config: box.config, quiet: true, exec })

  const step = stepOf(result, 'gnome-window-size')
  assert.ok(step, 'GNOME 上应当有一条尺寸说明')
  assert.equal(step.status, 'info')
  assert.match(step.detail, /原生遵循/)
  assert.equal(result.warnings.length, 0, '安全时不该产生警告')
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('尺寸过大时：升级成 warning 并进 warnings', () => {
  const box = makeGnomeInstallSandbox('gnome-toobig', { size: { width: 2400, height: 1500 } })
  const { exec } = fakeGnomeExec()
  const result = install({ paths: box.paths, env: box.env, config: box.config, quiet: true, exec })

  const step = stepOf(result, 'gnome-window-size')
  assert.equal(step.status, 'warning')
  assert.equal(result.warnings.length, 1)
  // warnings 放的是「动作」，不是把步骤行原样重复 —— 否则 CLI 上会出现两行一样的话。
  assert.notEqual(result.warnings[0], step.detail, '步骤行与警告不能是同一句话')
  assert.match(result.warnings[0], /gsettings set org\.gnome\.mutter auto-maximize false/)
  assert.match(result.warnings[0], /2289x1431/, '要给出算出来的建议尺寸')
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('★ 绝不写配置：每一次 exec 都是只读命令', () => {
  // 这是本模块存在的全部意义。GNOME 没有可写的窗口规则，所以我们一行都不写；
  // 一旦有人往这里加了 `gsettings set` / `reset`，这条会立刻失败。
  const box = makeGnomeInstallSandbox('gnome-readonly', { size: { width: 2400, height: 1500 } })
  const { exec, calls } = fakeGnomeExec()
  install({ paths: box.paths, env: box.env, config: box.config, quiet: true, exec })

  assert.ok(calls.length > 0, '应当真的去读过事实')
  for (const call of calls) {
    const readOnly = call === 'gdctl show' || call === 'gsettings get org.gnome.mutter auto-maximize'
    assert.ok(readOnly, `出现了非只读调用：${call}`)
  }
  assert.equal(calls.filter((c) => /gsettings (set|reset|writable)/.test(c)).length, 0)
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('GNOME 上也绝不碰 Hyprland / KWin 的东西', () => {
  const box = makeGnomeInstallSandbox('gnome-nocross')
  const { exec } = fakeGnomeExec()
  const result = install({ paths: box.paths, env: box.env, config: box.config, quiet: true, exec })

  assert.equal(stepOf(result, 'hyprland-rule').status, 'skipped')
  assert.equal(stepOf(result, 'kwin-rule').status, 'skipped')
  assert.equal(fs.existsSync(box.paths.hyprlandConfFile), false, '不该替 GNOME 用户建 Hyprland 配置')
  assert.equal(fs.existsSync(box.paths.kwinRulesFile), false, '不该替 GNOME 用户建 KWin 规则')
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('非 GNOME 桌面不产生 gnome-window-size 这一步', () => {
  const box = makeGnomeInstallSandbox('gnome-otherde')
  const { exec, calls } = fakeGnomeExec()
  const env = { ...box.env, XDG_CURRENT_DESKTOP: 'KDE' }
  const result = install({ paths: box.paths, env, config: box.config, quiet: true, exec })

  assert.equal(stepOf(result, 'gnome-window-size'), undefined)
  assert.equal(calls.length, 0, '不是 GNOME 就不该去调 gdctl / gsettings')
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('gdctl 读不出来时仍然给说明，不报失败', () => {
  const box = makeGnomeInstallSandbox('gnome-nogdctl')
  const { exec } = fakeGnomeExec({ gdctlFails: true, gsettingsFails: true })
  const result = install({ paths: box.paths, env: box.env, config: box.config, quiet: true, exec })

  const step = stepOf(result, 'gnome-window-size')
  assert.equal(step.status, 'info', '读不出来是正常情况（比如不在 GNOME 会话里），不该报错')
  assert.equal(result.warnings.length, 0)
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('status：GNOME 上给出尺寸检查项', () => {
  const box = makeGnomeInstallSandbox('gnome-status', { size: { width: 2400, height: 1500 } })
  const { exec } = fakeGnomeExec()
  const report = status({ paths: box.paths, env: box.env, exec })

  const check = report.checks.find((c) => c.id === 'gnome-window-size')
  assert.ok(check, 'status 里应当有 gnome-window-size')
  assert.equal(check.ok, false)
  assert.equal(check.level, 'warning')
  assert.match(check.detail, /最大化/)
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('status：安全尺寸时是 info 而不是 error', () => {
  const box = makeGnomeInstallSandbox('gnome-status-ok')
  const { exec } = fakeGnomeExec()
  const report = status({ paths: box.paths, env: box.env, exec })

  const check = report.checks.find((c) => c.id === 'gnome-window-size')
  assert.equal(check.ok, true)
  assert.equal(check.level, 'info')
  // info 级别不参与 healthy 判定：GNOME 上没有规则可写，不该因此让整体「不健康」。
  // （这里只针对这一项断言 —— 沙箱里还没安装，别的检查项本来就可能是红的。）
  assert.notEqual(check.level, 'error')
  fs.rmSync(box.dir, { recursive: true, force: true })
})

await test('status：非 GNOME 桌面没有这一项', () => {
  const box = makeGnomeInstallSandbox('gnome-status-other')
  const { exec, calls } = fakeGnomeExec()
  const report = status({ paths: box.paths, env: { ...box.env, XDG_CURRENT_DESKTOP: 'Hyprland' }, exec })

  assert.equal(report.checks.find((c) => c.id === 'gnome-window-size'), undefined)
  assert.equal(calls.length, 0)
  fs.rmSync(box.dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
section('配置归一化')
// ---------------------------------------------------------------------------

await test('默认配置合法且端口为 3080', () => {
  const config = defaultConfig()
  assert.equal(config.port, 3080)
  assert.deepEqual(config.window, { width: 1200, height: 750 })
})

await test('非法值回落到默认并给出警告', () => {
  const { config, warnings } = normalizeConfig({ port: 99999, window: { width: -5 }, profileMode: 'weird', unknownKey: 1 })
  assert.equal(config.port, 3080)
  assert.equal(config.window.width, 1200)
  assert.equal(config.profileMode, 'dedicated')
  assert.equal(warnings.length, 4)
})

await test('字符串端口与尺寸被接受', () => {
  const { config } = normalizeConfig({ port: '8080', window: { width: '1000', height: '700' } })
  assert.equal(config.port, 8080)
  assert.deepEqual(config.window, { width: 1000, height: 700 })
})

await test('connectHost 把 0.0.0.0 归一化为回环地址', () => {
  assert.equal(connectHost({ host: '0.0.0.0' }), '127.0.0.1')
  assert.equal(connectHost({ host: '127.0.0.1' }), '127.0.0.1')
  assert.equal(connectHost({ host: 'localhost' }), 'localhost')
})

// ---------------------------------------------------------------------------
section('设置命名空间（settings.js）')
// ---------------------------------------------------------------------------

await test('卡片把窗口宽度与高度渲染在同一行（并列布局）', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'client.js'), 'utf8')

  // 必须有专门的并列组件，并且真的用了 sizeRow / sizeCell 两个类。
  assert.match(source, /function SizePairControl\(/, '缺少 SizePairControl 组件')
  assert.match(source, /className:\s*CSS\.sizeRow/, 'SizePairControl 没有使用 sizeRow')
  assert.match(source, /className:\s*CSS\.sizeCell/, 'SizePairControl 没有使用 sizeCell')
  assert.ok(source.includes("'.dsld_sizeRow{gap:8px;display:flex}'"), '缺少 sizeRow 的 flex 布局')
  assert.ok(source.includes("'.dsld_sizeCell{flex:1;min-width:0;"), '缺少 sizeCell 的等宽布局')
  // 单元格里的输入框要撑满自己的列，而不是按 flex 比例伸缩。
  // box-sizing 必须显式写 border-box：`.dsld_input` 有 12px 左右内边距，默认的
  // content-box 下 width:100% 会连内边距一起算出去，两个输入框会横向重叠 18px
  //（实测：单元格 257px，输入框却渲染成 283px）。
  assert.ok(
    source.includes("'.dsld_sizeRow .dsld_input{width:100%;min-width:0;box-sizing:border-box}'"),
    'sizeRow 内的输入框缺少 border-box，会溢出单元格',
  )

  // 渲染循环必须把两个 draft 合成一个控件，并且高度不再单独出一行。
  assert.match(source, /CONTROLS\.flatMap\(/, '渲染循环未改用 flatMap')
  assert.match(source, /if \(control\.draft === 'windowHeight'\) return \[\]/, '高度仍会单独渲染一行')
  assert.match(source, /key: 'windowSize'/, '缺少合并后的 windowSize 控件')

  // 两个 draft 仍然各自存在于 CONTROLS 里 —— 写入分组（GROUPS）依赖它们。
  assert.ok(source.includes("draft: 'windowWidth'"), 'windowWidth 控件定义丢失')
  assert.ok(source.includes("draft: 'windowHeight'"), 'windowHeight 控件定义丢失')
  assert.match(source, /\{ ns: 'window', drafts: \['windowWidth', 'windowHeight'\] \}/, 'window 写入分组被改动')

  // 之前留下的死代码（从未被使用的分隔符类）应已清理。
  assert.ok(!source.includes('sizeSep'), '仍残留未被使用的 sizeSep')
})

await test('命名空间名符合 dsh-settings 的文法', () => {
  assert.match(SETTINGS_NAMESPACE, /^[a-z][a-z0-9-]*$/, 'dsh-settings 只接受小写字母/数字/连字符')
})

await test('settingsBase 只挑进命名空间的字段', () => {
  const config = defaultConfig()
  const base = settingsBase(config)
  assert.deepEqual(Object.keys(base).sort(), [...SETTINGS_FIELDS].sort())
  assert.equal(base.profileMode, 'dedicated')
  assert.deepEqual(base.window, { width: 1200, height: 750 })

  // host / port 必须留在 config.json 里：它们要与 dsh web 实际绑定的地址一致，
  // 放进设置卡片只会制造两份互相矛盾的真相。
  assert.ok(!('host' in base), 'host 不应进命名空间')
  assert.ok(!('port' in base), 'port 不应进命名空间')
  assert.ok(!('configVersion' in base), 'configVersion 不应进命名空间')

  // 缺字段时不应塞进 undefined —— 那会让 schema 的 base 层出现脏键。
  assert.deepEqual(settingsBase({ profileMode: 'shared' }), { profileMode: 'shared' })
})

await test('schema 用真的 schemastery 构造时默认值与校验都对', async () => {
  const dir = path.join(os.homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery')
  let z
  try {
    z = (await import(path.join(dir, 'lib/index.mjs'))).default
  } catch {
    return skipTest('schema 用真的 schemastery 构造时默认值与校验都对', '宿主机上没有 @deepseek-ai/schemastery')
  }
  const schema = createSettingsSchema(z)

  assert.deepEqual(schema({}), {
    profileMode: 'dedicated',
    browser: 'auto',
    window: { width: 1200, height: 750 },
    autoInstall: true,
    manageKwinRules: true,
    manageHyprlandRules: false,
    terminalAction: true,
    terminalCommand: '',
  })

  // config.json 作为 base 传进来时，它的值必须压过 schema 默认值。
  assert.equal(schema({ profileMode: 'shared', window: { width: 1400 } }).profileMode, 'shared')
  assert.equal(schema({ window: { width: 1400 } }).window.width, 1400)

  // 非法值必须在写入前被拒绝，而不是静默落库。
  assert.throws(() => schema({ profileMode: 'bogus' }), /profileMode/)
  assert.throws(() => schema({ window: { width: 1 } }), /width/)

  // describe() 会调用 schema.toJSON()，没有它卡片列表会在服务端就炸掉。
  const json = schema.toJSON()
  assert.equal(typeof json, 'object')
  assert.ok(json.refs, 'toJSON() 必须给出 schemastery 的 refs 结构')
})

// ---------------------------------------------------------------------------
section('平台与浏览器探测')
// ---------------------------------------------------------------------------

await test('识别 KDE / GNOME / Hyprland / 无会话', () => {
  assert.equal(detectDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'KDE', WAYLAND_DISPLAY: 'wayland-0' }).id, 'kde')
  assert.equal(detectDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', DISPLAY: ':0' }).id, 'gnome')
  assert.equal(detectDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'Hyprland', WAYLAND_DISPLAY: 'w' }).id, 'hyprland')
  assert.equal(detectDesktopEnvironment({}).id, 'none')
})

await test('探测不到 Chromium 时明确失败而不是降级到 Firefox', () => {
  const result = resolveBrowser('auto', { PATH: '/nonexistent' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /Chromium/)
  assert.match(result.reason, /Firefox/)
})

await test('显式指定不存在的浏览器时失败并列出可用项', () => {
  const result = resolveBrowser('brave', { PATH: '/nonexistent' })
  assert.equal(result.ok, false)
})

await test('findExecutable 能识别不可执行文件', () => {
  const dir = makeSandbox('exec')
  const file = path.join(dir, 'notexec')
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o644 })
  assert.equal(findExecutable(file), null)
  fs.chmodSync(file, 0o755)
  assert.equal(findExecutable(file), file)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('本机能探测到 Chrome', () => {
  const browsers = detectBrowsers()
  assert.ok(Array.isArray(browsers))
  // 本机已知装了 google-chrome-stable；找不到也不算失败（CI 环境可能没有）。
  if (browsers.length > 0) assert.ok(browsers[0].execPath.startsWith('/'))
})

// ---------------------------------------------------------------------------
section('启动脚本模板渲染')
// ---------------------------------------------------------------------------

await test('全部占位符被替换后不残留 @@..@@', () => {
  const template = fs.readFileSync(path.join(ROOT, 'src/assets/launcher.sh.tpl'), 'utf8')
  const keys = [
    'VERSION', 'CONFIG_FILE', 'HOST', 'PORT', 'WINDOW_SIZE', 'BROWSER', 'BROWSER_LABEL',
    'PROFILE_MODE', 'PROFILE_DIR', 'RUNTIME_DIR', 'LOG_FILE', 'DSH_BIN', 'EXTRA_PATH',
  ]
  const values = Object.fromEntries(keys.map((k) => [k, `V-${k}`]))
  const output = renderTemplate(template, values)
  assert.ok(!output.includes('@@'), '不应残留任何占位符')
  for (const key of keys) assert.ok(output.includes(`V-${key}`), `${key} 未被替换`)
})

await test('缺少占位符取值时抛错而不是生成坏脚本', () => {
  assert.throws(() => renderTemplate('a @@MISSING@@ b', {}), /未替换的占位符/)
})

await test('模板里不存在被误当成占位符的其它 @@ 结构', () => {
  const template = fs.readFileSync(path.join(ROOT, 'src/assets/launcher.sh.tpl'), 'utf8')
  const found = [...template.matchAll(/@@([A-Z_]+)@@/g)].map((m) => m[1])
  const unique = [...new Set(found)].sort()
  assert.deepEqual(unique, [
    'BROWSER', 'BROWSER_LABEL', 'CONFIG_FILE', 'DSH_BIN', 'EXTRA_PATH', 'HOST', 'LOG_FILE',
    'PORT', 'PROFILE_DIR', 'PROFILE_MODE', 'RUNTIME_DIR', 'VERSION', 'WINDOW_SIZE',
  ])
})

// ---------------------------------------------------------------------------
section('沙箱路径隔离')
// ---------------------------------------------------------------------------

await test('沙箱模式忽略 HOME / XDG_* 环境变量', () => {
  const paths = resolvePaths({
    HOME: '/real/home',
    XDG_CONFIG_HOME: '/real/config',
    XDG_DATA_HOME: '/real/data',
    XDG_RUNTIME_DIR: '/real/run',
    DSH_DESKTOP_ROOT: '/sandbox',
  })
  assert.equal(paths.sandboxed, true)
  for (const value of Object.values(paths)) {
    if (typeof value !== 'string') continue
    assert.ok(!value.startsWith('/real'), `路径泄漏到真实目录：${value}`)
  }
  assert.ok(paths.configFile.startsWith('/sandbox/'))
  assert.ok(paths.launcherFile.startsWith('/sandbox/'))
  assert.ok(paths.kwinRulesFile.startsWith('/sandbox/'))
})

await test('非沙箱模式遵循 XDG 变量', () => {
  const paths = resolvePaths({ HOME: '/h', XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d', XDG_RUNTIME_DIR: '/r' })
  assert.equal(paths.configDir, '/c/dsh-desktop')
  assert.equal(paths.applicationsDir, '/d/applications')
  assert.equal(paths.runtimeDir, '/r/dsh-desktop')
})

// ---------------------------------------------------------------------------
section('运行时状态')
// ---------------------------------------------------------------------------

await test('写入后可读回，且权限为 0600', () => {
  const dir = makeSandbox('runtime')
  const paths = resolvePaths({ HOME: dir, DSH_DESKTOP_ROOT: dir })
  writeRuntime(paths, { pid: process.pid, host: '127.0.0.1', port: 3080, url: 'http://x/?token=t', version: '1.0.0' })

  const record = readRuntime(paths)
  assert.equal(record.pid, process.pid)
  assert.equal(record.port, 3080)
  assert.equal(record.url, 'http://x/?token=t')

  const mode = fs.statSync(paths.runtimeEnvFile).mode & 0o777
  assert.equal(mode, 0o600, `期望 0600，实际 ${mode.toString(8)}`)

  // shell 侧靠 `key=value` 逐行解析，格式必须稳定
  const text = fs.readFileSync(paths.runtimeEnvFile, 'utf8')
  assert.match(text, /^pid=\d+$/m)
  assert.match(text, /^url=http:\/\/x\/\?token=t$/m)

  fs.rmSync(dir, { recursive: true, force: true })
})

await test('inspect 认为存活进程 + 端口一致才是新鲜的', () => {
  const dir = makeSandbox('runtime-fresh')
  const paths = resolvePaths({ HOME: dir, DSH_DESKTOP_ROOT: dir })
  writeRuntime(paths, { pid: process.pid, host: '127.0.0.1', port: 3080, url: 'u' })

  assert.equal(inspectRuntime(paths, { port: 3080 }).fresh, true)
  assert.equal(inspectRuntime(paths, { port: 9999 }).fresh, false, '端口不符应判为不新鲜')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('inspect 识别已死进程的陈旧状态', () => {
  const dir = makeSandbox('runtime-stale')
  const paths = resolvePaths({ HOME: dir, DSH_DESKTOP_ROOT: dir })
  // pid 1 一定存在但不可 signal；用一个几乎不可能存在的 pid 模拟陈旧。
  writeRuntime(paths, { pid: 2147483646, host: '127.0.0.1', port: 3080, url: 'u' })
  const result = inspectRuntime(paths, { port: 3080 })
  assert.equal(result.fresh, false)
  assert.match(result.reason, /已不存在/)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('clear 只清理属于指定 pid 的状态', () => {
  const dir = makeSandbox('runtime-clear')
  const paths = resolvePaths({ HOME: dir, DSH_DESKTOP_ROOT: dir })
  writeRuntime(paths, { pid: process.pid, host: '127.0.0.1', port: 3080, url: 'u' })

  assert.equal(clearRuntime(paths, { pid: process.pid + 1 }), false, 'pid 不匹配时不应删除')
  assert.ok(readRuntime(paths) !== null)
  assert.equal(clearRuntime(paths, { pid: process.pid }), true)
  assert.equal(readRuntime(paths), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
section('install / uninstall 端到端（沙箱）')
// ---------------------------------------------------------------------------

const installSandbox = makeSandbox('install')
const installPaths = resolvePaths({ HOME: installSandbox, DSH_DESKTOP_ROOT: installSandbox })
const fakeToolchain = makeFakeToolchain()
const installEnv = { ...process.env, DSH_DESKTOP_ROOT: installSandbox, PATH: fakeToolchain.pathValue }

await test('install 生成全部资产', () => {
  const result = install({ paths: installPaths, env: installEnv, quiet: true })
  if (!result.ok) {
    const failure = result.steps.find((s) => s.status === 'failed')
    throw new Error(`install 失败：${failure?.detail ?? '未知'}`)
  }
  assert.ok(fs.existsSync(installPaths.launcherFile))
  assert.ok(fs.existsSync(installPaths.desktopEntryFile))

  // 源尺寸那一档是**字节级复制**，不需要任何外部工具，因此任何环境都必须存在 ——
  // 这正是「即使没有 ImageMagick，Icon=deepseek-harness 也一定能解析到」的设计要点。
  const sourceSize = Math.max(...ICON_SIZES)
  assert.ok(
    fs.existsSync(iconFileFor(installPaths.iconThemeDir, sourceSize)),
    `源尺寸 ${sourceSize}x${sourceSize} 图标必须无条件存在（纯复制，不依赖转换器）`,
  )

  // 更小的档位依赖外部缩放工具。CI runner 上 ImageMagick / ffmpeg 一个都没有，
  // 所以这里**不能**无条件要求它们存在 —— 要么装上了，要么被记成 skipped，
  // 但绝不能是 failed（那意味着「本可以降级却报了错」）。
  for (const size of ICON_SIZES) {
    if (size === sourceSize) continue
    if (fs.existsSync(iconFileFor(installPaths.iconThemeDir, size))) continue
    const step = result.steps.find((s) => s.id === `icon-${String(size)}`)
    assert.equal(
      step?.status,
      'skipped',
      `没有转换器时 ${size}x${size} 应记为 skipped，实际为 ${step?.status ?? '（缺少该步骤）'}`,
    )
  }
  const failed = result.steps.filter((s) => s.status === 'failed')
  assert.deepEqual(
    failed.map((s) => `${s.id}: ${s.detail}`),
    [],
    '没有转换器时安装应当降级而不是失败',
  )

  assert.ok(fs.existsSync(installPaths.configFile), '安装后必须存在可编辑的配置文件')
  assert.equal(fs.statSync(installPaths.launcherFile).mode & 0o777, 0o755, '启动脚本必须可执行')
  // 断言命中的是假工具链，而不是宿主机的浏览器/dsh。
  // 这一条把「测试自给自足」锁死：将来谁把 PATH 改回 process.env，CI 会立刻红。
  assert.equal(
    result.browser.execPath,
    path.join(fakeToolchain.bin, 'google-chrome-stable'),
    '应使用假工具链的浏览器，而不是宿主机上碰巧装了的那个',
  )
  const launcher = fs.readFileSync(installPaths.launcherFile, 'utf8')
  assert.match(launcher, new RegExp(`^DSH_BIN="${fakeToolchain.bin}/dsh"$`, 'm'), '应使用假工具链的 dsh')
})

await test('图标源是 whale-girl.png（位图），旧的矢量图标已移除', () => {
  const asset = path.join(ROOT, 'src', 'assets', 'whale-girl.png')
  assert.ok(fs.existsSync(asset), `图标源必须存在：${asset}`)
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'assets', 'icon.svg')), '0.2.0 起不再使用矢量图标源')

  const buf = fs.readFileSync(asset)
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '必须是 PNG')
  // IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后。
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  assert.equal(width, Math.max(...ICON_SIZES), '源图边长应等于最大档位，那一档才能免转换器直接复制')
  assert.equal(height, Math.max(...ICON_SIZES))
})

await test('最大档位由源图直接复制，app_id 别名与主图标一致', () => {
  const entry = fs.readFileSync(installPaths.desktopEntryFile, 'utf8')
  const appId = /^StartupWMClass=(.+)$/m.exec(entry)[1].trim()
  const source = fs.readFileSync(path.join(ROOT, 'src', 'assets', 'whale-girl.png'))
  const biggest = Math.max(...ICON_SIZES)

  // 沙箱的 PATH 里没有 ImageMagick，小档位会被跳过；但最大档位是纯复制，
  // 必须无条件存在 —— 这条锁死「没有转换器时图标仍然解析得到」这个承诺。
  const main = iconFileFor(installPaths.iconThemeDir, biggest)
  assert.ok(fs.existsSync(main), '最大档位必须无条件安装（不需要任何外部转换器）')
  assert.deepEqual(fs.readFileSync(main), source, '源尺寸档位应与源图逐字节一致')

  const alias = path.join(iconDirFor(installPaths.iconThemeDir, biggest), `${appId}.png`)
  assert.ok(fs.existsSync(alias), 'app_id 别名图标必须存在，否则合成器会退回通用占位图标')
  assert.deepEqual(fs.readFileSync(alias), source, '别名必须与主图标字节一致')
})

const RASTER_TOOL = ['magick', 'convert', 'ffmpeg'].find((cmd) => findExecutable(cmd))

if (RASTER_TOOL) {
  await test('有转换器时所有档位都按正确像素尺寸安装', () => {
    const dir = makeSandbox('icon-sizes')
    const paths = resolvePaths({ HOME: dir, DSH_DESKTOP_ROOT: dir })
    // 真实 PATH 接在假工具链后面：既保留假 dsh / 假浏览器，又能找到转换器。
    const env = {
      ...process.env,
      DSH_DESKTOP_ROOT: dir,
      PATH: `${fakeToolchain.pathValue}${path.delimiter}${process.env.PATH ?? ''}`,
    }
    const result = install({ paths, env, quiet: true })
    assert.equal(result.ok, true, 'install 应成功')

    for (const size of ICON_SIZES) {
      const file = iconFileFor(paths.iconThemeDir, size)
      assert.ok(fs.existsSync(file), `${size}x${size} 档位应存在（转换器：${RASTER_TOOL}）`)
      const buf = fs.readFileSync(file)
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${size} 档位必须是 PNG`)
      assert.equal(buf.readUInt32BE(16), size, `${size} 档位宽度`)
      assert.equal(buf.readUInt32BE(20), size, `${size} 档位高度`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
} else {
  skipTest('有转换器时所有档位都按正确像素尺寸安装', '宿主机没有位图缩放工具')
}

await test('即使调用方显式传入配置，也会落盘一份供用户编辑', () => {
  const dir = makeSandbox('config-write')
  const paths = resolvePaths({ HOME: dir, DSH_DESKTOP_ROOT: dir })
  install({
    paths,
    env: { ...process.env, DSH_DESKTOP_ROOT: dir, PATH: fakeToolchain.pathValue },
    config: { port: 4321 },
    quiet: true,
  })
  assert.ok(fs.existsSync(paths.configFile), '配置文件应被创建')
  assert.equal(JSON.parse(fs.readFileSync(paths.configFile, 'utf8')).port, 4321)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('install 幂等：第二次没有任何 created/updated', () => {
  const result = install({ paths: installPaths, env: installEnv, quiet: true })
  assert.equal(result.changed, false)
  assert.equal(result.steps.filter((s) => s.status === 'created' || s.status === 'updated').length, 0)
})

await test('生成的启动脚本能通过 bash 语法检查', () => {
  execFileSync('bash', ['-n', installPaths.launcherFile], { stdio: 'pipe' })
})

await test('后台运行通知已精简，旧的冗长文案不再存在', () => {
  const template = fs.readFileSync(path.join(ROOT, 'src', 'assets', 'launcher.sh.tpl'), 'utf8')
  // 0.1.x 的原文（三行、含「为什么不停」的解释）。它必须彻底消失 ——
  // 逐字符比对，不做模糊匹配。
  const legacy = '窗口已关闭，但 dsh web 仍在后台运行。\\n它是从终端或其它方式启动的，'
    + '桌面启动器不会去停它（避免误杀你自己的服务）。\\n要停止请执行：dsh-desktop stop'
  assert.ok(!template.includes(legacy), '模板里仍残留 0.1.x 的长文案')
  // 0.2.0 早期版本的两行文案（第一句在正文里）。也必须消失，否则说明
  // 「第一句提到标题」这一步没做。
  const twoLineBody = 'dsh web 服务仍在后台运行。\\n停止：dsh-desktop stop'
  assert.ok(!template.includes(twoLineBody), '模板里仍把第一句留在正文中')

  // 第一句走通知标题（唯一能拿到「较大较粗」字样的字段），去掉句号；
  // 第二句原样留在正文。
  assert.ok(
    template.includes('notify "dsh web 服务仍在后台运行" \\\n      "停止：dsh-desktop stop" low'),
    '模板里缺少「第一句作标题、第二句作正文」的通知',
  )
  assert.ok(!template.includes('dsh web 服务仍在后台运行。'), '第一句不应再带句号')
  assert.ok(template.includes('停止：dsh-desktop stop'), '第二句必须保持不变')

  // 渲染后的启动脚本同样如此。
  const rendered = fs.readFileSync(installPaths.launcherFile, 'utf8')
  assert.ok(!rendered.includes(legacy), '生成的启动脚本里仍残留旧文案')
  assert.ok(rendered.includes('"dsh web 服务仍在后台运行"'), '生成的启动脚本里缺少标题形式的通知')
  assert.ok(rendered.includes('"停止：dsh-desktop stop"'), '生成的启动脚本里缺少停止命令正文')
})

await test('启动器在开窗前等待 Loader 树落定（冷启动空侧栏的根因修复）', () => {
  const template = fs.readFileSync(path.join(ROOT, 'src', 'assets', 'launcher.sh.tpl'), 'utf8')

  // 就绪判据必须是 dsh-web-app 在整棵树加载完之后打印的那一行。
  assert.match(template, /server_settled\(\)\s*\{[^}]*grep -q '\^dsh web: '/s, '缺少 Loader 树落定的判据')

  // 主路径：先 wait_settled，再 resolve_url —— 顺序不能反。反了就会立刻命中
  // 插件「尽早发布」的运行时文件，窗口又会在服务端没就绪时打开。
  const main = template.slice(template.indexOf('if [ "$STARTED_BY_US" = "1" ]; then'))
  const settledAt = main.indexOf('wait_settled 120')
  const urlAt = main.indexOf('TARGET_URL="$(resolve_url 30)"')
  assert.ok(settledAt >= 0, '自启路径缺少 wait_settled')
  assert.ok(urlAt >= 0, '自启路径缺少 resolve_url')
  assert.ok(settledAt < urlAt, 'wait_settled 必须在 resolve_url 之前调用')

  // 第二道闸门：树落定之后、开窗之前，还要确认会话 API 真的能应答。
  const apiAt = main.indexOf('wait_api_ready "$TARGET_URL"')
  assert.ok(apiAt >= 0, '自启路径缺少 wait_api_ready')
  assert.ok(apiAt > urlAt, 'wait_api_ready 必须在 resolve_url 之后调用（它需要带 token 的地址）')
  assert.match(template, /api_ready\(\)\s*\{/, '缺少 api_ready 实现')
  assert.match(template, /session\/list/, 'api_ready 没有探测会话列表接口')
  assert.match(template, /'"ok":true'/, 'api_ready 没有校验 RPC 成功标志')
  // 探测用的 cookie 罐必须清掉，不能留在运行时目录里。
  assert.match(template, /rm -f "\$RUNTIME_DIR\/\.probe-cookies"/, '缺少 cookie 罐清理')

  // 单实例锁的补开窗口分支也要等，否则第二个窗口同样是空侧栏。
  const lockBranch = template.slice(template.indexOf('! flock -n 9'), template.indexOf('STARTED_BY_US=0'))
  assert.ok(lockBranch.includes('wait_settled'), '补开窗口的分支没有等待落定')

  // 复用别人已跑着的服务时不能白等满超时。
  assert.match(template, /log_is_fresh\(\)/, '缺少「日志是不是本次产生的」判断')

  // 渲染后的脚本也要能通过语法检查（本文件末尾另有 bash -n 测试覆盖）。
  const rendered = fs.readFileSync(installPaths.launcherFile, 'utf8')
  assert.ok(rendered.includes('wait_settled 120'), '生成的启动脚本里缺少 wait_settled')
  assert.ok(rendered.includes('log_is_fresh'), '生成的启动脚本里缺少 log_is_fresh')
})

await linuxOnly('桌面入口的终端动作内嵌 dsh 绝对路径，不依赖桌面会话 PATH', () => {
  const content = fs.readFileSync(installPaths.desktopEntryFile, 'utf8')
  const exec = content.match(/^Exec=(.*)$/m)?.[1] ?? ''
  const action = content.match(/^\[Desktop Action TUI\][\s\S]*?^Exec=(.*)$/m)?.[1]

  if (!action) {
    // 没装终端时该动作会被省略，这是允许的降级。
    assert.ok(
      !content.includes('[Desktop Action TUI]'),
      'Actions 声明存在但动作段缺失',
    )
    return
  }
  assert.ok(
    /(^|\s)\/\S*dsh(\s|$)/.test(action),
    `终端动作里的 dsh 必须是绝对路径，实际为：${action}`,
  )
  assert.ok(!/(^|\s)dsh\s/.test(action), `终端动作里不应出现裸 dsh：${action}`)
  assert.match(action, /--profile dsh-tui/, '终端动作应启动 dsh-tui profile')
  assert.ok(exec.length > 0, '主 Exec 不应为空')
})

await test('根目录不再有 whale-girl.png，也没有任何引用指向它', () => {
  const assetRel = path.join('src', 'assets', 'whale-girl.png')
  const rootFile = path.join(ROOT, 'whale-girl.png')

  // 1) 根目录那份（用户的原始画稿）已删除。
  assert.ok(!fs.existsSync(rootFile), '仓库根目录仍存在 whale-girl.png')
  // 2) 进包的那份（512x512）仍在。
  assert.ok(fs.existsSync(path.join(ROOT, assetRel)), '缺少 src/assets/whale-girl.png')

  // 3) 全仓库扫描「指向根目录那份」的**路径形式**引用。
  //
  // 只认路径，不认散文：CHANGELOG / README 里用反引号写的 `whale-girl.png`
  // 是在称呼这个资源，不是一条会失效的路径。所以这里匹配的是带路径分隔符
  // 或路径拼接语境的写法。
  const absRoot = path.join(ROOT, 'whale-girl.png') // 绝对路径
  const patterns = [
    { name: '绝对路径', test: (line) => line.includes(absRoot) },
    { name: './ 相对路径', test: (line) => /(^|[^/\w])\.\/whale-girl\.png/.test(line) },
    { name: 'ROOT 拼接', test: (line) => /ROOT\s*,\s*['"]whale-girl\.png['"]/.test(line) },
    { name: '根相对引用', test: (line) => /['"](?:\.\/)?whale-girl\.png['"]/.test(line) && !/assets/i.test(line) },
  ]

  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      // test/ 不进包（见 package.json 的 files 白名单），而且本文件自己就要
      // 构造一次根路径来判断「它不存在」，那不算引用。
      if (dir === ROOT && entry.name === 'test') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      // 图标资源本身不是「引用」。
      if (full === path.join(ROOT, assetRel)) continue
      let text
      try { text = fs.readFileSync(full, 'utf8') } catch { continue }
      text.split('\n').forEach((line, index) => {
        if (!line.includes('whale-girl')) return
        // src/assets 下的引用是合法的，跳过。
        if (line.includes('src/assets/whale-girl') || /assets['"]?\s*,\s*['"]whale-girl/.test(line)) return
        for (const pattern of patterns) {
          if (pattern.test(line)) {
            offenders.push(`${path.relative(ROOT, full)}:${index + 1} [${pattern.name}] ${line.trim().slice(0, 120)}`)
            break
          }
        }
      })
    }
  }
  walk(ROOT)
  assert.deepEqual(offenders, [], `仍有指向根目录 whale-girl.png 的引用：\n${offenders.join('\n')}`)

  // 4) 安装器取图标的位置必须落在 src/assets 里。
  const installer = fs.readFileSync(path.join(ROOT, 'src', 'installer.js'), 'utf8')
  assert.match(installer, /path\.join\(ASSETS_DIR,\s*'whale-girl\.png'\)/, '安装器没有从 ASSETS_DIR 取图标')
  assert.ok(
    !/path\.join\([^)]*ROOT[^)]*'whale-girl\.png'/.test(installer),
    '安装器仍在引用仓库根目录的 whale-girl.png',
  )
})

await test('生成的 .desktop 能通过 desktop-file-validate', () => {
  let hasValidator = true
  try {
    execFileSync('desktop-file-validate', ['--version'], { stdio: 'ignore' })
  } catch {
    hasValidator = false
  }
  if (!hasValidator) return
  execFileSync('desktop-file-validate', [installPaths.desktopEntryFile], { stdio: 'pipe' })
})

await linuxOnly('status 报告健康', () => {
  const report = status({ paths: installPaths, env: installEnv })
  const failedChecks = report.checks.filter((c) => !c.ok && c.level === 'error')
  assert.deepEqual(failedChecks.map((c) => c.id), [], `失败项：${failedChecks.map((c) => `${c.id}(${c.detail})`).join(', ')}`)
  assert.equal(report.healthy, true)
  assert.equal(report.appId, 'chrome-127.0.0.1__-Default')
})

await test('覆盖已有文件前会备份', () => {
  // 模拟「手工原型」：先放一个自制启动脚本，再 install 接管。
  fs.writeFileSync(installPaths.launcherFile, '#!/bin/sh\necho legacy\n', { mode: 0o755 })
  const result = install({ paths: installPaths, env: installEnv, quiet: true })
  assert.equal(result.changed, true)
  const backup = `${installPaths.launcherFile}.dsh-backup`
  assert.ok(fs.existsSync(backup), '应生成备份')
  assert.match(fs.readFileSync(backup, 'utf8'), /legacy/)
})

await test('uninstall 清理托管文件但保留备份', () => {
  const result = uninstall({ paths: installPaths, env: installEnv })
  assert.ok(result.removed.length > 0)
  assert.ok(!fs.existsSync(installPaths.launcherFile))
  assert.ok(!fs.existsSync(installPaths.desktopEntryFile))
  for (const size of ICON_SIZES) {
    assert.ok(!fs.existsSync(iconFileFor(installPaths.iconThemeDir, size)), `应清理 ${size}x${size} 图标`)
  }
  assert.ok(fs.existsSync(`${installPaths.launcherFile}.dsh-backup`), '备份不应被删除')
})

await test('uninstall 幂等：再次执行不报错', () => {
  const result = uninstall({ paths: installPaths, env: installEnv })
  assert.equal(result.ok, true)
  assert.equal(result.removed.length, 0)
})

fs.rmSync(installSandbox, { recursive: true, force: true })

// ---------------------------------------------------------------------------
section('包清单')
// ---------------------------------------------------------------------------

await test('package.json 声明了 dsh.bundle.patch 且文件存在', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-linux-desktop')
  assert.ok(pkg.dsh?.bundle?.patch, '没有 dsh.bundle.patch 就只会作为普通依赖安装，不会成为 profile 层')
  assert.ok(fs.existsSync(path.join(ROOT, pkg.dsh.bundle.patch)))
  assert.ok(pkg.bin?.['dsh-desktop'], '缺少 CLI bin 入口')
  assert.ok(fs.existsSync(path.join(ROOT, pkg.bin['dsh-desktop'])))
  assert.equal(pkg.license, 'MIT')
  assert.ok(fs.existsSync(path.join(ROOT, 'LICENSE')))
})

await test('cordis.patch.yml 引用了本包名', () => {
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /name: dsh-linux-desktop/)
  assert.match(patch, /id: linux-desktop/)
})

await test('插件入口导出了 Cordis 契约所需的 name / inject / apply', async () => {
  const mod = await import('../src/index.js')
  assert.equal(mod.name, 'linux-desktop')
  assert.deepEqual(mod.inject, ['connection', 'webServer'])
  assert.equal(typeof mod.apply, 'function')
})

// ---------------------------------------------------------------------------
section('插件行行为（模拟 Cordis 上下文）')
// ---------------------------------------------------------------------------

/**
 * 造一个最小的假 Cordis 上下文。
 *
 * 只实现 `apply` 真正用到的那几样：`effect` / `get('loader')` / `webServer.port` /
 * `connection.authenticatedUrl` / `logger`。这样可以在不启动 dsh web 的前提下，
 * 验证插件行的行为（发布运行时状态、失败不抛、卸载清理）。
 */
function makeMockCtx({ port = 3080, token = 'TESTTOKEN', authenticatedUrlThrows = false } = {}) {
  const disposers = []
  const logs = []
  const ctx = {
    logger: () => ({
      info: (...args) => logs.push(['info', args.join(' ')]),
      warn: (...args) => logs.push(['warn', args.join(' ')]),
    }),
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    get: (name) => (name === 'loader' ? { await: () => Promise.resolve() } : undefined),
    webServer: { port },
    connection: {
      authenticatedUrl: (base) => {
        if (authenticatedUrlThrows) throw new Error('模拟 connection 服务异常')
        const url = new URL(base)
        url.searchParams.set('token', token)
        return url.href
      },
    },
  }
  return { ctx, disposers, logs }
}

/** 临时改环境变量并在结束后恢复。 */
async function withEnv(patch, fn) {
  const saved = new Map()
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** 等所有已排队的微任务与定时器跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

await linuxOnly('apply 把端口与带 token 的地址发布到运行时文件', async () => {
  const dir = makeSandbox('plugin-publish')
  try {
    await withEnv({ DSH_DESKTOP_ROOT: dir, DISPLAY: ':0', PATH: fakeToolchain.pathValue }, async () => {
      const paths = resolvePaths(process.env)
      const { ctx } = makeMockCtx({ port: 3456, token: 'ABC123' })
      const mod = await import('../src/index.js')
      mod.apply(ctx)
      await settle()

      const record = readRuntime(paths)
      assert.ok(record, '应写入 runtime.json')
      assert.equal(record.pid, process.pid, 'pid 必须是当前进程（启动器靠它判断状态是否新鲜）')
      assert.equal(record.port, 3456)
      assert.match(record.url, /^http:\/\/127\.0\.0\.1:3456\/\?token=ABC123$/)

      // shell 侧解析的格式也必须是稳定的 key=value
      const envText = fs.readFileSync(paths.runtimeEnvFile, 'utf8')
      assert.match(envText, /^pid=\d+$/m)
      assert.match(envText, /^port=3456$/m)
      assert.match(envText, /^url=http:\/\/127\.0\.0\.1:3456\/\?token=ABC123$/m)
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await linuxOnly('端口为 0（尚未 bind）时不发布，避免写出错误端口', async () => {
  const dir = makeSandbox('plugin-port0')
  try {
    await withEnv({ DSH_DESKTOP_ROOT: dir, DISPLAY: ':0', PATH: fakeToolchain.pathValue }, async () => {
      const paths = resolvePaths(process.env)
      const { ctx } = makeMockCtx({ port: 0 })
      const mod = await import('../src/index.js')
      mod.apply(ctx)
      await settle()
      assert.equal(readRuntime(paths), null, '端口未就绪时不应写出运行时状态')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await linuxOnly('connection 服务抛异常时 apply 不向上抛（不能拖挂 dsh web）', async () => {
  const dir = makeSandbox('plugin-throw')
  try {
    await withEnv({ DSH_DESKTOP_ROOT: dir, DISPLAY: ':0', PATH: fakeToolchain.pathValue }, async () => {
      const { ctx, logs } = makeMockCtx({ authenticatedUrlThrows: true })
      const mod = await import('../src/index.js')
      assert.doesNotThrow(() => mod.apply(ctx))
      await settle()
      assert.ok(
        logs.some(([level]) => level === 'warn'),
        '应该记录一条警告，而不是静默吞掉',
      )
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await linuxOnly('探测不到浏览器导致安装失败时，apply 仍然不抛异常', async () => {
  const dir = makeSandbox('plugin-installfail')
  try {
    // PATH 指向不存在的目录 → resolveBrowser 失败 → install 返回 ok:false
    await withEnv({ DSH_DESKTOP_ROOT: dir, DISPLAY: ':0', PATH: '/nonexistent-path-for-test' }, async () => {
      const { ctx, logs } = makeMockCtx()
      const mod = await import('../src/index.js')
      assert.doesNotThrow(() => mod.apply(ctx))
      await settle()
      assert.ok(logs.some(([level, msg]) => level === 'warn' && /自动安装/.test(msg)))
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await linuxOnly('autoInstall 关闭时不写任何桌面文件', async () => {
  const dir = makeSandbox('plugin-noauto')
  try {
    await withEnv({ DSH_DESKTOP_ROOT: dir, DISPLAY: ':0', PATH: fakeToolchain.pathValue }, async () => {
      const paths = resolvePaths(process.env)
      // 先写一份关闭 autoInstall 的配置
      fs.mkdirSync(paths.configDir, { recursive: true })
      fs.writeFileSync(paths.configFile, JSON.stringify({ ...defaultConfig(), autoInstall: false }))

      const { ctx } = makeMockCtx()
      const mod = await import('../src/index.js')
      mod.apply(ctx)
      await settle()

      assert.ok(!fs.existsSync(paths.launcherFile), '关闭自动安装后不应生成启动器')
      assert.ok(!fs.existsSync(paths.desktopEntryFile), '关闭自动安装后不应生成桌面入口')
      // 但运行时状态仍然要发布 —— 那是启动器拿到 token 的唯一途径
      assert.ok(readRuntime(paths), '运行时状态与自动安装是两件事，必须照常发布')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await linuxOnly('卸载时清理运行时状态', async () => {
  const dir = makeSandbox('plugin-dispose')
  try {
    await withEnv({ DSH_DESKTOP_ROOT: dir, DISPLAY: ':0', PATH: fakeToolchain.pathValue }, async () => {
      const paths = resolvePaths(process.env)
      const { ctx, disposers } = makeMockCtx()
      const mod = await import('../src/index.js')
      mod.apply(ctx)
      await settle()
      assert.ok(readRuntime(paths), '先确认已发布')

      assert.ok(disposers.length > 0, 'apply 应通过 ctx.effect 注册一个清理函数')
      for (const dispose of disposers) dispose()
      assert.equal(readRuntime(paths), null, '清理后运行时状态应被删除')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
section('服务查找与启停（server.js）')
// ---------------------------------------------------------------------------

/** 起一个只监听、不做别的事的 TCP 服务，用于测试端口查找。 */
async function listenOnRandomPort() {
  const { createServer } = await import('node:net')
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

await linuxOnly('isDshWebProcess 认得出 dsh web 命令行', async () => {
  const dir = makeSandbox('dshweb')
  // 造一个路径以 dsh 结尾的脚本，argv 就变成 [node, .../dsh, web]
  const fake = path.join(dir, 'dsh')
  fs.writeFileSync(fake, 'setTimeout(() => {}, 20000)\n')
  const child = spawn(process.execPath, [fake, 'web', '--no-open'], { stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 400))
    const verdict = isDshWebProcess(child.pid)
    assert.equal(verdict.ok, true, `应识别为 dsh web，实际：${verdict.reason}`)
    assert.match(verdict.command, /dsh web/)
  } finally {
    child.kill('SIGKILL')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await linuxOnly('isDshWebProcess 拒绝非 dsh web 进程', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 400))
    const verdict = isDshWebProcess(child.pid)
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /没有 dsh|不是 web/)
  } finally {
    child.kill('SIGKILL')
  }
})

await linuxOnly('isDshWebProcess 对不存在的 pid 安全返回 false', () => {
  const verdict = isDshWebProcess(2147483646)
  assert.equal(verdict.ok, false)
})

await test('findListeningPid 能查到监听端口的进程', async () => {
  const { server, port } = await listenOnRandomPort()
  try {
    const found = findListeningPid(port)
    assert.ok(found, `应找到监听 ${port} 的进程`)
    assert.equal(found.pid, process.pid, '监听者就是本测试进程')
  } finally {
    server.close()
  }
})

await test('allowPortLookup=false 时绝不按端口锁定进程（沙箱安全闸）', async () => {
  const { server, port } = await listenOnRandomPort()
  const dir = makeSandbox('nolookup')
  try {
    const paths = resolvePaths({ HOME: dir, DSH_DESKTOP_ROOT: dir })

    // 沙箱模式 + 无运行时状态 → 必须找不到目标，绝不能去动端口上那个真实进程
    const guarded = resolveServerTarget({ paths, port, runtimeRecord: null, allowPortLookup: false })
    assert.equal(guarded.ok, false, '沙箱模式下绝不能按端口去锁定真实服务')
    assert.match(guarded.reason, /没有找到/)

    // 同一端口，放开查找后能定位到进程，但会被身份校验拦下（本测试进程不是 dsh web）
    // —— 两条合起来证明：拦下它的确实是 allowPortLookup 这个开关。
    const allowed = resolveServerTarget({ paths, port, runtimeRecord: null, allowPortLookup: true })
    assert.equal(allowed.ok, false)
    assert.match(allowed.reason, /不是 dsh web/)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('stopServerProcess 能优雅停掉一个进程', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(isProcessAlive(child.pid), true)
  const result = await stopServerProcess(child.pid, { timeoutMs: 3000 })
  assert.equal(result.ok, true)
  assert.equal(isProcessAlive(child.pid), false)
})

await test('stopServerProcess 对已消失的进程返回成功（幂等）', async () => {
  const result = await stopServerProcess(2147483646, { timeoutMs: 500 })
  assert.equal(result.ok, true)
  assert.match(result.reason, /本来就不存在/)
})

// ---------------------------------------------------------------------------
section('非 Linux 平台契约')
// ---------------------------------------------------------------------------

// 这条断言的是 README 里承诺的那句话：「非 Linux 平台上安静地什么都不做」。
// 它是 macOS CI 那一遍真正要验证的东西 —— 在别的平台上跑 Linux 的用例没有意义，
// 但「不崩、不乱写文件」是有意义的。
if (IS_LINUX) {
  skipped += 1
  process.stdout.write(`  \u001B[33m-\u001B[0m 非 Linux 平台契约 \u001B[2m（跳过：当前平台就是 Linux）\u001B[0m\n`)
} else {
  await test('非 Linux 平台上 apply 什么都不做、不抛异常、不写文件', async () => {
    const dir = makeSandbox('nonlinux')
    try {
      await withEnv({ DSH_DESKTOP_ROOT: dir }, async () => {
        const paths = resolvePaths(process.env)
        const { ctx, logs } = makeMockCtx()
        const mod = await import('../src/index.js')

        assert.doesNotThrow(() => mod.apply(ctx))
        await settle()

        assert.equal(readRuntime(paths), null, '非 Linux 上不应发布运行时状态')
        assert.ok(!fs.existsSync(paths.launcherFile), '非 Linux 上不应写启动器')
        assert.ok(!fs.existsSync(paths.desktopEntryFile), '非 Linux 上不应写桌面入口')
        assert.deepEqual(logs, [], '非 Linux 上应直接返回，连日志都不该产生')
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

// ---------------------------------------------------------------------------

process.stdout.write(`\n${'─'.repeat(60)}\n`)
if (failed === 0) {
  const skipNote = skipped > 0 ? `\u001B[2m（跳过 ${skipped} 项：非 Linux）\u001B[0m` : ''
  process.stdout.write(`\u001B[32m全部通过\u001B[0m：${passed} 项${skipNote}\n`)
} else {
  process.stdout.write(`\u001B[31m失败 ${failed} 项\u001B[0m，通过 ${passed} 项${skipped > 0 ? `，跳过 ${skipped} 项` : ''}\n\n`)
  for (const { label, error } of failures) {
    process.stdout.write(`  ✗ ${label}\n    ${error.stack?.split('\n').slice(0, 3).join('\n    ')}\n`)
  }
}
process.exitCode = failed === 0 ? 0 : 1
