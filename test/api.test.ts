import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { BluntError, Pipeline, blunt, defaultPool } from '../dist/index.js'
import type { InputFormat } from '../dist/index.js'
import { fromRaw, pattern } from './helpers.ts'

const png = () => fromRaw(pattern(40, 30, 4)).png().toBuffer()

test('uses the expected backend', () => {
  // So that CI can't silently test the native backend instead of the wasm one, or vice versa.
  assert.equal(defaultPool().backend, process.env.BLUNT_IMAGE_OPTIMIZATION_BACKEND ?? 'native')
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
      const { info } = await blunt(input).toBuffer({ resolveWithObject: true })
      assert.deepEqual([info.width, info.height], [40, 30])
    }
  })

  test('rejects non-buffer input synchronously', () => {
    for (const input of ['image.png', 42, null, {}]) {
      assert.throws(() => blunt(input as never), TypeError)
    }
  })

  test('blunt() returns a Pipeline', async () => {
    assert.ok(blunt(await png()) instanceof Pipeline)
  })
})

describe('argument validation', () => {
  const cases: [string, (p: Pipeline) => unknown][] = [
    ['resize(0)', (p) => p.resize(0)],
    ['resize(-1)', (p) => p.resize(-1)],
    ['resize(1.5)', (p) => p.resize(1.5)],
    ['resize fit', (p) => p.resize(10, 10, { fit: 'stretch' as never })],
    ['resize position', (p) => p.resize(10, 10, { position: 'entropy' as never })],
    ['resize kernel', (p) => p.resize(10, 10, { kernel: 'lanczos4' as never })],
    ['resize background', (p) => p.resize(10, 10, { background: { r: 256, g: 0, b: 0 } })],
    ['rotate(45)', (p) => p.rotate(45)],
    ['blur(0.1)', (p) => p.blur(0.1)],
    ['blur(2000)', (p) => p.blur(2000)],
    ['jpeg quality 0', (p) => p.jpeg({ quality: 0 })],
    ['jpeg quality 101', (p) => p.jpeg({ quality: 101 })],
    ['png compressionLevel', (p) => p.png({ compressionLevel: 10 })],
    ['webp effort', (p) => p.webp({ effort: 7 })],
    ['gif effort', (p) => p.gif({ effort: 0 })],
    ['toFormat avif', (p) => p.toFormat('avif' as never)],
  ]
  for (const [name, call] of cases) {
    test(name, async () => {
      const pipeline = blunt(await png())
      assert.throws(() => call(pipeline), TypeError)
    })
  }

  test('constructor options', async () => {
    const input = await png()
    assert.throws(() => blunt(input, { limitInputPixels: -1 }), TypeError)
    assert.throws(() => blunt(input, { limitInputPixels: 1.5 }), TypeError)
    assert.throws(() => blunt(input, { limitAllocatorMemory: 0 }), TypeError)
  })
})

describe('output', () => {
  test('resolveWithObject', async () => {
    const { data, info } = await blunt(await png())
      .resize(20)
      .webp()
      .toBuffer({ resolveWithObject: true })
    assert.ok(Buffer.isBuffer(data))
    assert.deepEqual(info, { format: 'webp', width: 20, height: 15, channels: 4, size: data.length })
  })

  test('toFormat aliases', async () => {
    const { info } = await blunt(await png())
      .toFormat('jpg', { quality: 50 })
      .toBuffer({ resolveWithObject: true })
    assert.equal(info.format, 'jpeg')
  })

  test('the last output format wins', async () => {
    const { info } = await blunt(await png())
      .jpeg()
      .gif()
      .toBuffer({ resolveWithObject: true })
    assert.equal(info.format, 'gif')
  })

  test('pipelines can be reused', async () => {
    const pipeline = blunt(await png()).resize(10)
    const [a, b] = await Promise.all([pipeline.toBuffer(), pipeline.toBuffer()])
    assert.deepEqual(a, b)
  })

  test('errors are BluntErrors with a code', async () => {
    const error = await blunt(Buffer.from('not an image'))
      .toBuffer()
      .catch((e: unknown) => e)
    assert.ok(error instanceof BluntError)
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'BluntError')
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
      const meta = await blunt(await make()).metadata()
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
    const meta = await blunt(await png())
      .resize(10)
      .rotate(90)
      .metadata()
    assert.deepEqual([meta.width, meta.height], [40, 30])
  })
})
