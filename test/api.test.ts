import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Pipeline, SafeImageOptimizationError, defaultPool } from '../dist/index.js'
import type { InputFormat, PipelineOptions, ResizeOptions } from '../dist/index.js'
import { assertRejectsWithCode, fromRaw, pattern } from './helpers.ts'

const pool = defaultPool()
const png = () => fromRaw(pattern(40, 30, 4)).png().toBuffer()

test('uses the expected backend', () => {
  // So that CI can't silently test the native backend instead of the wasm one, or vice versa.
  assert.equal(pool.backend, process.env.NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND ?? 'native')
})

describe('input', () => {
  test('accepts Buffer, Uint8Array views, ArrayBuffer, and other typed arrays', async () => {
    const buffer = await png()
    const padded = new Uint8Array(buffer.length + 10)
    padded.set(buffer, 5)
    const inputs = [
      buffer,
      new Uint8Array(buffer),
      padded.subarray(5, 5 + buffer.length),
      new Uint8Array(buffer).buffer,
      new DataView(padded.buffer, 5, buffer.length),
    ]
    for (const input of inputs) {
      const { info } = await pool.prepare(input).toBuffer({ resolveWithObject: true })
      assert.deepEqual([info.width, info.height], [40, 30])
    }
  })

  test('rejects non-buffer input synchronously', () => {
    for (const input of ['image.png', 42, null, {}]) {
      assert.throws(() => pool.prepare(input as never), TypeError)
    }
  })

  test('prepare() returns a Pipeline', async () => {
    assert.ok(pool.prepare(await png()) instanceof Pipeline)
  })
})

describe('argument validation', () => {
  // Most options are validated by the worker, so these may throw or reject.
  const rejects = (run: () => Promise<unknown>, prefix = '') =>
    assert.rejects(
      async () => await run(),
      (error) => error instanceof TypeError && error.message.startsWith(prefix),
    )

  const cases: [string, (p: Pipeline) => Pipeline, string?][] = [
    ['resize(0)', (p) => p.resize(0), 'resize.width must be'],
    ['resize(-1)', (p) => p.resize(-1)],
    ['resize(1.5)', (p) => p.resize(1.5)],
    ['resize("10")', (p) => p.resize('10' as never), 'invalid type: string'],
    ['resize kernel', (p) => p.resize(10, 10, { kernel: 'lanczos4' as never })],
    ['resize kernel mitchell', (p) => p.resize(10, 10, { kernel: 'mitchell' as never })],
    ['resize fit', (p) => p.resize(10, 10, { fit: 'contain' } as never), 'unknown field `fit`'],
    ['resize options', (p) => p.resize(10, 10, 'cover' as never)],
    ['rotate(45)', (p) => p.rotate(45)],
    ['rotate("90")', (p) => p.rotate('90' as never)],
    ['jpeg quality 0', (p) => p.jpeg({ quality: 0 }), 'jpeg.quality must be'],
    ['jpeg quality 101', (p) => p.jpeg({ quality: 101 })],
    ['jpeg quality NaN', (p) => p.jpeg({ quality: NaN }), 'Expected a finite number for quality but received NaN'],
    ['jpeg progressive', (p) => p.jpeg({ progressive: true } as never)],
    ['jpeg mozjpeg', (p) => p.jpeg({ mozjpeg: 'yes' as never })],
    ['png compressionLevel', (p) => p.png({ compressionLevel: 10 })],
    ['png quality', (p) => p.png({ quality: 50 } as never), 'unknown field `quality`'],
    ['webp effort', (p) => p.webp({ effort: 7 })],
    ['webp quality', (p) => p.webp({ quality: () => 50 } as never), 'Expected a JSON value for quality but received a function'],
    ['webp quality bigint', (p) => p.webp({ quality: 50n } as never)],
    ['gif effort', (p) => p.gif({ effort: 0 })],
  ]
  for (const [name, call, message] of cases) {
    test(name, async () => {
      const input = await png()
      await rejects(() => call(pool.prepare(input)).toBuffer(), message)
    })
  }

  test('constructor options', async () => {
    const input = await png()
    const invalid: [PipelineOptions, string?][] = [
      [{ limitInputPixels: -1 }],
      [{ limitInputPixels: 1.5 }],
      // 0 is the only way to remove a limit.
      [{ limitInputPixels: false as never }],
      [{ limitInputPixels: true as never }],
      [{ limitAllocatorMemoryBytes: -1 }],
      [{ allowedInputFormats: [] }, 'allowedInputFormats must not be empty'],
      [{ allowedInputFormats: ['png', 'bmp' as never] }, 'unknown variant `bmp`'],
      [{ allowedInputFormats: 'png' as never }],
      [{ allowAnimated: 1 as never }],
      [{ autoOrient: 'yes' as never }, 'invalid type: string'],
      [{ failOn: 'none' } as never, 'unknown field `failOn`'],
      [{ sequentialRead: true } as never, 'unknown field `sequentialRead`'],
    ]
    for (const [options, message] of invalid) {
      await rejects(() => pool.prepare(input, options).toBuffer(), message)
    }
    // Only the limits apply to metadata().
    await rejects(() => pool.prepare(input, { failOn: 'none' } as never).metadata())
    await rejects(() => pool.prepare(input, { limitInputPixels: -1 }).metadata())
  })

  test('accepts null and undefined as unset', async () => {
    const input = await png()
    const { info } = await pool.prepare(input, { limitInputPixels: undefined })
      .resize(null, 15, { kernel: undefined })
      .png(null as never)
      .toBuffer({ resolveWithObject: true })
    assert.deepEqual([info.width, info.height], [20, 15])
  })

  test('options are copied when passed', async () => {
    const input = await png()
    const options: ResizeOptions = { width: 20 }
    const pipeline = pool.prepare(input).resize(options)
    options.kernel = 'invalid' as never
    const { info } = await pipeline.toBuffer({ resolveWithObject: true })
    assert.equal(info.width, 20)
  })
})

describe('allowedInputFormats', () => {
  test('rejects other formats before decoding', async () => {
    const input = await png()
    await pool.prepare(input, { allowedInputFormats: ['png'] }).toBuffer()
    await pool.prepare(input, { allowedInputFormats: ['jpeg', 'png'] }).metadata()
    for (const formats of [['jpeg'], ['jpeg', 'webp', 'svg']] as InputFormat[][]) {
      await assertRejectsWithCode(pool.prepare(input, { allowedInputFormats: formats }).toBuffer(), 'ERR_UNSUPPORTED_FORMAT')
      await assertRejectsWithCode(pool.prepare(input, { allowedInputFormats: formats }).metadata(), 'ERR_UNSUPPORTED_FORMAT')
    }
  })

  test('applies to svg', async () => {
    const input = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>')
    await pool.prepare(input, { allowedInputFormats: ['svg'] }).png().toBuffer()
    await assertRejectsWithCode(
      pool.prepare(input, { allowedInputFormats: ['png'] }).png().toBuffer(),
      'ERR_UNSUPPORTED_FORMAT',
    )
  })
})

describe('output', () => {
  test('resolveWithObject', async () => {
    const { data, info } = await pool.prepare(await png())
      .resize(20)
      .webp()
      .toBuffer({ resolveWithObject: true })
    assert.ok(Buffer.isBuffer(data))
    assert.deepEqual(info, { format: 'webp', width: 20, height: 15, channels: 4 })
  })

  test('the last output format wins', async () => {
    const { info } = await pool.prepare(await png())
      .jpeg()
      .gif()
      .toBuffer({ resolveWithObject: true })
    assert.equal(info.format, 'gif')
  })

  test('pipelines can be reused', async () => {
    const pipeline = pool.prepare(await png()).resize(10)
    const [a, b] = await Promise.all([pipeline.toBuffer(), pipeline.toBuffer()])
    assert.deepEqual(a, b)
  })

  test('errors are SafeImageOptimizationErrors with a code', async () => {
    const error = await pool.prepare(Buffer.from('not an image'))
      .toBuffer()
      .catch((e: unknown) => e)
    assert.ok(error instanceof SafeImageOptimizationError)
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'SafeImageOptimizationError')
    assert.equal(error.code, 'ERR_UNSUPPORTED_FORMAT')
  })
})

describe('metadata', () => {
  const fixtures: [InputFormat, () => Promise<Buffer>, boolean][] = [
    ['jpeg', () => fromRaw(pattern(40, 30)).jpeg().toBuffer(), false],
    ['png', () => fromRaw(pattern(40, 30, 4)).png().toBuffer(), true],
    ['webp', () => fromRaw(pattern(40, 30)).webp().toBuffer(), false],
    // sharp's GIF encoder always declares a transparent color index.
    ['gif', () => fromRaw(pattern(40, 30)).gif().toBuffer(), true],
    ['tiff', () => fromRaw(pattern(40, 30, 4)).tiff({ compression: 'lzw' }).toBuffer(), true],
  ]
  for (const [format, make, hasAlpha] of fixtures) {
    test(format, async () => {
      const meta = await pool.prepare(await make()).metadata()
      assert.deepEqual(meta, {
        format,
        width: 40,
        height: 30,
        hasAlpha,
        orientation: 1,
        hasProfile: false,
        autoOrient: { width: 40, height: 30 },
      })
    })
  }

  test('ignores operations', async () => {
    const meta = await pool.prepare(await png())
      .resize(10)
      .rotate(90)
      .metadata()
    assert.deepEqual([meta.width, meta.height], [40, 30])
  })
})
