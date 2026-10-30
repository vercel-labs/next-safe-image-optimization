#!/usr/bin/env node
// Packs every npm package into `npm/*.tgz`, for scripts/publish-npm.mjs:
//
// - `@next/safe-image-optimization`: `dist/` (`pnpm build:js`), with the platform packages as
//   `optionalDependencies`. They aren't in package.json, so installing this repo doesn't need them
//   to be published.
// - `@next/safe-image-optimization-<platform>`: the worker binary that CI built for the platform
//   (`safe-image-optimization-worker.<platform>`, from scripts/build-native.mjs), with `os`, `cpu`,
//   and `libc` fields, so package managers only install the one that matches.
// - `@next/safe-image-optimization-wasm32`: `safe-image-optimization.wasm` (scripts/build-wasm.mjs).
//
// Every package gets package.json's version, and the binaries' packages include third-party notices
// (scripts/third-party-notices.mjs). The binaries must all be in the package root first.
//
// Usage: node scripts/pack-npm.mjs (with cargo-about installed)

import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TARBALLS_DIR as out } from './npm-tarballs.mjs'
import { platform, TARGETS } from './platforms.mjs'
import { thirdPartyNotices } from './third-party-notices.mjs'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const NOTICES = 'THIRD-PARTY-NOTICES.txt'
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
      os: [os],
      cpu: [cpu],
      ...(os === 'linux' ? { libc: [abi === 'musl' ? 'musl' : 'glibc'] } : {}),
      files: [binary, NOTICES],
      // Yarn PnP can't spawn a binary from inside a zip archive.
      preferUnplugged: true,
    },
    files: {
      [binary]: { from: join(root, binary), executable: true, hint: `Build it with scripts/build-native.mjs --target ${target}.` },
      'README.md': `# ${packageName}\n\n${description} Install ${main} instead, which depends on it.\n`,
      'license.md': license,
    },
  }
})

const wasmName = `${pkg.name}-wasm32`
const wasmDescription = `The wasm build of ${pkg.name}, for platforms without a native worker binary.`
packages.push({
  target: 'wasm32-wasip1',
  manifest: { name: wasmName, description: wasmDescription, ...common, files: ['safe-image-optimization.wasm', NOTICES] },
  files: {
    'safe-image-optimization.wasm': { from: join(root, 'safe-image-optimization.wasm'), hint: 'Build it with `pnpm build:wasm:release`.' },
    'README.md':
      `# ${wasmName}\n\n${wasmDescription} Install it alongside ${main}, which uses it when there's no ` +
      "native worker binary for the platform (or with `NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND=wasm`).\n",
    'license.md': license,
  },
})

// Without the fields that are only for developing this repo.
const { scripts, devDependencies, packageManager, ...manifest } = pkg
packages.push({
  manifest: { ...manifest, optionalDependencies },
  files: {
    dist: { from: join(root, 'dist'), hint: 'Build it with `pnpm build:js`.' },
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
  pack(manifest, target === undefined ? files : { ...files, [NOTICES]: notices(target, manifest.name) })
}
