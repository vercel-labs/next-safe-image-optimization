#!/usr/bin/env node
// Builds the wasm module (`crates/wasm`) for `wasm32-wasip1`, checks its imports against an
// allowlist, and copies it to the package root as `blunt-image-optimization.wasm`.
//
// wasi-sdk is only needed to compile libwebp and mozjpeg (C). Rust links with its own wasi-libc.
//
// Usage: WASI_SDK_PATH=/path/to/wasi-sdk node scripts/build-wasm.mjs

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const target = 'wasm32-wasip1'
const profile = 'worker'

const wasiSdk = process.env.WASI_SDK_PATH
if (!wasiSdk || !existsSync(join(wasiSdk, 'bin', 'clang'))) {
  console.error('Set WASI_SDK_PATH to a wasi-sdk installation (https://github.com/WebAssembly/wasi-sdk).')
  process.exit(1)
}

const exe = process.platform === 'win32' ? '.exe' : ''
const cargo = spawnSync('cargo', ['build', '-p', 'blunt-wasm', '--target', target, '--profile', profile], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    CC_wasm32_wasip1: join(wasiSdk, 'bin', `clang${exe}`),
    AR_wasm32_wasip1: join(wasiSdk, 'bin', `llvm-ar${exe}`),
  },
})
if (cargo.status !== 0) {
  process.exit(cargo.status ?? 1)
}

// What the module may import, by import module. These are exactly what `js/wasm-worker.ts`
// provides: the WASI filesystem functions always fail (there are no preopened directories), and
// nothing calls into JS.
const allowedImports = new Map([
  ['env', new Set(['memory'])],
  [
    'wasi_snapshot_preview1',
    new Set([
      'clock_time_get',
      'environ_get',
      'environ_sizes_get',
      'fd_close',
      'fd_fdstat_get',
      'fd_filestat_get',
      'fd_prestat_dir_name',
      'fd_prestat_get',
      'fd_read',
      'fd_seek',
      'fd_write',
      'path_filestat_get',
      'path_open',
      'proc_exit',
      'random_get',
      'sched_yield',
    ]),
  ],
])
const file = join(root, 'target', target, profile, 'blunt_wasm.wasm')
const wasm = await WebAssembly.compile(readFileSync(file))
const disallowed = WebAssembly.Module.imports(wasm)
  .filter(({ module, name }) => !allowedImports.get(module)?.has(name))
  .map(({ module, name }) => `${module}.${name}`)
if (disallowed.length > 0) {
  console.error(`The wasm module has imports that aren't allowed: ${disallowed.join(', ')}`)
  process.exit(1)
}
console.log('Checked the imports of the wasm module')

copyFileSync(file, join(root, 'blunt-image-optimization.wasm'))
