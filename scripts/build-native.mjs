#!/usr/bin/env node
// Builds the worker binary (`crates/worker`), and copies it to the package root as
// `blunt-image-optimization-worker.<platform>`, where `js/native.ts` looks for it. The platform is
// Node's (like `linux-x64-gnu`, or `darwin-arm64`).
//
// Usage: node scripts/build-native.mjs [--release] [--target <triple>] [-x] [extra cargo args]
//
// `-x` cross-compiles with cargo-zigbuild.

import { spawnSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
/** The oldest glibc that official Node.js binaries support. */
const GLIBC_VERSION = '2.28'

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

/** Like `x86_64-unknown-linux-gnu` → `linux-x64-gnu`. */
function platform(triple) {
  const [arch, , os, abi] = triple.split('-')
  const nodeArch = { x86_64: 'x64', aarch64: 'arm64' }[arch]
  const nodeOs = { darwin: 'darwin', windows: 'win32', linux: 'linux' }[os]
  if (nodeArch === undefined || nodeOs === undefined) {
    console.error(`unsupported target: ${triple}`)
    process.exit(1)
  }
  return abi === undefined ? `${nodeOs}-${nodeArch}` : `${nodeOs}-${nodeArch}-${abi}`
}

function hostTriple() {
  const result = spawnSync('rustc', ['-vV'], { cwd: root, encoding: 'utf8' })
  const host = result.stdout?.match(/^host: (.+)$/m)?.[1]
  if (result.status !== 0 || host === undefined) {
    console.error('failed to get the host target from `rustc -vV`')
    process.exit(1)
  }
  return host
}

const args = process.argv.slice(2)
let release = false
let cross = false
let target
const extra = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--release' || arg === '-r') {
    release = true
  } else if (arg === '-x' || arg === '--cross-compile') {
    cross = true
  } else if (arg === '--target' || arg === '-t') {
    target = args[++i]
  } else {
    extra.push(arg)
  }
}

// Panics abort the worker (see the `worker` profiles in Cargo.toml).
const profile = release ? 'worker' : 'worker-dev'
// cargo-zigbuild takes the glibc version as a suffix (otherwise, it's zig's default), but its output
// directory doesn't include it.
const cargoTarget = cross && target?.endsWith('-gnu') ? `${target}.${GLIBC_VERSION}` : target
run('cargo', [
  cross ? 'zigbuild' : 'build',
  '-p',
  'blunt-worker',
  '--profile',
  profile,
  ...(cargoTarget ? ['--target', cargoTarget] : []),
  ...extra,
])
const name = platform(target ?? hostTriple())
const exe = name.startsWith('win32') ? '.exe' : ''
const worker = join(root, 'target', ...(target ? [target] : []), profile, `blunt-image-optimization-worker${exe}`)
copyFileSync(worker, join(root, `blunt-image-optimization-worker.${name}${exe}`))
