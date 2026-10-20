#!/usr/bin/env node
// Builds the native binding (`crates/shim`, with `napi build`) and the worker binary
// (`crates/worker`), and copies them to the package root. napi runs in a scratch directory, so that
// it only installs the files we want.
//
// Usage: node scripts/build-native.mjs [--release] [--target <triple>] [-x] [extra napi build args]

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
// Relative to `root`, because the command line isn't escaped on Windows.
const outputDir = 'target/napi-output'

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

const args = process.argv.slice(2)
const release = args.includes('--release') || args.includes('-r')
const targetIndex = args.findIndex((arg) => arg === '--target' || arg === '-t')
const target = targetIndex === -1 ? undefined : args[targetIndex + 1]
const cross = args.includes('-x') || args.includes('--cross-compile')

const dir = join(root, outputDir)
// Otherwise outputs from earlier builds (e.g. for other targets) would be installed too.
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
run('pnpm', [
  'exec',
  'napi',
  'build',
  '--platform',
  '--no-const-enum',
  '--manifest-path',
  'crates/shim/Cargo.toml',
  '--package-json-path',
  'package.json',
  '--output-dir',
  outputDir,
  '--js',
  'binding.js',
  '--dts',
  'binding.d.ts',
  ...args,
])

// The binding is named like `blunt-image-optimization.linux-x64-gnu.node`. The worker uses the same
// platform name.
const binding = readdirSync(dir).find((file) => file.endsWith('.node'))
if (binding === undefined) {
  console.error('napi build produced no .node file')
  process.exit(1)
}
const platform = binding.split('.')[1]

// Panics abort the worker (see the `worker` profiles in Cargo.toml).
const profile = release ? 'worker' : 'worker-dev'
run('cargo', [
  cross ? 'zigbuild' : 'build',
  '-p',
  'blunt-worker',
  '--profile',
  profile,
  ...(target ? ['--target', target] : []),
])
const exe = platform.startsWith('win32') ? '.exe' : ''
const worker = join(root, 'target', ...(target ? [target] : []), profile, `blunt-image-optimization-worker${exe}`)

for (const file of ['binding.js', 'binding.d.ts', binding]) {
  copyFileSync(join(dir, file), join(root, file))
}
copyFileSync(worker, join(root, `blunt-image-optimization-worker.${platform}${exe}`))
