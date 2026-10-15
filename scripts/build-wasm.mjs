#!/usr/bin/env node
// Builds the `wasm32-wasip1-threads` binding, then locks down the generated WASI loaders.
//
// Usage: WASI_SDK_PATH=/path/to/wasi-sdk node scripts/build-wasm.mjs [extra napi build args]
//
// libwebp (C) is compiled with wasi-sdk's clang, but we deliberately hide `WASI_SDK_PATH` from the
// napi CLI. If napi sees it, it links against wasi-sdk's wasi-libc, which is ABI-incompatible with
// the wasi-libc and crt objects that Rust's `wasm32-wasip1-threads` target ships (wasi-sdk 34
// changed the futex ABI and removed `__wasi_init_tp`). Linking with rust-lld against Rust's own
// wasi-libc avoids the mismatch; libwebp only needs the C standard library's basic functions.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const target = 'wasm32-wasip1-threads'
const targetEnv = target.replaceAll('-', '_')

const wasiSdk = process.env.WASI_SDK_PATH
if (!wasiSdk || !existsSync(join(wasiSdk, 'bin', 'clang'))) {
  console.error('Set WASI_SDK_PATH to a wasi-sdk installation (https://github.com/WebAssembly/wasi-sdk).')
  process.exit(1)
}

const env = { ...process.env }
delete env.WASI_SDK_PATH
env[`CC_${targetEnv}`] = join(wasiSdk, 'bin', 'clang')
env[`AR_${targetEnv}`] = join(wasiSdk, 'bin', 'llvm-ar')
env[`CFLAGS_${targetEnv}`] = [`--target=${target}`, `--sysroot=${join(wasiSdk, 'share', 'wasi-sysroot')}`, '-pthread'].join(' ')

const napi = spawnSync(
  'pnpm',
  [
    'exec',
    'napi',
    'build',
    '--platform',
    '--no-const-enum',
    '--release',
    '--target',
    target,
    '--js',
    'binding.js',
    '--dts',
    'binding.d.ts',
    ...process.argv.slice(2),
  ],
  { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' },
)
if (napi.status !== 0) {
  process.exit(napi.status ?? 1)
}

// The generated loaders give the module the host's entire filesystem (via WASI preopens) and
// environment variables. We need neither. WASI preview1 has no other network or filesystem access.
//
// Note that this is defense in depth, not a sandbox: a compromised module can still reach JS globals
// through the napi interface.
const preopens = /env: process\.env,(\s*)preopens: \{\s*\[__rootDir\]: __hostRoot,\s*\[__hostRoot\]: __hostRoot,\s*\},/g
for (const file of ['blunt-image-optimization.wasi.cjs', 'wasi-worker.mjs']) {
  const path = join(root, file)
  const source = readFileSync(path, 'utf8')
  const matches = source.match(preopens)?.length ?? 0
  if (matches !== 1) {
    // Fail loudly if napi's template changes, rather than silently shipping an unrestricted loader.
    console.error(`Expected exactly one WASI preopens block in ${file}, found ${matches}.`)
    process.exit(1)
  }
  writeFileSync(path, source.replace(preopens, 'env: {},$1preopens: {},'))
  console.log(`Removed WASI filesystem and environment access from ${file}`)
}
