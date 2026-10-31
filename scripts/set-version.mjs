#!/usr/bin/env node
// Sets the version of every package: the JS package's package.json, the Cargo workspace (which the
// worker checks against the JS package's), and Cargo.lock. The platform and wasm packages get theirs
// from the JS package when they're packed (scripts/pack-npm.mjs).
//
// Usage: node scripts/set-version.mjs <version>

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const version = process.argv[2]
if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/set-version.mjs <version>, like 1.2.3 or 1.2.3-canary.0')
  process.exit(1)
}

/** Replaces exactly one match of `pattern` (whose first group is kept) in a file. */
function replace(file, pattern, replacement) {
  const path = join(root, file)
  const text = readFileSync(path, 'utf8')
  if (text.match(new RegExp(pattern.source, `${pattern.flags}g`))?.length !== 1) {
    console.error(`couldn't find the version in ${file}`)
    process.exit(1)
  }
  writeFileSync(path, text.replace(pattern, `$1${replacement}`))
}

replace(
  join('packages', 'nsio', 'package.json'),
  /^(  "version": )"[^"]*"/m,
  JSON.stringify(version),
)
replace('Cargo.toml', /(\[workspace\.package\][^[]*?\nversion = )"[^"]*"/, JSON.stringify(version))
const cargo = spawnSync('cargo', ['update', '--workspace'], { cwd: root, stdio: 'inherit' })
process.exit(cargo.status ?? 1)
