#!/usr/bin/env node
// Packs every npm package into `npm/*.tgz`, for scripts/publish-npm.mjs:
//
// - `@next/safe-image-optimization`: its `dist/` (`pnpm build`), with the platform packages and
//   wasm copies as `optionalDependencies`, and the wasm package as an optional peer dependency.
//   They aren't in its package.json, so installing this repo doesn't need them to be published.
// - `@next/safe-image-optimization-<platform>`: the worker binary that CI built for the platform
//   (`safe-image-optimization-worker.<platform>`, from scripts/build-native.mjs), with `os`, `cpu`,
//   and `libc` fields, so package managers only install the one that matches.
// - `@next/safe-image-optimization-wasm32`: `safe-image-optimization.wasm`, from
//   `target/wasm32-wasip1/release/nsio_wasm.wasm` (scripts/build-wasm.mjs).
// - `@next/safe-image-optimization-{freebsd,webcontainers}-wasm`: the same, with `os` or `cpu`
//   fields, so that the module is only installed by default where there's no native worker.
//
// Every package gets the main package's version, and the binaries' packages include third-party
// notices (scripts/third-party-notices.mjs). The worker binaries must all be in packages/nsio first.
//
// Usage: node scripts/pack-npm.mjs (with cargo-about installed)

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TARBALLS_DIR as out } from './npm-tarballs.mjs'
import { platform, TARGETS } from './platforms.mjs'
import { thirdPartyNotices } from './third-party-notices.mjs'

const root = join(import.meta.dirname, '..')
const packageDir = join(root, 'packages', 'nsio')
const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const NOTICES = 'THIRD-PARTY-NOTICES.txt'
const WASM_FILE = 'safe-image-optimization.wasm'
const main = `[\`${pkg.name}\`](https://www.npmjs.com/package/${pkg.name})`

/** The fields that every package shares with the main one. */
const common = {
  version: pkg.version,
  license: pkg.license,
  repository: pkg.repository,
  homepage: pkg.homepage,
  publishConfig: pkg.publishConfig,
}
const license = { from: join(root, 'license.md') }
const optionalDependencies = {}

/**
 * Each package's manifest, and its files: their contents, or a path to copy (with a hint for how to
 * build it). The binaries' packages also get the notices for `target`.
 */
const packages = TARGETS.map((target) => {
  const name = platform(target)
  const [os, cpu, abi] = name.split('-')
  const binary = `safe-image-optimization-worker.${name}${os === 'win32' ? '.exe' : ''}`
  const packageName = `${pkg.name}-${name}`
  const description = `The ${name} worker binary for ${pkg.name}.`
  optionalDependencies[packageName] = pkg.version
  return {
    target,
    manifest: {
      name: packageName,
      description,
      ...common,
      // pnpm 12 keeps the mode from chmodSync below, but its docs say it only keeps `bin`'s.
      publishConfig: { ...common.publishConfig, executableFiles: [binary] },
      os: [os],
      cpu: [cpu],
      ...(os === 'linux' ? { libc: [abi === 'musl' ? 'musl' : 'glibc'] } : {}),
      main: 'index.js',
      files: ['index.js', binary, NOTICES],
      // Yarn PnP can't spawn a binary from inside a zip archive.
      preferUnplugged: true,
    },
    files: {
      // Tracers follow the literal require in native.ts into this entry point. The static path
      // and existsSync reference let @vercel/nft and Turbopack include the executable as an asset,
      // alongside the package metadata, without trying to load the binary as JavaScript.
      'index.js': `const { join } = require('node:path')
const { existsSync } = require('node:fs')

// Keep this path static so @vercel/nft and Turbopack include the worker in standalone output.
const worker = join(__dirname, '${binary}')
if (!existsSync(worker)) {
  throw new Error('Missing safe-image-optimization worker')
}
module.exports = worker
`,
      [binary]: {
        from: join(packageDir, binary),
        executable: true,
        hint: `Build it with scripts/build-native.mjs --target ${target}.`,
      },
      'README.md': `# ${packageName}\n\n${description} Install ${main} instead, which depends on it.\n`,
      'license.md': license,
    },
  }
})

const wasmName = `${pkg.name}-wasm32`

/** A package with the wasm module, and `fields` in its manifest. */
function wasmPackage(name, description, readme, fields = {}) {
  return {
    target: 'wasm32-wasip1',
    manifest: {
      name,
      description,
      ...common,
      ...fields,
      main: 'index.js',
      files: ['index.js', WASM_FILE, NOTICES],
    },
    files: {
      // Traceable, like the platform packages' entry points.
      'index.js': `const { join } = require('node:path')
const { existsSync } = require('node:fs')

// Keep this path static so @vercel/nft and Turbopack include the module in standalone output.
const wasm = join(__dirname, '${WASM_FILE}')
if (!existsSync(wasm)) {
  throw new Error('Missing safe-image-optimization wasm module')
}
module.exports = wasm
`,
      [WASM_FILE]: {
        from: join(root, 'target', 'wasm32-wasip1', 'release', 'nsio_wasm.wasm'),
        hint: 'Build it with `pnpm build:wasm:release`.',
      },
      'README.md': `# ${name}\n\n${description} ${readme}\n`,
      'license.md': license,
    },
  }
}

packages.push(
  wasmPackage(
    wasmName,
    `The wasm build of ${pkg.name}, for platforms without a native worker binary.`,
    `Install it alongside ${main}, which uses it when there's no native worker binary for the ` +
      'platform (or with `NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND=wasm`).',
  ),
)

// Like sharp's `@img/sharp-freebsd-wasm32` and `@img/sharp-webcontainers-wasm32`: the wasm package
// has no `os` or `cpu` fields, so as an optional dependency, it would be installed everywhere. These
// have their own copies of the module, so that their fields keep it from being installed elsewhere.
// sharp's depend on `@img/sharp-wasm32` instead, but with the wasm package as an optional peer of the
// main package (so that it's found without hoisting when it's installed directly), npm would then
// install it everywhere: its tree has every optional dependency, and the peer keeps their
// dependencies after it drops the ones for other platforms.
//
// Not `-wasm32`: pnpm 12 infers missing `os` and `cpu` fields from an `<os>-<cpu>` pair in the name,
// so it would only install `-freebsd-wasm32` where `process.arch` is `wasm32` (which is why it
// skips sharp's on FreeBSD).
for (const [platformName, description, fields] of [
  ['freebsd', 'FreeBSD', { os: ['freebsd'] }],
  // WebContainers (StackBlitz) report `process.arch` as `wasm32`.
  ['webcontainers', 'WebContainers', { cpu: ['wasm32'] }],
]) {
  const packageName = `${pkg.name}-${platformName}-wasm`
  optionalDependencies[packageName] = pkg.version
  packages.push(
    wasmPackage(
      packageName,
      `The wasm build of ${pkg.name}, for ${description}, which has no native worker binary.`,
      `Install ${main} instead, which depends on it.`,
      fields,
    ),
  )
}

// Without the fields that are only for developing this repo.
const { scripts: _scripts, devDependencies: _devDependencies, ...manifest } = pkg
packages.push({
  manifest: {
    ...manifest,
    optionalDependencies,
    // So that, when it's installed directly, it's linked where the main package can resolve it,
    // without relying on hoisting.
    peerDependencies: { [wasmName]: pkg.version },
    peerDependenciesMeta: { [wasmName]: { optional: true } },
  },
  files: {
    dist: { from: join(packageDir, 'dist'), hint: 'Build it with `pnpm build`.' },
    'README.md': { from: join(root, 'README.md') },
    'license.md': license,
  },
})

// Before generating notices (or deleting the old tarballs), so that every missing file is reported.
const missing = new Map()
for (const file of packages.flatMap(({ files }) => Object.values(files))) {
  if (typeof file !== 'string' && !existsSync(file.from)) {
    missing.set(file.from, file.hint)
  }
}
if (missing.size > 0) {
  for (const [path, hint] of missing) {
    console.error(`${path} doesn't exist.${hint ? ` ${hint}` : ''}`)
  }
  process.exit(1)
}

/** Writes a package's files to a temporary directory, and packs it into `npm/`. */
function pack(manifest, files) {
  const dir = mkdtempSync(join(tmpdir(), 'nsio-pack-'))
  try {
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    for (const [name, contents] of Object.entries(files)) {
      if (typeof contents === 'string') {
        writeFileSync(join(dir, name), contents)
      } else {
        cpSync(contents.from, join(dir, name), { recursive: true })
        if (contents.executable) {
          // CI artifacts don't keep file permissions, and the packed mode is what gets installed.
          chmodSync(join(dir, name), 0o755)
        }
      }
    }
    execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, stdio: 'inherit' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const notices = thirdPartyNotices()
rmSync(out, { recursive: true, force: true })
mkdirSync(out)
for (const { target, manifest, files } of packages) {
  pack(
    manifest,
    target === undefined ? files : { ...files, [NOTICES]: notices(target, manifest.name) },
  )
}
