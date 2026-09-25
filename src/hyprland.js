/**
 * Hyprland 窗口规则的读写。
 *
 * 与 `kwin.js` 的差别不只是「换个文件格式」，有三件事必须先讲清楚 —— 它们
 * 全部来自在本机嵌套 Hyprland 0.56.2 上的实测，不是查文档推断的：
 *
 * 1. **平铺会吞掉一切尺寸。** 不写规则时窗口被平铺铺满工作区，浏览器传的
 *    `--window-size` 被彻底忽略。`size` 规则**只对浮动窗口有效**，所以必须
 *    同时给 `float`，否则 `size` 静默失效。
 *
 * 2. **配置有两套格式，语法完全不同。** Hyprland 0.56 起全新安装生成
 *    `hyprland.lua`（Lua 语法），老用户升级上来的仍是 `hyprland.conf`
 *    （hyprlang 语法）。两者同时存在时 **`.lua` 优先**。
 *
 * 3. **写错配置会让 Hyprland 拒绝启动。** 旧语法 `windowrulev2` 在 0.56 是
 *    硬错误（`--verify-config` 退出码 1）。因此这里对用户配置的态度是
 *    「宁可什么都不写，也绝不写坏」：
 *      - 规则**内联**进主配置并用注释标记包起来。**不用 `source =`** ——
 *        实测 `source` 指向不存在的文件同样是硬错误，一旦我们的文件被删，
 *        用户整个 Hyprland 配置都会加载失败。
 *      - 写入前先用 `--verify-config` 离线校验（它不起合成器、不占屏幕）。
 *      - 版本低于 0.53 时**跳过并警告**，不写未经实测的旧语法。
 *
 * @module dsh-linux-integration/hyprland
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 我们那条规则的名字（Lua 的具名规则用得到，也兼作识别标记）。 */
export const RULE_NAME = 'dsh-lxi-window-size'

/** 内联块的起止标记。带标记是为了「精确删除自己，绝不动用户一行」。 */
export const MARK_BEGIN = 'dsh-lxi begin'
export const MARK_END = 'dsh-lxi end'

/**
 * 支持 `match:class` 新语法的**最低** Hyprland 版本。
 *
 * 0.53 之前只有 `windowrulev2 = <效果>, class:^(...)$` 那套老写法，而本机
 * 只有 0.56 可供实测。与其写一段没验证过的老语法去改用户的配置文件
 * （改坏了 Hyprland 直接起不来），不如明确跳过并让用户知道原因。
 */
export const MIN_MODERN_VERSION = [0, 53]

/** 把 `0.56.2` 这类版本串解析成数字数组；解析不出来返回 null。 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** `a >= b` 的语义化版本比较。 */
export function versionAtLeast(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left > right) return true
    if (left < right) return false
  }
  return true
}

/**
 * 选出生效的配置文件。
 *
 * `.lua` 优先是实测结论：两者同时存在时 Hyprland 日志明确写
 * `Using lua config found at .../hyprland.lua`。
 *
 * 两个都不存在时返回 `{ file: null }` —— 这时**不能**替用户创建配置文件：
 * Hyprland 首次运行会自己生成一份默认配置，我们抢先建一个只有规则的
 * 文件，会让用户失去那份默认配置。
 *
 * @param {{ confFile: string, luaFile: string }} paths
 */
export function detectConfigFile({ confFile, luaFile }) {
  if (fs.existsSync(luaFile)) return { file: luaFile, format: 'lua' }
  if (fs.existsSync(confFile)) return { file: confFile, format: 'conf' }
  return { file: null, format: null }
}

/**
 * 读取本机 Hyprland 版本。
 *
 * 用 `--version-json` 而不是 `--version`：前者是干净的 JSON，不用去猜文本
 * 格式（实测输出含 `version`、`buildHyprlang` 等字段）。
 *
 * @returns {{ ok: boolean, version: number[] | null, raw: string | null, reason?: string }}
 */
export function detectHyprlandVersion({ env = process.env, exec = execFileSync } = {}) {
  try {
    const out = exec('Hyprland', ['--version-json'], { encoding: 'utf8', timeout: 5000, env })
    const parsed = JSON.parse(out)
    const version = parseVersion(parsed.version ?? parsed.tag ?? parsed.branch ?? '')
    if (!version) return { ok: false, version: null, raw: out, reason: '无法解析版本号' }
    return { ok: true, version, raw: out }
  } catch (error) {
    return { ok: false, version: null, raw: null, reason: error.message }
  }
}

/** 把 app_id 转义成 hyprlang 里的正则字面量。 */
export function escapeClassForConf(appId) {
  return String(appId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把 app_id 转义成 Lua 双引号字符串里的正则字面量。
 *
 * 要转两层：先做正则转义（`.` → `\.`），再把反斜杠按 Lua 字符串规则翻倍
 * （`\.` → `\\.`）。Lua 里 `\.` 是非法转义，直接写会报错。
 */
export function escapeClassForLua(appId) {
  return escapeClassForConf(appId).replace(/\\/g, '\\\\')
}

/**
 * 生成要内联进配置的规则块（含起止标记）。
 *
 * @param {object} options
 * @param {'conf'|'lua'} options.format
 * @param {string} options.appId Wayland app_id，作为 class 匹配值。
 * @param {{ width: number, height: number }} options.size
 * @returns {string}
 */
export function buildRuleBlock({ format, appId, size }) {
  const width = size.width
  const height = size.height

  if (format === 'lua') {
    return [
      `-- ${MARK_BEGIN}`,
      'hl.window_rule({',
      `    name  = "${RULE_NAME}",`,
      `    match = { class = "^${escapeClassForLua(appId)}$" },`,
      '    float = true,',
      `    size  = "${width} ${height}",`,
      '})',
      `-- ${MARK_END}`,
    ].join('\n')
  }

  // `float on` 不能省：`size` 只对浮动窗口有效，少了它尺寸会被平铺吞掉。
  return [
    `# ${MARK_BEGIN}`,
    `windowrule = match:class ^(${escapeClassForConf(appId)})$, float on, size ${width} ${height}`,
    `# ${MARK_END}`,
  ].join('\n')
}

/** 定位我们那块内联内容，返回 `{ start, stop }` 行号；找不到返回 null。 */
function findBlock(lines, format) {
  const prefix = format === 'lua' ? '-- ' : '# '
  const begin = `${prefix}${MARK_BEGIN}`
  const end = `${prefix}${MARK_END}`
  const start = lines.findIndex((line) => line.trim() === begin)
  if (start === -1) return null
  const stop = lines.findIndex((line, index) => index > start && line.trim() === end)
  if (stop === -1) return null
  return { start, stop }
}

/**
 * 写入/更新我们的窗口规则。
 *
 * 逐行保留原文，只替换我们自己那块 —— 用户手写的规则必须一字不差地留着。
 *
 * @param {object} options
 * @param {string} options.file
 * @param {'conf'|'lua'} options.format
 * @param {string} options.appId
 * @param {{ width: number, height: number }} options.size
 * @returns {{ changed: boolean, backupPath: string | null }}
 */
export function upsertWindowRule({ file, format, appId, size }) {
  const existed = fs.existsSync(file)
  const original = existed ? fs.readFileSync(file, 'utf8') : ''
  const block = buildRuleBlock({ format, appId, size })

  const lines = original.split('\n')
  // 末尾若有换行，split 会产生一个空尾巴；先摘掉，处理完再补回来。
  const hadTrailingNewline = original.endsWith('\n')
  if (hadTrailingNewline) lines.pop()

  const found = findBlock(lines, format)
  let next
  if (found) {
    next = [...lines.slice(0, found.start), ...block.split('\n'), ...lines.slice(found.stop + 1)]
  } else {
    // 追加到文件末尾，前面留一个空行，避免和用户最后一行粘在一起。
    const needsGap = lines.length > 0 && lines[lines.length - 1].trim() !== ''
    next = [...lines, ...(needsGap ? [''] : []), ...block.split('\n')]
  }

  const updated = `${next.join('\n')}\n`
  if (updated === original) return { changed: false, backupPath: null }

  const backupPath = backupFile(file, existed)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, updated, { mode: 0o600 })
  return { changed: true, backupPath }
}

/**
 * 移除我们的窗口规则，其余内容原样保留。
 *
 * @param {{ file: string, format: 'conf'|'lua' }} options
 * @returns {{ changed: boolean, backupPath: string | null }}
 */
export function removeWindowRule({ file, format }) {
  if (!fs.existsSync(file)) return { changed: false, backupPath: null }
  const original = fs.readFileSync(file, 'utf8')

  const lines = original.split('\n')
  const hadTrailingNewline = original.endsWith('\n')
  if (hadTrailingNewline) lines.pop()

  const found = findBlock(lines, format)
  if (!found) return { changed: false, backupPath: null }

  const rest = [...lines.slice(0, found.start), ...lines.slice(found.stop + 1)]
  // 顺手吃掉我们当初加的那个分隔空行，别留下越来越长的空白。
  while (rest.length > 0 && rest[rest.length - 1].trim() === '') rest.pop()

  const updated = `${rest.join('\n')}\n`
  if (updated === original) return { changed: false, backupPath: null }

  const backupPath = backupFile(file, true)
  fs.writeFileSync(file, updated, { mode: 0o600 })
  return { changed: true, backupPath }
}

/** 配置里是否已有我们的规则（供 status 诊断用）。 */
export function hasWindowRule({ file, format }) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const prefix = format === 'lua' ? '-- ' : '# '
    return text.includes(`${prefix}${MARK_BEGIN}`)
  } catch {
    return false
  }
}

/**
 * 用 `Hyprland --verify-config` 离线校验一段内容。
 *
 * 这是写入前的最后一道闸：校验失败就一个字都不写。`--verify-config` 不起
 * 合成器、不占屏幕，可以放心调用。
 *
 * 注意只校验**我们自己的块**，不校验合并后的整份配置 —— 合并结果里可能有
 * `source = 相对路径`，复制到临时目录会解析不到，反而产生假失败。
 *
 * @returns {{ ok: boolean, error: string | null }}
 */
export function verifyRuleBlock({ format, block, env = process.env, exec = execFileSync }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hypr-verify-'))
  const file = path.join(dir, format === 'lua' ? 'probe.lua' : 'probe.conf')
  try {
    fs.writeFileSync(file, `${block}\n`)
    const out = exec('Hyprland', ['--verify-config', '-c', file], { encoding: 'utf8', timeout: 15000, env })
    return { ok: /config ok/i.test(out), error: null }
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    const line = /Config error[^\n]*/i.exec(out)
    return { ok: false, error: line ? line[0] : error.message }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** 备份原文件；首次备份不会被后续安装覆盖。 */
function backupFile(file, existed) {
  if (!existed) return null
  const backupPath = `${file}.dsh-backup`
  if (fs.existsSync(backupPath)) return backupPath
  try {
    fs.copyFileSync(file, backupPath)
    return backupPath
  } catch {
    return null
  }
}

/**
 * 通知 Hyprland 重新加载配置。
 *
 * `hyprctl` 依赖 `HYPRLAND_INSTANCE_SIGNATURE`，该变量只在 Hyprland 会话
 * 内部才有。不在 Hyprland 里跑（或没装 hyprctl）时静默跳过 —— 规则已经落盘，
 * 下次登录自然生效。
 *
 * @returns {{ ok: boolean, via: string | null }}
 */
export function reloadHyprland({ env = process.env, exec = execFileSync } = {}) {
  if (!env.HYPRLAND_INSTANCE_SIGNATURE) return { ok: false, via: null }
  try {
    exec('hyprctl', ['reload'], { stdio: 'ignore', timeout: 5000, env })
    return { ok: true, via: 'hyprctl' }
  } catch {
    return { ok: false, via: null }
  }
}
