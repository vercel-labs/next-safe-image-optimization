#!/usr/bin/env node
// CI's release build of the worker binary (`crates/worker`) for a target, which it copies to
// `packages/nsio/safe-image-optimization-worker.<platform>`, for scripts/pack-npm.mjs (and CI's
// tests, with `NEXT_SAFE_IMAGE_OPTIMIZATION_WORKER_PATH`). The platform is Node's (like
// `linux-x64-gnu`, or `darwin-arm64`). Local builds don't need this: `pnpm test` uses
// `target/debug`, and `pnpm test:release` uses `target/release` (from crates/worker/turbo.json's
// `build:release`, with the same `--config`).
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
// std is rebuilt (`-Zbuild-std`) with `panic = "immediate-abort"`: a panic is only a trap
// instruction, without the panic hook, messages, locations, or backtraces (which need the symbols
// that are stripped anyway). That's about 512 KiB on aarch64, plus about 150 KiB of std's own unwind
// tables on Linux (worker-release.toml's rustflags also apply to the rebuilt std). A panic ends the
// worker like any other crash, only by a signal like `SIGILL` or `SIGTRAP` instead of `SIGABRT`.
// Both are unstable, so `RUSTC_BOOTSTRAP` allows them on the stable toolchain. Cargo itself has to
// see it in its environment (`[env]` only applies to rustc), so this isn't in worker-release.toml,
// and local release builds (`pnpm build:release`) don't do it: they're slightly larger, and print
// panics.
const env = { RUSTC_BOOTSTRAP: '1' }
if (cross && target.startsWith('riscv')) {
  env.CARGO_ZIGBUILD_ZIG_PATH = join(root, 'scripts', 'zig-without-march.sh')
}
run(
  'cargo',
  [
    cross ? 'zigbuild' : 'build',
    '--package=nsio-worker',
    '--release',
    '--locked',
    `--target=${cargoTarget}`,
    '--config',
    join(root, '.cargo', 'worker-release.toml'),
    '--config',
    'profile.release.panic = "immediate-abort"',
    '-Zbuild-std=std,panic_abort',
    '-Zpanic-immediate-abort',
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
copyFileSync(worker, join(root, 'packages', 'nsio', `safe-image-optimization-worker.${name}${exe}`))
