#!/usr/bin/env node
// Publishes the tarballs that scripts/pack-npm.mjs packed into `npm/`, with `pnpm publish`: the
// platform and wasm packages first, then the main package, which depends on them. Versions that are
// already in the registry are skipped, so this can be rerun after a partial failure. A failed
// publish is retried a couple of times, for transient errors (like the registry's, or provenance
// signing's), and stops the script, so that the main package isn't published without the others.
//
// The dist-tag is `latest`, or a prerelease's first identifier (`canary` for `1.2.3-canary.0`, or
// `next` if it's a number), unless `--tag` is passed. Other arguments (like `--dry-run` or
// `--provenance`) are passed to `pnpm publish`.
//
// Usage: node scripts/publish-npm.mjs [pnpm publish arguments]

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { readTarballs, TARBALLS_DIR as dir } from './npm-tarballs.mjs'
import { platform, TARGETS } from './platforms.mjs'

const root = join(import.meta.dirname, '..')
const REGISTRY = 'https://registry.npmjs.org'
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const args = process.argv.slice(2)

const tarballs = readTarballs().map(({ path, manifest }) => {
  if (manifest.version !== pkg.version) {
    throw new Error(`${path} is version ${manifest.version}, but package.json's is ${pkg.version}`)
  }
  return { path, name: manifest.name, manifest }
})
const main = tarballs.find((tarball) => tarball.name === pkg.name)
if (main === undefined) {
  throw new Error(`there's no tarball for ${pkg.name} in ${dir}. Run scripts/pack-npm.mjs first.`)
}
const binaries = TARGETS.map((target) => {
  const name = platform(target)
  return [
    `${pkg.name}-${name}`,
    `safe-image-optimization-worker.${name}${name.startsWith('win32-') ? '.exe' : ''}`,
  ]
})
binaries.push([`${pkg.name}-wasm32`, 'safe-image-optimization.wasm'])
for (const [name, binary] of binaries) {
  const tarball = tarballs.find((tarball) => tarball.name === name)
  if (tarball === undefined) {
    throw new Error(`there's no tarball for ${name} in ${dir}. Run scripts/pack-npm.mjs first.`)
  }
  const files = execFileSync('tar', ['-tzf', tarball.path], { encoding: 'utf8' }).split('\n')
  if (!files.includes(`package/${binary}`)) {
    throw new Error(`${tarball.path} is missing ${binary}`)
  }
}
for (const dependency of Object.keys(main.manifest.optionalDependencies ?? {})) {
  if (!tarballs.some((tarball) => tarball.name === dependency)) {
    throw new Error(`there's no tarball for ${dependency}, which ${pkg.name} depends on`)
  }
}

const prerelease = pkg.version.match(/^[^-+]*-([0-9A-Za-z-]+)/)?.[1]
const distTag = prerelease === undefined ? 'latest' : /^\d+$/.test(prerelease) ? 'next' : prerelease
const tag = args.some((arg) => arg === '--tag' || arg.startsWith('--tag='))
  ? []
  : [`--tag=${distTag}`]
const dryRun = args.includes('--dry-run')
/** Seconds to wait before each retry of a failed publish. */
const RETRY_DELAYS = [10, 30]

/** Whether `name@version` is in the registry. */
async function published(name, version) {
  const response = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}/${version}`)
  if (response.status === 404) {
    return false
  }
  if (!response.ok) {
    throw new Error(
      `checking for ${name}@${version} failed: ${response.status} ${response.statusText}`,
    )
  }
  return true
}

/** Whether `name@version` shows up in the registry within a few seconds (a new version can lag). */
async function appears(name, version) {
  for (let i = 0; i < 3; i++) {
    if (await published(name, version).catch(() => false)) {
      return true
    }
    await sleep(5_000)
  }
  return false
}

async function publish(tarball) {
  const label = `${tarball.name}@${pkg.version}`
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync(
        'pnpm',
        [
          'publish',
          tarball.path,
          '--access=public',
          '--no-git-checks',
          '--ignore-scripts',
          ...tag,
          ...args,
        ],
        { cwd: dir, stdio: 'inherit' },
      )
      return
    } catch (error) {
      // It may have been published anyway: if the connection dropped after the upload, or if an
      // earlier attempt succeeded, and this one failed because the version already existed.
      if (!dryRun && (await appears(tarball.name, pkg.version))) {
        console.log(`${label} was published, despite the error`)
        return
      }
      if (attempt === RETRY_DELAYS.length) {
        throw error
      }
    }
    console.error(`Publishing ${label} failed. Retrying in ${RETRY_DELAYS[attempt]}s.`)
    await sleep(RETRY_DELAYS[attempt] * 1_000)
  }
}

for (const tarball of [...tarballs.filter((tarball) => tarball !== main), main]) {
  if (await published(tarball.name, pkg.version)) {
    console.log(`${tarball.name}@${pkg.version} is already published`)
    continue
  }
  await publish(tarball)
}
