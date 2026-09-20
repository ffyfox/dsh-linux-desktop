#!/usr/bin/env node
/**
 * `dsh-desktop` 可执行入口。
 *
 * 安装进 profile 后位于 `<profile>/node_modules/.bin/dsh-desktop`，可以用
 *   dsh plugin --profile web exec dsh-desktop status
 * 调用；也可以直接 `node <包目录>/bin/dsh-desktop.js`。
 */

import { run } from '../src/cli.js'

const exitCode = await run(process.argv.slice(2))
process.exitCode = exitCode
