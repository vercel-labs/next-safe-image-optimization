#!/usr/bin/env node
// Installs the tarballs that scripts/pack-npm.mjs packed into `npm/`, the way users install the
// published packages, and processes an image (scripts/installed-package-test.cjs) with this
// platform's native worker (if there's a package for it), and with the wasm build. Catches packaging
// mistakes, like a missing file or executable bit, or `os`/`cpu`/`libc` fields that don't match.
//
// The platform packages are overridden to their tarballs, since they may not be published yet.
//
// Usage: node scripts/test-npm-packages.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTarballs } from './npm-tarballs.mjs'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tarballs = new Map(readTarballs().map(({ path, manifest }) => [manifest.name, `file:${path}`]))
const wasm = `${pkg.name}-wasm32`

const dir = mkdtempSync(join(tmpdir(), 'nsio-test-packages-'))
try {
  const overrides = Object.fromEntries([...tarballs].filter(([name]) => name !== pkg.name && name !== wasm))
  const dependencies = { [pkg.name]: tarballs.get(pkg.name), [wasm]: tarballs.get(wasm) }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies }, null, 2))
  // YAML is a superset of JSON.
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), JSON.stringify({ overrides }, null, 2))
  copyFileSync(join(import.meta.dirname, 'installed-package-test.cjs'), join(dir, 'test.cjs'))
  execFileSync('pnpm', ['install'], { cwd: dir, stdio: 'inherit' })

  const backends = ['wasm']
  const installed = readdirSync(join(dir, 'node_modules', '.pnpm'))
  if (installed.some((entry) => entry.startsWith(`${pkg.name.replace('/', '+')}-`) && !entry.includes('wasm32'))) {
    backends.unshift('native')
  } else {
    console.log(`There's no native worker package for this platform, so only wasm is tested.`)
  }
  for (const backend of backends) {
    execFileSync('node', ['test.cjs'], { cwd: dir, stdio: 'inherit', env: { ...process.env, NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND: backend } })
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
