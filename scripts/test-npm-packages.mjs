#!/usr/bin/env node
// Installs the tarballs that scripts/pack-npm.mjs packed into `npm/`, the way users install the
// published packages, and processes an image (scripts/installed-package-test.cjs) with this
// platform's native worker (if there's a package for it), and with the wasm build. Catches packaging
// mistakes, like a missing file or executable bit, or `os`/`cpu`/`libc` fields that don't match.
// Then it does the same with the wasm build from the FreeBSD and WebContainers packages.
//
// The other packages are overridden to their tarballs, since they may not be published yet.
//
// Usage: node scripts/test-npm-packages.mjs

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTarballs } from './npm-tarballs.mjs'

const packageDir = join(import.meta.dirname, '..', 'packages', 'nsio')
const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const tarballs = new Map(
  readTarballs().map(({ path, manifest }) => [manifest.name, `file:${path}`]),
)
const wasm = `${pkg.name}-wasm32`
const overrides = Object.fromEntries(
  [...tarballs].filter(([name]) => name !== pkg.name && name !== wasm),
)
// Without the variables that would replace the installed binaries.
const {
  NEXT_SAFE_IMAGE_OPTIMIZATION_WORKER_PATH: _workerPath,
  NEXT_SAFE_IMAGE_OPTIMIZATION_WASM_PATH: _wasmPath,
  ...env
} = process.env

/**
 * Installs `dependencies` into an `app` package in a temporary pnpm workspace, with `settings` in
 * its `pnpm-workspace.yaml`, and calls `run` with the workspace's directory. Without hoisting, and
 * since `app/node_modules` isn't an ancestor of the packages' directories in the root's
 * `node_modules/.pnpm`, packages can only resolve what their package.json declares.
 */
function withInstall(dependencies, settings, run) {
  const dir = mkdtempSync(join(tmpdir(), 'nsio-test-packages-'))
  try {
    mkdirSync(join(dir, 'app'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true }, null, 2))
    writeFileSync(
      join(dir, 'app', 'package.json'),
      JSON.stringify({ private: true, dependencies }, null, 2),
    )
    // YAML is a superset of JSON.
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      JSON.stringify({ packages: ['app'], hoist: false, overrides, ...settings }, null, 2),
    )
    copyFileSync(
      join(import.meta.dirname, 'installed-package-test.cjs'),
      join(dir, 'app', 'test.cjs'),
    )
    execFileSync('pnpm', ['install'], { cwd: dir, stdio: 'inherit' })
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function test(dir, backend) {
  execFileSync('node', ['test.cjs'], {
    cwd: join(dir, 'app'),
    stdio: 'inherit',
    env: { ...env, NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND: backend },
  })
}

// The wasm package is resolvable because it's an optional peer dependency.
withInstall({ [pkg.name]: tarballs.get(pkg.name), [wasm]: tarballs.get(wasm) }, {}, (dir) => {
  const backends = ['wasm']
  const installed = readdirSync(join(dir, 'node_modules', '.pnpm'))
  if (
    installed.some(
      (entry) => entry.startsWith(`${pkg.name.replace('/', '+')}-`) && !entry.includes('wasm'),
    )
  ) {
    backends.unshift('native')
  } else {
    console.log(`There's no native worker package for this platform, so only wasm is tested.`)
  }
  for (const backend of backends) {
    test(dir, backend)
  }
})

// Without the wasm package as a direct dependency, but installing its copies as if this were
// FreeBSD or WebContainers, so the main package can only find the module through them.
withInstall(
  { [pkg.name]: tarballs.get(pkg.name) },
  { supportedArchitectures: { os: ['current', 'freebsd'], cpu: ['current', 'wasm32'] } },
  (dir) => test(dir, 'wasm'),
)
