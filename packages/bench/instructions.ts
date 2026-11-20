/**
 * Instruction counts: how many CPU instructions the worker executes for each of the throughput
 * benchmark's pipelines (auto-orient, resize, encode), counted with Valgrind's cachegrind. Unlike
 * the throughput benchmark, the count barely depends on the machine or what else is running on it,
 * so CI can compare a pull request against its base branch on a shared runner.
 *
 * It runs `crates/core/examples/instructions.rs`, which handles one request with
 * `nsio_core::protocol::handle`, without the worker's process setup or seccomp filters (which
 * Valgrind can't run under). Build it with:
 *
 * ```sh
 * cargo build --release --locked --example instructions -p nsio-core
 * ```
 *
 * Then, with Valgrind installed (Linux only):
 *
 * ```sh
 * pnpm instructions                                       # the build in target/release
 * pnpm instructions --base <harness> --head <harness>    # compare two builds
 * ```
 *
 * The count includes starting the process and reading the request, which don't depend on the
 * worker's code. Valgrind's simulated CPU may not report every extension the real one has (like
 * AVX-512), so SIMD code can take different paths than it would natively, though the same ones for
 * both builds. It measures work, not time: cache misses, branch mispredictions, and the cost of each
 * instruction don't count.
 */

import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'

import { buildFixture, FIXTURE_SPECS } from './fixtures.ts'

const run = promisify(execFile)

/** The throughput benchmark's settings (`QUALITY` in `libraries.ts`), for the formats we encode. */
const FORMATS = { webp: { quality: 75 }, jpeg: { quality: 75 } } as const

/**
 * The pull request label that CI's `instructions` job checks for: with it, the job reports increases
 * without passing `--max-increase` (see `.github/workflows/build_and_test.yml`).
 */
const SKIP_LABEL = 'skip-benchmark'

const DEFAULT_HARNESS = new URL('../../target/release/examples/instructions', import.meta.url)
  .pathname

const { values } = parseArgs({
  options: {
    head: { type: 'string', default: DEFAULT_HARNESS },
    base: { type: 'string' },
    markdown: { type: 'string' },
    'max-increase': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(`Usage: node instructions.ts [options]

Options:
  --head <path>           The harness to measure (default: ${DEFAULT_HARNESS})
  --base <path>           A harness built from the base branch, to compare against
  --markdown <path>       Also append the results to this file as a Markdown table
                          (like $GITHUB_STEP_SUMMARY)
  --max-increase <pct>    Exit with 1 if any case's count grows by more than this percentage
  -h, --help              Show this message`)
  process.exit(0)
}

const maxIncrease =
  values['max-increase'] === undefined ? undefined : Number(values['max-increase'])
if (maxIncrease !== undefined && !(maxIncrease >= 0)) {
  throw new TypeError(`--max-increase must be a non-negative number, got ${values['max-increase']}`)
}

interface Case {
  readonly name: string
  readonly file: string
}

/** Writes each fixture and format as a request in the worker's format. */
async function writeRequests(dir: string): Promise<Case[]> {
  const cases: Case[] = []
  for (const spec of FIXTURE_SPECS) {
    const fixture = await buildFixture(spec)
    for (const [format, options] of Object.entries(FORMATS)) {
      // What `toBuffer()` in `packages/nsio/index.ts` sends for
      // `pool.prepare(input).autoOrient().resize(width).<format>(options)`.
      const json = Buffer.from(
        JSON.stringify({
          transform: {
            autoOrient: true,
            resize: { width: fixture.resizeWidth },
            format,
            [format]: options,
          },
        }),
      )
      const length = Buffer.alloc(4)
      length.writeUInt32LE(json.length)
      const name = `${fixture.name} → ${format}`
      const file = join(dir, `${fixture.name}-${format}.request`)
      await writeFile(file, Buffer.concat([fixture.data, json, length]))
      cases.push({ name, file })
    }
  }
  return cases
}

/** Runs the harness on one request under cachegrind, and returns the instruction count. */
async function count(harness: string, request: string): Promise<number> {
  const { stdout, stderr } = await run(
    'valgrind',
    ['--tool=cachegrind', '--cache-sim=no', '--cachegrind-out-file=/dev/null', harness, request],
    { maxBuffer: 16 * 1024 * 1024 },
  )
  const response = JSON.parse(stdout) as { type: string; meta: unknown }
  if (response.type !== 'transform') {
    throw new Error(`${harness} failed on ${request}: ${stdout.trim()}`)
  }
  const match = /I\s+refs:\s+([\d,]+)/.exec(stderr)
  if (!match) {
    throw new Error(`no instruction count in Valgrind's output:\n${stderr}`)
  }
  return Number(match[1].replaceAll(',', ''))
}

/** Runs `tasks` with at most `limit` at once. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = Array.from({ length: tasks.length })
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++
      results[index] = await tasks[index]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

const integer = new Intl.NumberFormat('en-US')
const signed = new Intl.NumberFormat('en-US', { signDisplay: 'exceptZero' })
const percent = new Intl.NumberFormat('en-US', {
  signDisplay: 'exceptZero',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

interface Row {
  readonly name: string
  readonly base?: number
  readonly head: number
}

function change(row: Row): number | undefined {
  return row.base === undefined ? undefined : ((row.head - row.base) / row.base) * 100
}

function table(rows: Row[]): string[] {
  const compare = rows.some((row) => row.base !== undefined)
  const header = compare
    ? ['Case', 'Base', 'Head', 'Change', 'Change (%)']
    : ['Case', 'Instructions']
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
  ]
  for (const row of rows) {
    const cells = [row.name]
    if (compare && row.base !== undefined) {
      cells.push(
        integer.format(row.base),
        integer.format(row.head),
        signed.format(row.head - row.base),
        `${percent.format(change(row)!)}%`,
      )
    } else {
      cells.push(integer.format(row.head))
    }
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return lines
}

const dir = await mkdtemp(join(tmpdir(), 'nsio-instructions-'))
try {
  const cases = await writeRequests(dir)
  const harnesses = values.base === undefined ? [values.head] : [values.base, values.head]
  // Valgrind runs each program on one thread, so these can run side by side without affecting the
  // counts.
  const counts = await pool(
    cases.flatMap((c) => harnesses.map((harness) => () => count(harness, c.file))),
    availableParallelism(),
  )
  const rows: Row[] = cases.map((c, i) =>
    values.base === undefined
      ? { name: c.name, head: counts[i] }
      : { name: c.name, base: counts[i * 2], head: counts[i * 2 + 1] },
  )

  const lines = table(rows)
  console.log(lines.join('\n'))
  if (values.markdown !== undefined) {
    const title = '### Instruction counts'
    const note =
      'Instructions executed per image, counted with Valgrind (cachegrind). ' +
      'Lower is better. This counts work, not time.'
    await appendFile(values.markdown, [title, '', note, '', ...lines, ''].join('\n'))
  }

  if (maxIncrease !== undefined) {
    const regressions = rows
      .filter((row) => (change(row) ?? 0) > maxIncrease)
      .map(
        (row) =>
          `${row.name}: ${percent.format(change(row)!)}% more instructions (limit: +${maxIncrease}%)`,
      )
    if (regressions.length > 0) {
      const hint =
        `If this regression is acceptable, add the \`${SKIP_LABEL}\` label to the pull request ` +
        'and re-run this job.'
      console.error(['Instruction count regression:', ...regressions, '', hint].join('\n'))
      if (process.env.GITHUB_ACTIONS === 'true') {
        // An annotation, so it shows on the pull request's checks without opening the log. Workflow
        // commands escape `%`, carriage returns, and newlines.
        const message = [...regressions, hint]
          .join('\n')
          .replaceAll('%', '%25')
          .replaceAll('\r', '%0D')
          .replaceAll('\n', '%0A')
        console.log(`::error title=Instruction count regression::${message}`)
      }
      if (values.markdown !== undefined) {
        const list = regressions.map((regression) => `- ${regression}`)
        await appendFile(
          values.markdown,
          ['', '**Instruction count regression:**', '', ...list, '', hint, ''].join('\n'),
        )
      }
      process.exitCode = 1
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}
