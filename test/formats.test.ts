import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { defaultPool } from '../dist/index.js'
import type { OutputFormat } from '../dist/index.js'
import {
  assertRejectsWithCode,
  assertSimilar,
  crc32,
  formatOf,
  fromRaw,
  pattern,
  sharp,
} from './helpers.ts'

const pool = defaultPool()
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
    fromRaw(rgb)
      .tiff({ compression: 'none', tile: true, tileWidth: 256, tileHeight: 256 })
      .toBuffer(),
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
        const { data, info } = await pool
          .prepare(input)
          [format]()
          .toBuffer({ resolveWithObject: true })
        assert.equal(formatOf(data), format)
        assert.equal(info.format, format)
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
      const output = await pool.prepare(input).toBuffer()
      assert.equal(formatOf(output), formatOf(input))
    })
  }

  for (const name of ['tiff', 'avif'] as const) {
    test(`${name} has no default output format`, async () => {
      await assertRejectsWithCode(
        pool.prepare(await inputs[name]()).toBuffer(),
        'ERR_UNSUPPORTED_FORMAT',
      )
    })
  }
})

describe('alpha', () => {
  test('is preserved for png and webp', async () => {
    const input = await inputs['rgba png']()
    for (const format of ['png', 'webp'] as const) {
      const { data, info } = await pool
        .prepare(input)
        [format]()
        .toBuffer({ resolveWithObject: true })
      assert.equal(info.channels, 4)
      await assertSimilar(data, input, 4, 4)
    }
  })

  test('is flattened onto black for jpeg, like sharp', async () => {
    const input = await inputs['rgba png']()
    const { data, info } = await pool
      .prepare(input)
      .jpeg({ quality: 95 })
      .toBuffer({ resolveWithObject: true })
    assert.equal(info.channels, 3)
    await assertSimilar(data, await sharp(input).jpeg({ quality: 95 }).toBuffer(), 3)
  })
})

describe('avif', () => {
  test('metadata', async () => {
    const meta = await pool.prepare(await inputs['avif with alpha']()).metadata()
    assert.deepEqual(
      [meta.format, meta.width, meta.height, meta.hasAlpha],
      ['avif', rgb.width, rgb.height, true],
    )
  })

  test('odd dimensions with chroma subsampling', async () => {
    const input = await fromRaw(pattern(97, 65))
      .avif({ quality: 90, chromaSubsampling: '4:2:0' })
      .toBuffer()
    const { data, info } = await pool.prepare(input).png().toBuffer({ resolveWithObject: true })
    assert.deepEqual([info.width, info.height], [97, 65])
    await assertSimilar(data, input, 8)
  })

  test('alpha is preserved', async () => {
    const input = await inputs['avif with alpha']()
    const { data, info } = await pool.prepare(input).png().toBuffer({ resolveWithObject: true })
    assert.equal(info.channels, 4)
    await assertSimilar(data, input, 8, 4)
  })
})

describe('svg', () => {
  const svg = (input: Buffer) => pool.prepare(input).allowInputFormats(['svg'])

  /** Like Satori's output for OG images: text is already converted to paths. */
  async function ogImage(): Promise<Buffer> {
    const photo = await fromRaw(pattern(40, 30)).jpeg({ quality: 95 }).toBuffer()
    return Buffer.from(`<svg width="120" height="63" viewBox="0 0 120 63" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#9333ea"/>
        </linearGradient>
        <clipPath id="round"><rect x="70" y="10" width="40" height="30" rx="6"/></clipPath>
      </defs>
      <rect width="120" height="63" fill="url(#bg)"/>
      <path d="M10 20h20v4H10zM10 30h40v4H10z" fill="#fff" fill-opacity="0.9"/>
      <image x="70" y="10" width="40" height="30" clip-path="url(#round)"
        href="data:image/jpeg;base64,${photo.toString('base64')}"/>
      <circle cx="20" cy="48" r="8" fill="none" stroke="#fbbf24" stroke-width="2"/>
    </svg>`)
  }

  async function isBlank(png: Buffer): Promise<boolean> {
    const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    return data.every((byte) => byte === 0)
  }

  test('metadata', async () => {
    const input = await ogImage()
    const meta = await svg(input).metadata()
    const theirs = await sharp(input).metadata()
    assert.deepEqual([meta.format, meta.width, meta.height, meta.hasAlpha], ['svg', 120, 63, true])
    assert.deepEqual(
      [theirs.format, theirs.width, theirs.height, theirs.hasAlpha],
      ['svg', 120, 63, true],
    )
  })

  test('renders like sharp, with png as the default output', async () => {
    const input = await ogImage()
    const { data, info } = await svg(input).toBuffer({ resolveWithObject: true })
    assert.equal(info.format, 'png')
    assert.deepEqual([info.width, info.height, info.channels], [120, 63, 4])
    await assertSimilar(data, await sharp(input).png().toBuffer(), 3, 4)
  })

  test('renders at the resized size, like sharp', async () => {
    const input = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
    )
    for (const [width, height] of [
      [500, null],
      [7, null],
      [300, 120],
    ] as const) {
      const ours = await svg(input).resize(width, height).png().toBuffer()
      const theirs = await sharp(input).resize(width, height).png().toBuffer()
      // Edges would be blurry if we rasterized at 10x10 and then upscaled.
      await assertSimilar(ours, theirs, 1, 4)
    }
  })

  test('only loads data urls', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nsio-svg-'))
    try {
      const file = path.join(dir, 'red.png')
      await writeFile(
        file,
        await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } })
          .png()
          .toBuffer(),
      )
      for (const href of [file, `file://${file}`, 'red.png']) {
        const input = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><image width="4" height="4" href="${href}"/></svg>`,
        )
        assert.ok(await isBlank(await svg(input).png().toBuffer()), href)
      }
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('text is not rendered', async () => {
    const input = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text y="15" font-size="16">Hi</text></svg>',
    )
    assert.ok(await isBlank(await svg(input).png().toBuffer()))
  })

  test('svgz is not supported', async () => {
    const input = gzipSync(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'),
    )
    await assertRejectsWithCode(svg(input).png().toBuffer(), 'ERR_UNSUPPORTED_FORMAT')
  })

  test('limitInputPixels applies to the rendered size', async () => {
    const input = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
    await svg(input).limitInputPixels(400).resize(20).png().toBuffer()
    await assertRejectsWithCode(
      svg(input).limitInputPixels(400).resize(30).png().toBuffer(),
      'ERR_LIMIT_EXCEEDED',
    )
  })
})

describe('encoder options', () => {
  test('jpeg quality affects size', async () => {
    const input = await fromRaw(pattern(256, 256)).png().toBuffer()
    const low = await pool.prepare(input).jpeg({ quality: 20 }).toBuffer()
    const high = await pool.prepare(input).jpeg({ quality: 95 }).toBuffer()
    assert.ok(low.length < high.length)
  })

  test('mozjpeg matches sharp', async () => {
    const input = await fromRaw(pattern(256, 256)).png().toBuffer()
    // Low qualities need baseline (8-bit) quantization tables.
    for (const quality of [20, 50, 80, 95]) {
      const ours = await pool.prepare(input).jpeg({ quality, mozjpeg: true }).toBuffer()
      const theirs = await sharp(input).jpeg({ quality, mozjpeg: true }).toBuffer()
      const ratio = ours.length / theirs.length
      assert.ok(
        ratio > 0.95 && ratio < 1.05,
        `quality ${quality}: ${ours.length} vs ${theirs.length} bytes`,
      )
      await assertSimilar(ours, theirs, 3)
    }
    const jpegEncoder = await pool.prepare(input).jpeg().toBuffer()
    assert.ok(
      (await pool.prepare(input).jpeg({ mozjpeg: true }).toBuffer()).length < jpegEncoder.length,
    )
  })

  test('webp lossless is lossless', async () => {
    const input = await inputs.png()
    const output = await pool.prepare(input).webp({ lossless: true }).toBuffer()
    await assertSimilar(output, input, 0)
  })

  test('webp quality and effort affect output', async () => {
    const input = await fromRaw(pattern(256, 256)).png().toBuffer()
    const low = await pool.prepare(input).webp({ quality: 10, effort: 0 }).toBuffer()
    const high = await pool.prepare(input).webp({ quality: 95, effort: 6 }).toBuffer()
    assert.ok(low.length < high.length)
  })

  test('png compression level 0 is larger', async () => {
    const input = await inputs.png()
    const stored = await pool.prepare(input).png({ compressionLevel: 0 }).toBuffer()
    const compressed = await pool.prepare(input).png({ compressionLevel: 9 }).toBuffer()
    assert.ok(stored.length > compressed.length)
    await assertSimilar(stored, input, 0)
  })

  test('grayscale stays grayscale', async () => {
    const input = await inputs['grayscale png']()
    const { info } = await pool.prepare(input).png().toBuffer({ resolveWithObject: true })
    assert.equal(info.channels, 1)
  })
})

describe('animated input', () => {
  /** Two frames, so the first frame is distinguishable. */
  async function animated(format: 'gif' | 'webp'): Promise<Buffer> {
    const frames = [pattern(32, 32), pattern(32, 32)].map((raw, i) =>
      fromRaw({ ...raw, data: i === 0 ? raw.data : Buffer.alloc(raw.data.length, 128) })
        .png()
        .toBuffer(),
    )
    const image = sharp(await Promise.all(frames), { join: { animated: true } })
    return format === 'gif' ? image.gif().toBuffer() : image.webp({ lossless: true }).toBuffer()
  }

  /** sharp can't write APNGs, so this inserts an `acTL` chunk (2 frames) before the `IDAT`. */
  async function apng(): Promise<Buffer> {
    const png = await fromRaw(pattern(32, 32)).png().toBuffer()
    const idat = png.indexOf('IDAT') - 4
    const chunk = Buffer.alloc(20)
    chunk.writeUInt32BE(8, 0)
    chunk.write('acTL', 4, 'latin1')
    chunk.writeUInt32BE(2, 8)
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 16)), 16)
    return Buffer.concat([png.subarray(0, idat), chunk, png.subarray(idat)])
  }

  test('decodes the first frame of an animated gif', async () => {
    const input = await animated('gif')
    assert.equal((await sharp(input).metadata()).pages, 2)
    const output = await pool.prepare(input).png().toBuffer()
    await assertSimilar(output, await sharp(input).png().toBuffer(), 4)
  })

  test('decodes the first frame of an animated webp', async () => {
    const input = await animated('webp')
    const output = await pool.prepare(input).png().toBuffer()
    await assertSimilar(output, await sharp(input).png().toBuffer(), 1, 4)
  })

  test('decodes the default image of an apng', async () => {
    const input = await apng()
    assert.equal((await pool.prepare(input).metadata()).format, 'png')
    await assertSimilar(await pool.prepare(input).png().toBuffer(), input, 0)
  })

  test("animated('reject') rejects animations", async () => {
    // sharp can't write AVIF sequences either. The brand is checked before parsing anything else.
    const avis = await fromRaw(pattern(32, 32)).avif().toBuffer()
    avis.write('avis', 8, 'latin1')
    for (const input of [await animated('gif'), await animated('webp'), await apng(), avis]) {
      await assertRejectsWithCode(
        pool.prepare(input).animated('reject').png().toBuffer(),
        'ERR_ANIMATED',
      )
      await assertRejectsWithCode(pool.prepare(input).animated('reject').metadata(), 'ERR_ANIMATED')
    }
  })

  test("animated('reject') accepts still images", async () => {
    for (const name of [
      'png',
      'gif',
      'lossy webp',
      'lossy webp with alpha',
      'avif',
      'baseline jpeg',
      'tiff',
    ]) {
      await pool
        .prepare(await inputs[name]())
        .animated('reject')
        .png()
        .toBuffer()
    }
  })
})
