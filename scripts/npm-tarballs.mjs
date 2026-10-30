// The tarballs that scripts/pack-npm.mjs packs, for the scripts that test and publish them.

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export const TARBALLS_DIR = join(import.meta.dirname, '..', 'npm')

/** Every tarball in `npm/`, sorted by file name, with its `package.json`. */
export function readTarballs() {
  return readdirSync(TARBALLS_DIR)
    .filter((file) => file.endsWith('.tgz'))
    .sort()
    .map((file) => {
      const path = join(TARBALLS_DIR, file)
      const manifest = JSON.parse(execFileSync('tar', ['-xzOf', path, 'package/package.json'], { encoding: 'utf8' }))
      return { path, manifest }
    })
}
