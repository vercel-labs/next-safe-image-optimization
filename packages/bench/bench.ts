/**
 * Throughput benchmark: `@next/safe-image-optimization` against sharp, `@napi-rs/image`, and
 * `Bun.Image`, on the pipeline Next.js's image optimizer runs (auto-orient, resize, encode).
 *
 * The method is [@napi-rs/image's benchmark]'s: submit the same pipeline over and over, up to a
 * fixed number of images in flight at once, and report completed images per second. It differs in
 * that every image that starts is also waited for and counted (see `measure`), and that it
 * generates its own input images instead of reading one from the repository.
 *
 * Run it with `pnpm bench:release` from this directory, or `pnpm bench:release` at the root. The
 * same file runs under Bun (`pnpm bench:bun:release`), which adds the `Bun.Image` entry; everything
 * else is measured under whichever runtime it's run with, so only compare rows from the same run.
 *
 * [@napi-rs/image's benchmark]: https://github.com/Brooooooklyn/Image/blob/main/bench/bench.mjs
 */

import { createRequire } from 'node:module'
import { availableParallelism, cpus } from 'node:os'
import { parseArgs } from 'node:util'

import sharp from 'sharp'

import { buildFixture, FIXTURE_SPECS } from './fixtures.ts'
import type { Fixture } from './fixtures.ts'
import { FORMATS, libraries, QUALITY } from './libraries.ts'
import type { Format, Library } from './libraries.ts'

const require = createRequire(import.meta.url)

interface Result {
  readonly library: string
  readonly supported: boolean
  readonly opsPerSecond: number
  readonly meanLatencyMs: number
  readonly images: number
  readonly durationMs: number
  readonly outputBytes: number
}

interface Suite {
  readonly input: string
  readonly format: Format
  readonly description: string
  readonly results: Result[]
}

/**
 * Runs `fn` with `concurrency` images in flight until `images` of them have finished or
 * `maxDurationMs` has passed, and reports the rate of the ones that finished.
 */
async function measure(
  fn: () => Promise<Uint8Array>,
  options: { concurrency: number; images: number; maxDurationMs: number },
): Promise<{ images: number; durationMs: number; outputBytes: number }> {
  // Warm up: the first image of each pipeline starts workers, allocates buffers, and lets the JIT
  // see the code.
  const warmup = await Promise.all(Array.from({ length: options.concurrency }, () => fn()))
  const outputBytes = warmup[0].length

  let started = 0
  let finished = 0
  const start = performance.now()
  const deadline = start + options.maxDurationMs
  const ends: number[] = []
  // One slot: it starts an image, waits for it, and starts another, until the budget runs out. So
  // every image that starts also finishes and is counted, and the slot is busy the whole time.
  const slot = async () => {
    while (started < options.images && performance.now() < deadline) {
      started++
      await fn()
      finished++
    }
    ends.push(performance.now())
  }
  await Promise.all(Array.from({ length: options.concurrency }, slot))
  // Slots stop at slightly different times, because each one finishes the image it had started.
  // Measuring to the last of them would count a tail where the machine is only partly busy against
  // the whole run, which matters when one image takes a noticeable fraction of the window, so this
  // measures to the average slot's end instead.
  const durationMs = ends.reduce((sum, end) => sum + end - start, 0) / ends.length
  return { images: finished, durationMs, outputBytes }
}

async function runSuite(
  fixture: Fixture,
  format: Format,
  all: Library[],
  options: { concurrency: number; images: number; maxDurationMs: number },
): Promise<Suite> {
  const results: Result[] = []
  for (const library of all) {
    if (!library.supports(format)) {
      results.push({
        library: library.name,
        supported: false,
        opsPerSecond: 0,
        meanLatencyMs: 0,
        images: 0,
        durationMs: 0,
        outputBytes: 0,
      })
      continue
    }
    const job = { input: fixture.data, width: fixture.resizeWidth, format }
    const measured = await measure(() => library.run(job), options)
    results.push({
      library: library.name,
      supported: true,
      opsPerSecond: (measured.images / measured.durationMs) * 1000,
      // Every slot is busy for the whole window, so this is the per-image latency at this
      // concurrency, not the latency of a single image on an idle machine.
      meanLatencyMs: (measured.durationMs * options.concurrency) / measured.images,
      images: measured.images,
      durationMs: measured.durationMs,
      outputBytes: measured.outputBytes,
    })
  }
  return {
    input: fixture.name,
    format,
    description: fixture.description,
    results,
  }
}

function version(name: string): string {
  try {
    return (require(`${name}/package.json`) as { version: string }).version
  } catch {
    return 'unknown'
  }
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`
}

/** Indented columns. The first one is left-aligned; the rest are right-aligned if `numeric`. */
function table(rows: string[][], numeric = true): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column > 0 && numeric ? cell.padStart(widths[column]) : cell.padEnd(widths[column]),
        )
        .join('   ')
        .trimEnd(),
    )
    .map((line) => `  ${line}`)
    .join('\n')
}

function printSuite(suite: Suite): void {
  const fastest = Math.max(...suite.results.map((result) => result.opsPerSecond))
  const rows = [['library', 'ops/s', 'mean ms', 'relative', 'output']]
  for (const result of suite.results) {
    if (!result.supported) {
      rows.push([result.library, '—', '—', '—', 'unsupported'])
      continue
    }
    rows.push([
      result.library,
      result.opsPerSecond.toFixed(1),
      result.meanLatencyMs.toFixed(1),
      `${(result.opsPerSecond / fastest).toFixed(2)}x`,
      kilobytes(result.outputBytes),
    ])
  }
  console.log(`\n${suite.input} → ${suite.format.toUpperCase()} q${QUALITY[suite.format]}`)
  console.log(`  ${suite.description}\n`)
  console.log(table(rows))
}

function list<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  what: string,
): T[] {
  if (value === undefined) return [...allowed]
  const chosen = value.split(',').map((part) => part.trim())
  for (const name of chosen) {
    if (!allowed.includes(name as T)) {
      throw new Error(`unknown ${what} "${name}". Choose from: ${allowed.join(', ')}`)
    }
  }
  return chosen as T[]
}

const USAGE = `Usage: pnpm bench:release [options]

  Run it from this directory to pass options. From the repository root, turbo
  needs them after a separator: \`pnpm bench:release -- --formats webp\`.
  \`pnpm bench:bun:release\` runs the same thing under Bun, which adds Bun.Image.

  --inputs <names>       Comma-separated: ${FIXTURE_SPECS.map((spec) => spec.name).join(', ')}
  --formats <names>      Comma-separated: ${FORMATS.join(', ')}
  --libraries <names>    Comma-separated substrings of library names, e.g. "sharp,napi"
  --concurrency <n>      Images in flight at once. Default: os.availableParallelism()
  --duration <seconds>   Time limit per measurement. Default: 10
  --images <n>           Image limit per measurement. Default: 10000
  --json                 Print results as JSON instead of a table
  --help
`

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      inputs: { type: 'string' },
      formats: { type: 'string' },
      libraries: { type: 'string' },
      concurrency: { type: 'string' },
      duration: { type: 'string' },
      images: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help) {
    console.log(USAGE)
    return
  }

  const concurrency = Number(values.concurrency ?? availableParallelism())
  const maxDurationMs = Number(values.duration ?? 10) * 1000
  const images = Number(values.images ?? 10_000)
  if (!(concurrency >= 1) || !(maxDurationMs > 0) || !(images >= 1)) {
    throw new Error('--concurrency, --duration, and --images must be positive numbers')
  }
  const inputs = list(
    values.inputs,
    FIXTURE_SPECS.map((spec) => spec.name),
    'input',
  )
  const formats = list(values.formats, FORMATS, 'format')

  let chosen = await libraries(concurrency)
  if (values.libraries !== undefined) {
    const patterns = values.libraries.split(',').map((part) => part.trim().toLowerCase())
    const matches = (library: Library) =>
      patterns.some((pattern) => library.name.toLowerCase().includes(pattern))
    for (const library of chosen.filter((library) => !matches(library))) {
      await library.close()
    }
    chosen = chosen.filter(matches)
    if (chosen.length === 0) {
      throw new Error(`--libraries "${values.libraries}" matched nothing`)
    }
  }

  // Under Bun, `process.version` is the Node.js version it emulates, which isn't what ran this.
  const bun = typeof Bun === 'undefined' ? undefined : Bun.version
  const environment = {
    runtime: bun === undefined ? `Node.js ${process.version}` : `Bun ${bun}`,
    platform: `${process.platform} ${process.arch}`,
    cpu: `${cpus()[0]?.model.trim() ?? 'unknown'} x ${cpus().length}`,
    availableParallelism: availableParallelism(),
    uvThreadpoolSize:
      process.env.UV_THREADPOOL_SIZE ??
      (bun === undefined ? '(unset: libuv defaults to 4)' : '(unset: Bun has its own pool)'),
    concurrency,
    budget: `${images} images or ${maxDurationMs / 1000}s per measurement`,
    sharp: `${sharp.versions.sharp} (libvips ${sharp.versions.vips})`,
    '@napi-rs/image': version('@napi-rs/image'),
    '@next/safe-image-optimization': version('@next/safe-image-optimization'),
    worker: process.env.NEXT_SAFE_IMAGE_OPTIMIZATION_WORKER_PATH ?? '(installed package)',
  }
  if (!values.json) {
    console.log('Environment\n')
    console.log(
      table(
        Object.entries(environment).map(([key, value]) => [key, String(value)]),
        false,
      ),
    )
  }

  const suites: Suite[] = []
  try {
    for (const spec of FIXTURE_SPECS.filter((spec) => inputs.includes(spec.name))) {
      const fixture = await buildFixture(spec)
      if (!values.json) {
        console.log(
          `\nGenerated ${fixture.name}: ${fixture.width}x${fixture.height} JPEG, ${kilobytes(fixture.data.length)}`,
        )
      }
      for (const format of formats) {
        const suite = await runSuite(fixture, format, chosen, {
          concurrency,
          images,
          maxDurationMs,
        })
        suites.push(suite)
        if (!values.json) printSuite(suite)
      }
    }
  } finally {
    for (const library of chosen) {
      await library.close()
    }
  }

  if (values.json) {
    console.log(JSON.stringify({ environment, suites }, undefined, 2))
  }
}

await main()
