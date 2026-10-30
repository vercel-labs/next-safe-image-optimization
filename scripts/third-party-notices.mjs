// The third-party notices in the worker and wasm packages (`THIRD-PARTY-NOTICES.txt`, see
// scripts/pack-npm.mjs): the crates' licenses from cargo-about (about.toml and about.hbs), and the
// licenses of what isn't a crate (Rust's standard library, and the libc that some targets link
// statically), from `scripts/licenses/`.

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const RULE = '='.repeat(80)

/** The crates' notices, the same for every target. Needs cargo-about. */
function crateNotices() {
  // So that cargo-about doesn't fetch anything itself (like license files from crates' repositories).
  execFileSync('cargo', ['fetch', '--locked'], { cwd: root, stdio: 'inherit' })
  const about = spawnSync('cargo', ['about', 'generate', '--workspace', '--frozen', '--fail', 'about.hbs'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  process.stderr.write(about.stderr ?? '')
  if (about.error !== undefined || about.status !== 0) {
    console.error(`cargo about failed${about.error ? `: ${about.error.message}` : ''}. Is cargo-about installed?`)
    process.exit(1)
  }
  // Like a clarification that no longer applies (see about.toml).
  if (about.stderr.includes('WARN')) {
    console.error('cargo about printed warnings')
    process.exit(1)
  }
  return about.stdout
}

/** Licenses of components that aren't crates, from `scripts/licenses/`. */
function componentNotices(target) {
  const components = [{ title: 'Rust standard library (https://github.com/rust-lang/rust)', license: 'MIT', file: 'rust.txt' }]
  if (target.endsWith('-musl')) {
    components.push({ title: 'musl libc (https://musl.libc.org)', license: 'MIT', file: 'musl.txt' })
  }
  if (target.startsWith('wasm32-')) {
    // wasi-libc's own code is Apache-2.0 WITH LLVM-exception, which doesn't require a notice in
    // binaries. These are the parts it's derived from that do.
    const repository = '(https://github.com/WebAssembly/wasi-libc)'
    components.push({ title: `musl libc, in wasi-libc ${repository}`, license: 'MIT', file: 'musl.txt' })
    components.push({ title: `cloudlibc, in wasi-libc ${repository}`, license: 'BSD-2-Clause', file: 'cloudlibc.txt' })
  }
  return components
    .map(({ title, license, file }) => {
      const text = readFileSync(join(import.meta.dirname, 'licenses', file), 'utf8').trim()
      return `\n${RULE}\n${title}\nLicense: ${license}\n${'-'.repeat(80)}\n\n${text}\n`
    })
    .join('')
}

/**
 * Runs cargo-about (once), and returns a function that formats the notices for a target's package.
 */
export function thirdPartyNotices() {
  const crates = crateNotices()
  return (target, packageName) =>
    `Third-party notices for ${packageName}\n\n` +
    'This package includes the following third-party software, under the licenses\n' +
    "below. Software that's available under a license that doesn't require a notice\n" +
    'in binaries (like Zlib, CC0-1.0, or Unlicense) is not listed.\n' +
    componentNotices(target) +
    crates
}
