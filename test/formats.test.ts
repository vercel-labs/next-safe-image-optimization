import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import sharp from 'sharp'
import type { JpegOptions as SharpJpegOptions } from 'sharp'

import { blunt } from '../dist/index.js'
import type { JpegOptions, OutputFormat } from '../dist/index.js'
import { assertRejectsWithCode, assertSimilar, formatOf, fromRaw, pattern } from './helpers.ts'

const rgb = pattern(96, 64)
const rgba = pattern(96, 64, 4)

const inputs: Record<string, () => Promise<Buffer>> = {
  'baseline jpeg': () => fromRaw(rgb).jpeg({ quality: 95 }).toBuffer(),
  'progressive jpeg': () => fromRaw(rgb).jpeg({ quality: 95, progressive: true }).toBuffer(),
  'mozjpeg jpeg': () => fromRaw(rgb).jpeg({ quality: 95, mozjpeg: true }).toBuffer(),
  'grayscale jpeg': () => fromRaw(rgb).toColourspace('b-w').jpeg({ quality: 95 }).toBuffer(),
  'cmyk jpeg': () => fromRaw(rgb).toColourspace('cmyk').jpeg({ quality: 95 }).toBuffer(),
  png: () => fromRaw(rgb).png().toBuffer(),
  'rgba png': () => fromRaw(rgba).png().toBuffer(),
  '16-bit png': () => fromRaw(rgb).toColourspace('rgb16').png().toBuffer(),
  'palette png': () => fromRaw(rgb).png({ palette: true }).toBuffer(),
  'grayscale png': () => fromRaw(rgb).toColourspace('b-w').png().toBuffer(),
  'lossy webp': () => fromRaw(rgb).webp({ quality: 95 }).toBuffer(),
  'lossy webp with alpha': () => fromRaw(rgba).webp({ quality: 95 }).toBuffer(),
  'lossless webp': () => fromRaw(rgb).webp({ lossless: true }).toBuffer(),
  gif: () => fromRaw(rgb).gif().toBuffer(),
  'interlaced gif': () => fromRaw(rgb).gif({ progressive: true }).toBuffer(),
  'transparent gif': () => fromRaw(rgba).gif().toBuffer(),
  // sharp defaults to JPEG compression, which we reject (see safety tests).
  tiff: () => fromRaw(rgb).tiff({ compression: 'none' }).toBuffer(),
  'lzw tiff': () => fromRaw(rgb).tiff({ compression: 'lzw' }).toBuffer(),
  'deflate tiff with alpha': () => fromRaw(rgba).tiff({ compression: 'deflate' }).toBuffer(),
  // A single tile that's larger than the image.
  'tiled tiff': () =>
    fromRaw(rgb).tiff({ compression: 'none', tile: true, tileWidth: 256, tileHeight: 256 }).toBuffer(),
  avif: () => fromRaw(rgb).avif({ quality: 90 }).toBuffer(),
  '4:2:0 avif': () => fromRaw(rgb).avif({ quality: 90, chromaSubsampling: '4:2:0' }).toBuffer(),
  'avif with alpha': () => fromRaw(rgba).avif({ quality: 90 }).toBuffer(),
  'lossless avif': () => fromRaw(rgb).avif({ lossless: true }).toBuffer(),
  '10-bit avif': () => fromRaw(rgb).avif({ quality: 90, bitdepth: 10 }).toBuffer(),
  '12-bit avif with alpha': () => fromRaw(rgba).avif({ quality: 90, bitdepth: 12 }).toBuffer(),
  'grayscale avif': () => fromRaw(rgb).toColourspace('b-w').avif({ quality: 90 }).toBuffer(),
}

const outputs: OutputFormat[] = ['jpeg', 'png', 'webp', 'gif']

describe('decodes and re-encodes every format', () => {
  for (const [name, make] of Object.entries(inputs)) {
    for (const format of outputs) {
      test(`${name} -> ${format}`, async () => {
        const input = await make()
        const { data, info } = await blunt(input).toFormat(format).toBuffer({ resolveWithObject: true })
        assert.equal(formatOf(data), format)
        assert.equal(info.format, format)
        assert.equal(info.size, data.length)
        assert.deepEqual([info.width, info.height], [rgb.width, rgb.height])
        const meta = await sharp(data).metadata()
        assert.deepEqual([meta.width, meta.height], [rgb.width, rgb.height])
        // GIF and palette PNGs are quantized.
        if (format !== 'gif' && !name.includes('palette')) {
          // We convert CMYK to RGB naively instead of using the embedded CMYK ICC profile.
          await assertSimilar(data, input, name.includes('cmyk') ? 40 : 8)
        }
      })
    }
  }
})

describe('output format defaults to the input format', () => {
  for (const name of ['baseline jpeg', 'png', 'lossy webp', 'gif'] as const) {
    test(name, async () => {
      const input = await inputs[name]()
      const output = await blunt(input).toBuffer()
      assert.equal(formatOf(output), formatOf(input))
    })
  }

  for (const name of ['tiff', 'avif'] as const) {
    test(`${name} has no default output format`, async () => {
      await assertRejectsWithCode(blunt(await inputs[name]()).toBuffer(), 'ERR_UNSUPPORTED_FORMAT')
    })
  }
})

describe('alpha', () => {
  test('is preserved for png and webp', async () => {
    const input = await inputs['rgba png']()
    for (const format of ['png', 'webp'] as const) {
      const { data, info } = await blunt(input).toFormat(format).toBuffer({ resolveWithObject: true })
      assert.equal(info.channels, 4)
      await assertSimilar(data, input, 4, 4)
    }
  })

  test('is flattened onto black for jpeg, like sharp', async () => {
    const input = await inputs['rgba png']()
    const { data, info } = await blunt(input).jpeg({ quality: 95 }).toBuffer({ resolveWithObject: true })
    assert.equal(info.channels, 3)
    await assertSimilar(data, await sharp(input).jpeg({ quality: 95 }).toBuffer(), 3)
  })
})

describe('avif', () => {
  test('metadata', async () => {
    const meta = await blunt(await inputs['avif with alpha']()).metadata()
    assert.deepEqual([meta.format, meta.width, meta.height, meta.hasAlpha], ['avif', rgb.width, rgb.height, true])
  })

  test('odd dimensions with chroma subsampling', async () => {
    const input = await fromRaw(pattern(97, 65)).avif({ quality: 90, chromaSubsampling: '4:2:0' }).toBuffer()
    const { data, info } = await blunt(input).png().toBuffer({ resolveWithObject: true })
    assert.deepEqual([info.width, info.height], [97, 65])
    await assertSimilar(data, input, 8)
  })

  test('alpha is preserved', async () => {
    const input = await inputs['avif with alpha']()
    const { data, info } = await blunt(input).png().toBuffer({ resolveWithObject: true })
    assert.equal(info.channels, 4)
    await assertSimilar(data, input, 8, 4)
  })
})

describe('encoder options', () => {
  test('jpeg quality affects size', async () => {
    const input = await fromRaw(pattern(256, 256)).png().toBuffer()
    const low = await blunt(input).jpeg({ quality: 20 }).toBuffer()
    const high = await blunt(input).jpeg({ quality: 95 }).toBuffer()
    assert.ok(low.length < high.length)
  })

  test('jpeg progressive and mozjpeg presets produce progressive files', async () => {
    const input = await inputs.png()
    for (const options of [{ progressive: true }, { mozjpeg: true }]) {
      const meta = await sharp(await blunt(input).jpeg(options).toBuffer()).metadata()
      assert.equal(meta.isProgressive, true)
    }
  })

  test('mozjpeg matches sharp', async () => {
    const input = await fromRaw(pattern(256, 256)).png().toBuffer()
    // sharp's preset overrides `progressive: false`, so that needs the preset's options instead.
    const baseline = { trellisQuantisation: true, overshootDeringing: true, quantisationTable: 3 }
    const cases: [JpegOptions, SharpJpegOptions][] = [
      [{}, { mozjpeg: true }],
      [{ progressive: false }, { ...baseline, progressive: false }],
      // Low qualities need baseline (8-bit) quantization tables.
      [{ quality: 20 }, { quality: 20, mozjpeg: true }],
      [{ quality: 50 }, { quality: 50, mozjpeg: true }],
      [{ quality: 95 }, { quality: 95, mozjpeg: true }],
    ]
    for (const [options, sharpOptions] of cases) {
      const ours = await blunt(input).jpeg({ ...options, mozjpeg: true }).toBuffer()
      const theirs = await sharp(input).jpeg(sharpOptions).toBuffer()
      const ratio = ours.length / theirs.length
      assert.ok(ratio > 0.95 && ratio < 1.05, `${JSON.stringify(options)}: ${ours.length} vs ${theirs.length} bytes`)
      assert.equal((await sharp(ours).metadata()).isProgressive, options.progressive ?? true)
      await assertSimilar(ours, theirs, 3)
    }
    const jpegEncoder = await blunt(input).jpeg().toBuffer()
    assert.ok((await blunt(input).jpeg({ mozjpeg: true }).toBuffer()).length < jpegEncoder.length)
  })

  test('webp lossless is lossless', async () => {
    const input = await inputs.png()
    const output = await blunt(input).webp({ lossless: true }).toBuffer()
    await assertSimilar(output, input, 0)
  })

  test('webp quality and effort affect output', async () => {
    const input = await fromRaw(pattern(256, 256)).png().toBuffer()
    const low = await blunt(input).webp({ quality: 10, effort: 0 }).toBuffer()
    const high = await blunt(input).webp({ quality: 95, effort: 6 }).toBuffer()
    assert.ok(low.length < high.length)
  })

  test('png compression level 0 is larger', async () => {
    const input = await inputs.png()
    const stored = await blunt(input).png({ compressionLevel: 0 }).toBuffer()
    const compressed = await blunt(input).png({ compressionLevel: 9 }).toBuffer()
    assert.ok(stored.length > compressed.length)
    await assertSimilar(stored, input, 0)
  })

  test('png ignores quality (sharp compatibility)', async () => {
    const input = await inputs.png()
    await assertSimilar(await blunt(input).png({ quality: 50 }).toBuffer(), input, 0)
  })

  test('grayscale stays grayscale', async () => {
    const input = await inputs['grayscale png']()
    const { info } = await blunt(input).png().toBuffer({ resolveWithObject: true })
    assert.equal(info.channels, 1)
  })
})

describe('animated input', () => {
  test('decodes the first frame of an animated gif', async () => {
    const frames = [pattern(32, 32), pattern(32, 32)].map((raw, i) =>
      fromRaw({ ...raw, data: i === 0 ? raw.data : Buffer.alloc(raw.data.length, 128) }).png().toBuffer(),
    )
    const animated = await sharp(await Promise.all(frames), { join: { animated: true } })
      .gif()
      .toBuffer()
    assert.equal((await sharp(animated).metadata()).pages, 2)
    const output = await blunt(animated).png().toBuffer()
    await assertSimilar(output, await sharp(animated).png().toBuffer(), 4)
  })

  test('decodes the first frame of an animated webp', async () => {
    const frames = [pattern(32, 32), pattern(32, 32)].map((raw, i) =>
      fromRaw({ ...raw, data: i === 0 ? raw.data : Buffer.alloc(raw.data.length, 128) }).png().toBuffer(),
    )
    const animated = await sharp(await Promise.all(frames), { join: { animated: true } })
      .webp({ lossless: true })
      .toBuffer()
    const output = await blunt(animated).png().toBuffer()
    await assertSimilar(output, await sharp(animated).png().toBuffer(), 1, 4)
  })
})
