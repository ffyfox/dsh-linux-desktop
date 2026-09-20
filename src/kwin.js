/**
 * KWin 窗口规则（`~/.config/kwinrulesrc`）的安全读写。
 *
 * KDE 的 `kwinrulesrc` 是 kconfig 格式：一组 `[数字]` 段，外加一个 `[General]`
 * 段记录 `count`（规则总数）与 `rules`（规则 id 的顺序列表）。
 *
 * 这里**刻意不用「整体解析再重新序列化」**的做法，而是逐行保留原文，只改动我们
 * 自己那一段和 `[General]` 的两行 —— 用户手写的其它规则（比如给桌面宠物加
 * `skiptaskbar`）必须一字不差地留着。
 *
 * @module dsh-linux-desktop/kwin
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 我们那条规则的 `description`，同时作为识别标记。 */
export const RULE_DESCRIPTION = 'DeepSeek Harness Window Rule'

/** KWin 规则值：3 = Apply Initially（仅窗口创建时应用一次，之后不干扰用户拖拽）。 */
const SIZE_RULE_APPLY_INITIALLY = 3

/**
 * 解析 kconfig 文本。
 *
 * @param {string} text
 * @returns {{ groups: Array<{ name: string, lines: string[] }> }}
 */
export function parseKconfig(text) {
  const groups = []
  /** @type {{ name: string, lines: string[] } | null} */
  let current = null

  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (header) {
      current = { name: header[1], lines: [] }
      groups.push(current)
      continue
    }
    if (current) current.lines.push(line)
    // 首个段之前的杂项行（注释、空行）直接丢弃：kconfig 不依赖它们。
  }

  return { groups }
}

/**
 * 序列化回 kconfig 文本。
 *
 * @param {{ groups: Array<{ name: string, lines: string[] }> }} doc
 * @returns {string}
 */
export function serializeKconfig(doc) {
  const out = []
  for (const group of doc.groups) {
    out.push(`[${group.name}]`)
    // 去掉段尾多余空行，避免反复安装时空行不断累积。
    const body = [...group.lines]
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    out.push(...body)
    out.push('')
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

/** 在一段里读取某个键的值。 */
export function getKey(lines, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*)$`)
  for (const line of lines) {
    const match = pattern.exec(line)
    if (match) return match[1].trim()
  }
  return undefined
}

/** 在一段里设置某个键（存在则替换，不存在则追加）。 */
export function setKey(lines, key, value) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) {
      lines[i] = `${key} = ${value}`
      return lines
    }
  }
  lines.push(`${key} = ${value}`)
  return lines
}

/** 在一段里删除某个键。 */
export function deleteKey(lines, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  return lines.filter((line) => !pattern.test(line))
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findGroup(doc, name) {
  return doc.groups.find((group) => group.name === name)
}

/** 找出我们那条规则所在的段。 */
function findOurRuleGroup(doc) {
  return doc.groups.find((group) => getKey(group.lines, 'description') === RULE_DESCRIPTION)
}

/** 读取 `[General] rules` 里的 id 列表。 */
function readRuleIds(general) {
  const raw = general ? getKey(general.lines, 'rules') : undefined
  if (!raw) return []
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * 计算下一个可用的数字段名。
 *
 * 取「所有数字段名的最大值 + 1」，而不是 `count + 1` —— 因为用户可能删过规则，
 * `count` 与最大 id 未必一致，直接用 count+1 会撞号覆盖别人的规则。
 */
function nextRuleId(doc) {
  let max = 0
  for (const group of doc.groups) {
    if (/^\d+$/.test(group.name)) max = Math.max(max, Number.parseInt(group.name, 10))
  }
  return String(max + 1)
}

/**
 * 写入/更新我们的窗口规则。
 *
 * @param {object} options
 * @param {string} options.file kwinrulesrc 路径。
 * @param {string} options.appId Wayland app_id，作为 `wmclass` 匹配值。
 * @param {{ width: number, height: number }} options.size 初始尺寸。
 * @returns {{ changed: boolean, ruleId: string, backupPath: string | null }}
 */
export function upsertSizeRule({ file, appId, size }) {
  const existed = fs.existsSync(file)
  const original = existed ? fs.readFileSync(file, 'utf8') : ''
  const doc = parseKconfig(original)

  let general = findGroup(doc, 'General')
  if (!general) {
    general = { name: 'General', lines: [] }
    doc.groups.push(general)
  }

  let group = findOurRuleGroup(doc)
  let ruleId
  if (group) {
    ruleId = group.name
  } else {
    ruleId = nextRuleId(doc)
    group = { name: ruleId, lines: [] }
    doc.groups.push(group)
  }

  setKey(group.lines, 'description', RULE_DESCRIPTION)
  setKey(group.lines, 'wmclass', appId)
  setKey(group.lines, 'wmclasscomplete', 'false')
  setKey(group.lines, 'wmclassmatch', '1')
  setKey(group.lines, 'size', `${size.width},${size.height}`)
  setKey(group.lines, 'sizerule', String(SIZE_RULE_APPLY_INITIALLY))

  const ids = readRuleIds(general)
  if (!ids.includes(ruleId)) ids.push(ruleId)
  setKey(general.lines, 'count', String(ids.length))
  setKey(general.lines, 'rules', ids.join(','))

  const updated = serializeKconfig(doc)
  if (updated === original) return { changed: false, ruleId, backupPath: null }

  const backupPath = backupFile(file, existed)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, updated, { mode: 0o600 })
  return { changed: true, ruleId, backupPath }
}

/**
 * 移除我们的窗口规则。
 *
 * @param {{ file: string }} options
 * @returns {{ changed: boolean, backupPath: string | null }}
 */
export function removeSizeRule({ file }) {
  if (!fs.existsSync(file)) return { changed: false, backupPath: null }
  const original = fs.readFileSync(file, 'utf8')
  const doc = parseKconfig(original)

  const group = findOurRuleGroup(doc)
  if (!group) return { changed: false, backupPath: null }

  const ruleId = group.name
  doc.groups = doc.groups.filter((candidate) => candidate !== group)

  const general = findGroup(doc, 'General')
  if (general) {
    const ids = readRuleIds(general).filter((id) => id !== ruleId)
    setKey(general.lines, 'count', String(ids.length))
    setKey(general.lines, 'rules', ids.join(','))
  }

  const updated = serializeKconfig(doc)
  if (updated === original) return { changed: false, backupPath: null }

  const backupPath = backupFile(file, true)
  fs.writeFileSync(file, updated, { mode: 0o600 })
  return { changed: true, backupPath }
}

/** 备份原文件，返回备份路径；首次备份不会被后续安装覆盖。 */
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
 * 通知 KWin 重新加载配置。
 *
 * 按 `qdbus6 → qdbus → dbus-send` 依次尝试，全都不可用就静默跳过（规则已落盘，
 * 下次登录自然生效）。
 *
 * @returns {{ ok: boolean, via: string | null }}
 */
export function reconfigureKwin() {
  const attempts = [
    ['qdbus6', ['org.kde.KWin', '/KWin', 'org.kde.KWin.reconfigure']],
    ['qdbus', ['org.kde.KWin', '/KWin', 'org.kde.KWin.reconfigure']],
    [
      'dbus-send',
      ['--session', '--type=method_call', '--dest=org.kde.KWin', '/KWin', 'org.kde.KWin.reconfigure'],
    ],
  ]

  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000 })
      return { ok: true, via: cmd }
    } catch {
      // 换下一个；命令不存在时 execFileSync 会抛 ENOENT。
    }
  }
  return { ok: false, via: null }
}
