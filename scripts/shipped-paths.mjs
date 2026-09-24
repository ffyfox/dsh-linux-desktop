/**
 * 「哪些文件会进 npm 包」的唯一定义，以及仓库根目录。
 *
 * 为什么单独抽一个模块：`scripts/prepublish-check.mjs` 的第 8 项（脏树闸门）和
 * `scripts/pack-from-tag.mjs` 的状态校验盯的是同一批路径，而 prepublish-check 是个
 * 「一 import 就跑完整套校验」的脚本 —— 为了拿一个常量去 import 它，副作用远大于收益。
 * 抄一份的话两边迟早漂移，所以放这里共用。
 *
 * 定义**直接来自 `package.json` 的 `files` 白名单**，再加 `package.json` 自己（npm 无论
 * `files` 怎么写都一定会打包它）。这样以后往 `files` 里加路径时，闸门自动覆盖到，不需要
 * 记得同步第二个地方。
 *
 * @module scripts/shipped-paths
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本仓库根目录（`scripts/` 的上一级）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 会进 npm 包的那些路径（相对仓库根）。
 *
 * @param {string} [root] 仓库根目录，默认本仓库。
 * @returns {string[]}
 */
export function shippedPaths(root = REPO_ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const listed = Array.isArray(manifest.files) ? manifest.files : []
  return [...new Set([...listed, 'package.json'])]
}
