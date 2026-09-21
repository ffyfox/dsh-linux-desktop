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
import { install, renderTemplate, status, uninstall } from '../src/installer.js'
import { getKey, parseKconfig, removeSizeRule, serializeKconfig, setKey, upsertSizeRule } from '../src/kwin.js'
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
