#!/usr/bin/env node
// Builds the `wasm32-wasip1-threads` binding (see `napi-build.mjs`), and checks the module's imports
// against an allowlist.
//
// Usage: WASI_SDK_PATH=/path/to/wasi-sdk node scripts/build-wasm.mjs [extra napi build args]

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { build, install } from './napi-build.mjs'

const wasiSdk = process.env.WASI_SDK_PATH
if (!wasiSdk || !existsSync(join(wasiSdk, 'bin', 'clang'))) {
  console.error('Set WASI_SDK_PATH to a wasi-sdk installation (https://github.com/WebAssembly/wasi-sdk).')
  process.exit(1)
}

const dir = build(['--release', '--target', 'wasm32-wasip1-threads', ...process.argv.slice(2)])

// The functions the module may import, by import module (`null` allows any). There are no WASI
// filesystem functions, so the module can't use the filesystem even if a loader grants it access.
// `environ_*` is allowed because our loaders pass an empty environment.
const allowedImports = new Map([
  // napi, implemented by emnapi.
  ['env', null],
  ['napi', null],
  ['emnapi', null],
  // wasi-threads
  ['wasi', new Set(['thread-spawn'])],
  [
    'wasi_snapshot_preview1',
    new Set(['clock_time_get', 'environ_get', 'environ_sizes_get', 'fd_write', 'proc_exit', 'random_get', 'sched_yield']),
  ],
])
// napi writes a release and a debug module. The loader prefers the debug one, if it exists.
const wasmFiles = readdirSync(dir).filter((file) => file.endsWith('.wasm'))
if (wasmFiles.length === 0) {
  console.error('napi build produced no .wasm files')
  process.exit(1)
}
for (const file of wasmFiles) {
  const wasm = await WebAssembly.compile(readFileSync(join(dir, file)))
  const disallowed = WebAssembly.Module.imports(wasm)
    .filter(({ module, name }) => {
      const names = allowedImports.get(module)
      return names === undefined || (names !== null && !names.has(name))
    })
    .map(({ module, name }) => `${module}.${name}`)
  if (disallowed.length > 0) {
    console.error(`${file} has imports that aren't allowed: ${disallowed.join(', ')}`)
    process.exit(1)
  }
  console.log(`Checked the imports of ${file}`)
}

install(dir)
