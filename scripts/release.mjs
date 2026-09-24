#!/usr/bin/env node
/**
 * 一条命令跑完发布前的机械步骤：校验 → 从 tag 产出制品 → 打印发布命令。
 *
 * 它**故意不发布**，两个原因都不是技术限制：
 *   1. npm 要求浏览器确认，那一步只能人来点；
 *   2. 「现在要不要发」是判断，不是机械步骤。
 *
 * 步骤本身是机械的，所以合到这里：
 *   - 跑 `prepublish-check --release`（含测试、隐私指纹、README 用例数量、
 *     工作区干净、**以及 tag 必须精确指向 HEAD**）；
 *   - 从 tag 导出源码树、在干净树里 `npm pack`、再逐字节核对制品；
 *   - 把发布命令连同真实的 tgz 路径打印出来，直接复制就能用。
 *
 * 用法：npm run release
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { packFromTag } from './pack-from-tag.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REGISTRY = 'https://registry.npmjs.org'

function main() {
  // ---- 1. 校验。stdio 用 inherit：让用户看到完整的检查清单与失败原因，
  //         而不是把输出吞掉再转述一句「校验失败」。
  process.stdout.write('\n\u001B[1m[1/2] 发布前校验（--release）\u001B[0m\n')
  try {
    execFileSync(process.execPath, [path.join(HERE, 'prepublish-check.mjs'), '--release'], {
      cwd: ROOT,
      stdio: 'inherit',
    })
  } catch {
    // prepublish-check 自己已经把每一条问题都打印清楚了，这里只补一句下一步。
    process.stderr.write('\n校验未通过，制品没有产出。修完上面的问题再跑一次 npm run release。\n\n')
    process.exitCode = 1
    return
  }

  // ---- 2. 从 tag 出制品
  process.stdout.write('\n\u001B[1m[2/2] 从 tag 产出制品\u001B[0m\n')
  let result
  try {
    result = packFromTag({ root: ROOT, log: (line) => process.stdout.write(`  ${line}\n`) })
  } catch (error) {
    process.stderr.write(`\n产出制品失败：\n${error.message}\n\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write(`\n\u001B[32m制品就绪\u001B[0m\n`)
  process.stdout.write(`  路径  ${result.tgz}\n`)
  process.stdout.write(`  tag   ${result.tag}\n`)
  process.stdout.write(`  sha1  ${result.sha1}\n`)
  process.stdout.write(`  文件  ${result.files.length} 个，已逐个与 ${result.tag} 比对一致\n`)

  process.stdout.write('\n\u001B[1m下一步：发布（不可逆，需要你在浏览器里确认）\u001B[0m\n\n')
  process.stdout.write(`  npm publish ${JSON.stringify(result.tgz)} --registry=${REGISTRY}\n\n`)
  process.stdout.write('  必须显式带 --registry：本机 npm 的默认源是只读镜像，不能发布。\n')
  process.stdout.write('  没有 TTY 的环境（例如 agent）需要伪终端驱动，否则 npm 会拒绝并把登录 URL 打码。\n')
  process.stdout.write('\n发布完成后核对（把「发布 == tag」坐实）：\n\n')
  process.stdout.write('  npm run verify:published\n\n')
}

main()
