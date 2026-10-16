// Shared by `build-native.mjs` and `build-wasm.mjs`. Runs `napi build` in a scratch directory, adjusts
// the outputs, and then copies them to the package root. Every build, native or wasm, leaves the
// same committed files (`binding.js`, `binding.d.ts`, and the WASI loaders).
//
// We adjust napi's WASI loaders:
// - napi's templates give the module the host's entire filesystem (via WASI preopens) and
//   environment variables. We need neither, so we patch them out. WASI preview1 has no other
//   network or filesystem access. This is defense in depth, not a sandbox: a compromised module can
//   still reach JS globals through the napi interface.
// - Native builds only regenerate the loaders if they (and the gitignored `.wasi.d.cts`) already
//   exist, and keep the export list in the loader's metadata header. So we seed the scratch directory
//   with the committed loader, and replace its export list with the one in `binding.js`.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
// Relative to `root`, because the command line isn't escaped on Windows.
const outputDir = 'target/napi-output'
const loader = 'blunt-image-optimization.wasi.cjs'
const loaders = [loader, 'wasi-worker.mjs']

function fail(message) {
  console.error(message)
  process.exit(1)
}

/** Runs `napi build` with extra `args`, and returns the directory containing the outputs. */
export function build(args, { env = process.env } = {}) {
  const dir = join(root, outputDir)
  // Otherwise outputs from earlier builds (e.g. for other targets) would be installed too.
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // napi reads the loader's metadata, but only uses the `.wasi.d.cts` for itself (it's gitignored).
  copyFileSync(join(root, loader), join(dir, loader))
  copyFileSync(join(root, 'binding.d.ts'), join(dir, 'blunt-image-optimization.wasi.d.cts'))

  const napi = spawnSync(
    'pnpm',
    [
      'exec',
      'napi',
      'build',
      '--platform',
      '--no-const-enum',
      '--output-dir',
      outputDir,
      '--js',
      'binding.js',
      '--dts',
      'binding.d.ts',
      ...args,
    ],
    { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' },
  )
  if (napi.status !== 0) {
    process.exit(napi.status ?? 1)
  }

  updateLoaderExports(dir)
  lockDownLoaders(dir)
  return dir
}

/**
 * Copies the outputs in `dir` to the package root. napi also writes browser loaders for the wasm
 * binding, which we skip because this package is server-only, and the WASI loader's types, which are
 * unused because it's only loaded by `binding.js`.
 */
export function install(dir) {
  for (const file of readdirSync(dir)) {
    if (['binding.js', 'binding.d.ts', ...loaders].includes(file) || /\.(node|wasm)$/.test(file)) {
      copyFileSync(join(dir, file), join(root, file))
    }
  }
}

function updateLoaderExports(dir) {
  const binding = readFileSync(join(dir, 'binding.js'), 'utf8')
  const exports = [...binding.matchAll(/^module\.exports\.(\w+) = nativeBinding\.\1$/gm)].map((match) => match[1])
  if (exports.length === 0) {
    fail('Found no exports in binding.js')
  }

  const path = join(dir, loader)
  const source = readFileSync(path, 'utf8')
  const header = /^\/\/ napi-rs-artifact-metadata:(.*)\n/.exec(source)
  // The loader ends with a line per export, for cjs-module-lexer.
  const tail = /\nmodule\.exports = __napiModule\.exports\n(?:module\.exports\.\w+ = __napiModule\.exports\.\w+\n)*$/
  if (!header || !tail.test(source)) {
    fail(`Unrecognized export list in ${loader}. Did napi's template change?`)
  }
  const metadata = JSON.parse(header[1])
  metadata.exports = exports
  const exportLines = exports.map((name) => `module.exports.${name} = __napiModule.exports.${name}\n`)
  writeFileSync(
    path,
    source
      .replace(header[0], `// napi-rs-artifact-metadata:${JSON.stringify(metadata)}\n`)
      .replace(tail, `\nmodule.exports = __napiModule.exports\n${exportLines.join('')}`),
  )
}

function lockDownLoaders(dir) {
  const preopens = /env: process\.env,(\s*)preopens: \{\s*\[__rootDir\]: __hostRoot,\s*\[__hostRoot\]: __hostRoot,\s*\},/g
  for (const file of loaders) {
    const path = join(dir, file)
    if (!existsSync(path)) {
      fail(`napi didn't generate ${file}`)
    }
    const source = readFileSync(path, 'utf8')
    const matches = source.match(preopens)?.length ?? 0
    if (matches !== 1) {
      // Fail loudly if napi's template changes, rather than silently shipping an unrestricted loader.
      fail(`Expected exactly one WASI preopens block in ${file}, found ${matches}. Did napi's template change?`)
    }
    writeFileSync(path, source.replace(preopens, 'env: {},$1preopens: {},'))
  }
}
