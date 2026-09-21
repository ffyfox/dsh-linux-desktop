/**
 * 把桌面集成的配置暴露成 DSH 的 settings 命名空间。
 *
 * ## 为什么必须有它
 *
 * Web 设置页的「插件 → 插件配置」标签页按 **settings 命名空间**派发卡片：它渲染的是
 * 「宿主服务了哪些命名空间」与「浏览器侧注册了哪些卡片」两份账本的**交集**。宿主
 * 没有注册命名空间，卡片就永远不会被派发 —— 哪怕浏览器半侧写好了也看不见。
 *
 * ## 分层（由下到上）
 *
 * 1. schema 默认值（本文件）；
 * 2. `~/.config/dsh-desktop/config.json` 的当前内容 —— 作为 composition base 传进去，
 *    因此 0.1.x 就存在的配置文件**继续生效**，不会被这次改动作废；
 * 3. `settings.yaml` 里的用户覆盖 —— 设置页卡片写的就是这一层。
 *
 * ## 哪些字段进命名空间
 *
 * 只放「窗口外观与生命周期」这类纯用户偏好。`host` / `port` **刻意不进**：它们必须与
 * `dsh web` 实际绑定的地址一致，放进卡片让用户改，只会制造两份互相矛盾的真相。
 *
 * ## 为什么 schemastery 是动态 import
 *
 * 本项目的测试是**零依赖**的（`node test/smoke.mjs` 不需要 `node_modules`），而
 * `@deepseek-ai/schemastery` 是运行期依赖。所以它只在真正要注册命名空间时才按需
 * 加载；加载不到就安静降级成「没有设置页卡片」，而不是让插件行加载失败、连运行时
 * 状态都发布不了。
 *
 * @module dsh-linux-desktop/settings
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * settings 命名空间名。
 *
 * 文法由 `dsh-settings` 强制：`/^[a-z][a-z0-9-]*$/`。
 */
export const SETTINGS_NAMESPACE = 'linux-desktop'

/**
 * 进命名空间的字段。这份清单同时被 schema 与「从 config.json 取 base」使用，
 * 所以两处不可能走偏。
 */
export const SETTINGS_FIELDS = [
  'profileMode',
  'browser',
  'window',
  'autoInstall',
  'manageKwinRules',
  'manageHyprlandRules',
  'terminalAction',
  'terminalCommand',
]

/**
 * 用传入的 schemastery 实例构造命名空间 schema。
 *
 * 接受 `z` 而不是自己 import，是为了让 schema 本身可以在零依赖的测试里被检查。
 *
 * 边界值与 `src/config.js` 的 `normalizeConfig` 保持一致（窗口 320–20000），
 * 这样「配置文件里的合法值」在设置层也一样合法，不会出现两层判定打架。
 *
 * @param {any} z schemastery 默认导出。
 * @returns {any} schema。
 */
export function createSettingsSchema(z) {
  return z.object({
    profileMode: z.union([z.const('dedicated'), z.const('shared')]).default('dedicated'),
    browser: z.string().default('auto'),
    window: z.object({
      width: z.number().min(320).max(20000).default(1200),
      height: z.number().min(320).max(20000).default(750),
    }),
    autoInstall: z.boolean().default(true),
    manageKwinRules: z.boolean().default(true),
    // 默认 false 与 KDE 相反：Hyprland 是平铺合成器，用户选它就是要平铺，
    // 不该被插件擅自改成浮动。想要固定尺寸的人自己打开。
    manageHyprlandRules: z.boolean().default(false),
    terminalAction: z.boolean().default(true),
    terminalCommand: z.string().default(''),
  })
}

/**
 * 从完整配置里挑出进命名空间的那部分，作为 composition base。
 *
 * 只挑已知字段：`dsh-settings` 会把 base 与用户层合并后交给 schema，多余键没有
 * 好处，反而会让 schema 的报错信息里出现用户看不懂的名字。
 *
 * @param {object} config `src/config.js` 归一化后的完整配置。
 * @returns {object} 命名空间的 base 层。
 */
export function settingsBase(config) {
  const base = {}
  for (const field of SETTINGS_FIELDS) {
    if (config[field] !== undefined) base[field] = config[field]
  }
  return base
}

/** 运行期依赖：只在注册命名空间时按需加载。 */
const SCHEMASTERY_PACKAGE = '@deepseek-ai/schemastery'

/**
 * 从**正在运行的这个 dsh 进程**所在的安装目录里找 schemastery。
 *
 * 为什么需要这条退路：pnpm 的 `link:` 协议只建符号链接，**不解析被链接包自己的
 * 依赖**。于是「本地 checkout 装进 profile」这条路（README 里唯一记录过的安装方式）
 * 拿不到依赖，而 npm / GitHub / tarball 安装都会正常装好。
 *
 * 做法是从 `process.argv[1]`（`dsh` 的可执行入口）取真实路径，逐级向上找
 * `node_modules/@deepseek-ai/schemastery`。找不到就返回空数组，调用方安静降级。
 *
 * @returns {string[]} 候选的 schemastery 目录，由近及远。
 */
function candidateSchemaModules() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return []

  let real
  try {
    real = fs.realpathSync(entry)
  } catch {
    return []
  }

  const candidates = []
  let dir = path.dirname(real)
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(path.join(dir, 'node_modules', SCHEMASTERY_PACKAGE))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return candidates
}

/**
 * 加载 schemastery：先用本包自己的依赖，再退回 dsh 安装目录里的那一份。
 *
 * @returns {Promise<any | null>} schemastery 的默认导出；两条路都不通时为 null。
 */
async function loadSchemastery() {
  try {
    return (await import(SCHEMASTERY_PACKAGE)).default
  } catch {
    // 本地 link: 安装时的常态，继续走退路。
  }

  for (const dir of candidateSchemaModules()) {
    for (const file of ['lib/index.mjs', 'lib/index.cjs']) {
      const candidate = path.join(dir, file)
      if (!fs.existsSync(candidate)) continue
      try {
        const loaded = await import(pathToFileURL(candidate).href)
        const resolved = loaded.default ?? loaded
        return resolved.default ?? resolved
      } catch {
        // 换下一个候选。
      }
    }
  }
  return null
}

/**
 * 注册命名空间，并把「生效值」的读取口交给调用方。
 *
 * 用 `installSection` 而不是裸 `register`：它把设置层接成**权威来源**，并在插件
 * 卸载 / settings 服务消失时自动回退到 composition 配置，行为与没有设置服务时完全
 * 一致 —— 这正是「缺少 settings 的部署里一切照旧」所需要的。
 *
 * 全程 try/catch：设置层是增强，绝不能成为 `dsh web` 起不来的原因。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {object} options
 * @param {object} options.base 来自 config.json 的 composition base。
 * @param {(read: () => object) => void} options.setSource 接收「读生效值」的函数。
 * @param {() => void} options.onChange 生效值变化时的回调（用于重跑幂等安装）。
 * @param {(...args: unknown[]) => void} options.warn 日志。
 * @returns {Promise<boolean>} 是否成功接上设置层。
 */
export async function installSettingsNamespace(ctx, { base, setSource, onChange, warn }) {
  const z = await loadSchemastery()
  if (z === null) {
    warn(`未加载到 ${SCHEMASTERY_PACKAGE}，设置页卡片不可用；其余功能不受影响`)
    return false
  }

  try {
    if (typeof ctx.inject !== 'function') {
      warn('当前 Cordis 上下文没有 inject，跳过设置命名空间注册')
      return false
    }
    const schema = createSettingsSchema(z)
    ctx.inject(['settings'], (settingsCtx) => {
      try {
        settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, schema, base, {
          setSource,
          onChange,
        })
      } catch (error) {
        warn(`注册设置命名空间失败：${error?.message ?? String(error)}`)
      }
    })
    return true
  } catch (error) {
    warn(`接入设置服务失败：${error?.message ?? String(error)}`)
    return false
  }
}
