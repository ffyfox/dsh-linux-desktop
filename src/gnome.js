/**
 * GNOME / Mutter 的窗口尺寸「现实检查」。
 *
 * ## 这个模块为什么**只读**
 *
 * KDE 有 `kwinrulesrc`、Hyprland 有 `windowrule`，两者都能「写一条针对某个 app_id
 * 的窗口规则」。GNOME **没有**这种东西 —— 它既没有窗口规则配置文件，也没有对应的
 * dconf 键。这不是「还没找到」，是设计如此。
 *
 * 但 GNOME 也**不需要**规则：它是堆叠式（浮动）窗口管理器，窗口本来就自由浮动，
 * Mutter 会直接接受浏览器请求的 `--window-size`。在本机 headless Mutter 50.5 上实测
 * 700x500 / 900x600 / 1200x750 / 1280x800 / 2200x1500 全部**精确遵循**。
 *
 * 所以本模块一行配置都不写。它只做两件事：读出事实，然后在**尺寸会被 GNOME 吃掉**
 * 的时候提前告警。
 *
 * ## 唯一会吃掉尺寸的机制：auto-maximize
 *
 * Mutter 默认开启 `org.gnome.mutter auto-maximize`：**窗口面积超过工作区一定比例时
 * 直接最大化，请求的尺寸被丢弃。**
 *
 *   src/core/window-private.h:212   #define MAX_UNMAXIMIZED_WINDOW_AREA .8
 *   src/core/place.c:1099           if (window_area > work_area_area * MAX_UNMAXIMIZED_WINDOW_AREA)
 *
 * 实测（工作区 2560x1600）：83.2% 仍被遵循、83.8% 被最大化 —— 与源码常量 0.8 对不上，
 * 原因未查明。**因此告警用 0.8 这个更保守的值**：宁可早一点提醒，也不要让用户遇到
 * 「我明明设了尺寸却没生效」。
 *
 * 反向验证过因果：把 auto-maximize 关掉后，连正好满屏的 2560x1600 都被遵循。
 * 但那是**全局**设置（影响所有应用），不是「针对这个窗口的规则」，所以本模块只
 * 把它写进建议文案，绝不代用户修改。
 *
 * @module dsh-linux-integration/gnome
 */

import { execFileSync } from 'node:child_process'

/**
 * 触发 auto-maximize 的面积占比。
 *
 * 取源码常量 0.8 而不是实测翻转点（约 0.833），因为实测值只在一个分辨率上验证过，
 * 而源码常量是逻辑本身。保守取值只会让告警早一点出现，不会漏报。
 */
export const AUTO_MAXIMIZE_RATIO = 0.8

/** 相关 gsettings schema / key。 */
export const MUTTER_SCHEMA = 'org.gnome.mutter'
export const AUTO_MAXIMIZE_KEY = 'auto-maximize'

/**
 * 把 `gdctl show` 的树形输出剥掉缩进与制表符，只留文本。
 *
 * 输出长这样（实测 mutter 50.5）：
 *
 *   Monitors:
 *   └──Monitor Meta-0 (MetaVendor)
 *      ├──Current mode
 *      │   └──2560x1600@60.000
 *   Logical monitors:
 *   └──Logical monitor #1
 *      ├──Position: (0, 0)
 *      ├──Scale: 1.0
 *      ├──Primary: yes
 *      └──Monitors: (1)
 *          └──Meta-0 (MetaVendor)
 */
function untree(line) {
  return line.replace(/^[\s│├└─]+/, '').trim()
}

/**
 * 解析 `gdctl show` 的输出。
 *
 * 纯函数，方便用真实输出做回归测试。任何看不懂的结构都返回 `{ ok: false }` ——
 * 与其猜一个可能错的屏幕尺寸，不如承认读不出来（调用方会降级成不带数字的提示）。
 *
 * @param {string} text `gdctl show` 的 stdout。
 * @returns {{ ok: boolean, monitors?: Array<{connector: string, width: number, height: number}>,
 *            logical?: Array<{scale: number, primary: boolean, connectors: string[]}>,
 *            reason?: string }}
 */
export function parseGdctlShow(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: '输出为空' }

  const lines = text.split('\n').map(untree)

  // ---- 物理显示器：连接器名 → 当前模式的物理像素 ----
  const monitors = new Map()
  let current = null
  let expectMode = false

  for (const line of lines) {
    const header = /^Monitor (\S+) \(/.exec(line)
    if (header) {
      current = header[1]
      monitors.set(current, { connector: current, width: 0, height: 0 })
      expectMode = false
      continue
    }
    if (line === 'Current mode') {
      expectMode = true
      continue
    }
    const mode = /^(\d+)x(\d+)@/.exec(line)
    if (mode && expectMode && current) {
      const entry = monitors.get(current)
      entry.width = Number(mode[1])
      entry.height = Number(mode[2])
      expectMode = false
      continue
    }
    if (line.startsWith('Logical monitors:')) break
    // 任何其它行都可能意味着格式变了；只清掉「等模式」这个临时状态。
    if (line !== '' && !line.startsWith('│') && !line.startsWith('└') && !line.startsWith('├')) {
      expectMode = false
    }
  }

  // ---- 逻辑显示器：缩放 + 由哪些物理显示器组成 ----
  const logicalStart = lines.findIndex((l) => l.startsWith('Logical monitors:'))
  if (logicalStart === -1) return { ok: false, reason: '没有 Logical monitors 段' }

  const logical = []
  let entry = null
  let expectConnectors = 0

  for (const line of lines.slice(logicalStart + 1)) {
    const head = /^Logical monitor #(\d+)$/.exec(line)
    if (head) {
      if (entry) logical.push(entry)
      entry = { scale: 0, primary: false, connectors: [] }
      expectConnectors = 0
      continue
    }
    if (!entry) continue

    const scale = /^Scale: ([\d.]+)$/.exec(line)
    if (scale) {
      entry.scale = Number(scale[1])
      continue
    }
    const primary = /^Primary: (yes|no)$/.exec(line)
    if (primary) {
      entry.primary = primary[1] === 'yes'
      continue
    }
    const list = /^Monitors: \((\d+)\)$/.exec(line)
    if (list) {
      expectConnectors = Number(list[1])
      continue
    }
    if (expectConnectors > 0) {
      const connector = /^(\S+) \(/.exec(line)
      if (connector) {
        entry.connectors.push(connector[1])
        expectConnectors -= 1
      }
    }
  }
  if (entry) logical.push(entry)

  if (monitors.size === 0) return { ok: false, reason: '没有解析出任何显示器' }
  if (logical.length === 0) return { ok: false, reason: '没有解析出任何逻辑显示器' }

  return { ok: true, monitors: [...monitors.values()], logical }
}

/**
 * 从解析结果里算出**主**逻辑显示器的大小（逻辑像素）。
 *
 * 逻辑尺寸 = 物理像素 / 缩放。一个逻辑显示器可能由多个物理显示器组成（镜像），
 * 此时取各边最大值 —— 镜像的可见区域就是其中最大的那块。
 *
 * @param {ReturnType<typeof parseGdctlShow>} parsed
 * @returns {{ ok: boolean, width?: number, height?: number, scale?: number, reason?: string }}
 */
export function logicalMonitorSize(parsed) {
  if (!parsed?.ok) return { ok: false, reason: parsed?.reason ?? '解析失败' }

  const byConnector = new Map(parsed.monitors.map((m) => [m.connector, m]))
  const target = parsed.logical.find((l) => l.primary) ?? parsed.logical[0]
  if (!target) return { ok: false, reason: '没有逻辑显示器' }
  if (!(target.scale > 0)) return { ok: false, reason: `缩放值不合法：${target.scale}` }

  let width = 0
  let height = 0
  for (const connector of target.connectors) {
    const monitor = byConnector.get(connector)
    if (!monitor) continue
    width = Math.max(width, monitor.width)
    height = Math.max(height, monitor.height)
  }
  if (width <= 0 || height <= 0) return { ok: false, reason: '逻辑显示器没有可用的物理尺寸' }

  return {
    ok: true,
    width: Math.round(width / target.scale),
    height: Math.round(height / target.scale),
    scale: target.scale,
  }
}

/**
 * 读取主逻辑显示器尺寸（只读）。
 *
 * 用 `gdctl` —— 它随 mutter 一起安装，所以任何 GNOME 机器上都有。它读的是
 * `org.gnome.Mutter.DisplayConfig`，不修改任何东西。
 *
 * 不在 GNOME 会话里（比如本项目的测试机是 KDE）时命令会失败，返回 `ok: false`，
 * 调用方降级即可。
 *
 * @param {{ env?: NodeJS.ProcessEnv, exec?: Function }} [options]
 */
export function readGnomeWorkArea({ env = process.env, exec = execFileSync } = {}) {
  try {
    const out = exec('gdctl', ['show'], { encoding: 'utf8', timeout: 5000, env })
    const parsed = parseGdctlShow(out)
    const size = logicalMonitorSize(parsed)
    if (!size.ok) return { ok: false, reason: size.reason }
    return { ok: true, width: size.width, height: size.height, scale: size.scale, source: 'gdctl show' }
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) }
  }
}

/**
 * 读取 `org.gnome.mutter auto-maximize`（只读）。
 *
 * @param {{ env?: NodeJS.ProcessEnv, exec?: Function }} [options]
 * @returns {{ ok: boolean, enabled?: boolean, reason?: string }}
 */
export function readAutoMaximize({ env = process.env, exec = execFileSync } = {}) {
  try {
    const out = exec('gsettings', ['get', MUTTER_SCHEMA, AUTO_MAXIMIZE_KEY], {
      encoding: 'utf8',
      timeout: 5000,
      env,
    })
    const text = String(out).trim()
    if (text === 'true') return { ok: true, enabled: true }
    if (text === 'false') return { ok: true, enabled: false }
    return { ok: false, reason: `无法识别的取值：${text}` }
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) }
  }
}

/**
 * 判断配置的窗口尺寸在 GNOME 下会不会被 auto-maximize 吃掉。
 *
 * 纯函数，便于把各种组合喂进来做回归。
 *
 * @param {object} input
 * @param {{ ok: boolean, width?: number, height?: number }} input.workArea
 * @param {{ width: number, height: number }} input.size 配置里的窗口尺寸（逻辑像素）。
 * @param {{ ok: boolean, enabled?: boolean }} input.autoMaximize
 * @returns {{ risk: 'none' | 'safe' | 'unknown' | 'too-large',
 *             ratio: number | null,
 *             level: 'info' | 'warning',
 *             message: string,
 *             advice: string | null,
 *             suggested: { width: number, height: number } | null }}
 *
 * `message` 是**发现**，`advice` 是**动作**。刻意分开：`message` 会出现在
 * `status` / `install` 的步骤行里，而 `advice` 会进 `warnings`（插件启动时会把
 * 它打到日志里）。两者若写同一句话，CLI 上就会看到一模一样的两行。
 */
export function assessGnomeWindowSize({ workArea, size, autoMaximize }) {
  const area = Number(size?.width) * Number(size?.height)
  const screen = Number(workArea?.width) * Number(workArea?.height)

  // 读不出屏幕尺寸：只能给不带数字的说明，不能瞎猜。
  if (!workArea?.ok || !(screen > 0) || !(area > 0)) {
    return {
      risk: 'unknown',
      ratio: null,
      level: 'info',
      advice: null,
      suggested: null,
      message:
        'GNOME 原生遵循 --window-size（浮动窗口管理器），无需窗口规则。' +
        '注意：若窗口面积超过工作区约 80%，Mutter 的 auto-maximize（默认开启）会把它最大化，' +
        '此时上面的尺寸不生效。',
    }
  }

  const ratio = area / screen

  if (autoMaximize?.ok && autoMaximize.enabled === false) {
    return {
      risk: 'safe',
      ratio,
      level: 'info',
      advice: null,
      suggested: null,
      message: `GNOME 原生遵循 --window-size（${workArea.width}x${workArea.height} 逻辑工作区，auto-maximize 已关闭）。`,
    }
  }

  if (ratio > AUTO_MAXIMIZE_RATIO) {
    const percent = Math.round(ratio * 100)
    // 反推一个「保持宽高比、面积刚好落到阈值」的建议尺寸：等比缩放 sqrt(目标/当前) 即可。
    const scale = Math.sqrt((screen * AUTO_MAXIMIZE_RATIO) / area)
    const suggested = {
      width: Math.max(320, Math.floor(size.width * scale)),
      height: Math.max(320, Math.floor(size.height * scale)),
    }
    return {
      risk: 'too-large',
      ratio,
      level: 'warning',
      suggested,
      message:
        `窗口 ${size.width}x${size.height} 占逻辑工作区 ${workArea.width}x${workArea.height} 的 ${percent}%，` +
        `超过 ${Math.round(AUTO_MAXIMIZE_RATIO * 100)}% —— GNOME 会把它最大化，尺寸设置将不生效。`,
      advice:
        `把窗口宽高改成 ${suggested.width}x${suggested.height} 或更小；` +
        '或执行 gsettings set org.gnome.mutter auto-maximize false' +
        '（全局设置，会影响所有应用的窗口最大化行为，可用 gsettings reset 还原）。',
    }
  }

  return {
    risk: 'safe',
    ratio,
    level: 'info',
    advice: null,
    suggested: null,
    message: `GNOME 原生遵循 --window-size（占逻辑工作区 ${Math.round(ratio * 100)}%，低于 auto-maximize 阈值）。`,
  }
}

/**
 * 一次性做完「读事实 + 评估」，供 installer 调用。
 *
 * 只在 GNOME 会话里才有意义；调用方负责先判断桌面环境。
 *
 * @param {{ env?: NodeJS.ProcessEnv, exec?: Function, size: {width: number, height: number} }} options
 */
export function inspectGnomeWindowSize({ env = process.env, exec = execFileSync, size }) {
  const workArea = readGnomeWorkArea({ env, exec })
  const autoMaximize = readAutoMaximize({ env, exec })
  const assessment = assessGnomeWindowSize({ workArea, size, autoMaximize })
  return { workArea, autoMaximize, assessment }
}
