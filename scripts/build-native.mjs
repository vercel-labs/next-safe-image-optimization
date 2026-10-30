#!/usr/bin/env node
// CI's release build of the worker binary (`crates/worker`) for a target, which it copies to the
// package root as `safe-image-optimization-worker.<platform>`, where `js/native.ts` also looks for
// it. The platform is Node's (like `linux-x64-gnu`, or `darwin-arm64`). Local builds don't need this:
// `pnpm build` builds the worker in `target/debug`, where `js/native.ts` looks first.
//
// Usage: node scripts/build-native.mjs --target <triple> [-x] [extra cargo args]
//
// `-x` cross-compiles with cargo-zigbuild.

import { spawnSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from './platforms.mjs'

const root = join(import.meta.dirname, '..')
/** The oldest glibc that official Node.js binaries support. */
const GLIBC_VERSION = '2.28'

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

const args = process.argv.slice(2)
let cross = false
let target
const extra = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '-x' || arg === '--cross-compile') {
    cross = true
  } else if (arg === '--target' || arg === '-t') {
    target = args[++i]
  } else {
    extra.push(arg)
  }
}
if (target === undefined) {
  console.error('usage: node scripts/build-native.mjs --target <triple> [-x] [extra cargo args]')
  process.exit(1)
}

// cargo-zigbuild takes the glibc version as a suffix (otherwise, it's zig's default), but its output
// directory doesn't include it.
const cargoTarget = cross && target.endsWith('-gnu') ? `${target}.${GLIBC_VERSION}` : target
const env = {}
if (target.startsWith('riscv')) {
  // rav1d enables `stdarch_riscv_feature_detection` (unstable) for `is_riscv_feature_detected!`,
  // even without asm. This allows nightly features in rav1d only.
  env.RUSTC_BOOTSTRAP = 'rav1d'
  if (cross) {
    env.CARGO_ZIGBUILD_ZIG_PATH = join(root, 'scripts', 'zig-without-march.sh')
  }
}
run(
  'cargo',
  [
    cross ? 'zigbuild' : 'build',
    '--package=nsio-worker',
    '--release',
    '--locked',
    `--target=${cargoTarget}`,
    ...extra,
  ],
  env,
)
const name = platform(target)
if (name === undefined) {
  console.error(`unsupported target: ${target}`)
  process.exit(1)
}
const exe = name.startsWith('win32') ? '.exe' : ''
const worker = join(root, 'target', target, 'release', `safe-image-optimization-worker${exe}`)
copyFileSync(worker, join(root, `safe-image-optimization-worker.${name}${exe}`))
