import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { defaultPool } from '../dist/index.js'
import { assertSimilar, fromRaw, pattern, sharp } from './helpers.ts'

const pool = defaultPool()
const photo = () => fromRaw(pattern(400, 300)).png().toBuffer()

// Always sharp's default `fit: 'cover'` and `position: 'centre'`.
describe('resize matches sharp', () => {
  const cases: [number | null, number | null][] = [
    [200, null],
    [null, 100],
    [100, 100],
    [500, 100],
    [100, 500],
    [800, 600],
    [1, 1],
    [399, 7],
  ]
  for (const [width, height] of cases) {
    for (const withoutEnlargement of [false, true]) {
      const options = { withoutEnlargement }
      test(`${width}x${height} ${JSON.stringify(options)}`, async () => {
        const input = await photo()
        const ours = await pool.prepare(input).resize(width, height, options).png().toBuffer({ resolveWithObject: true })
        const theirs = await sharp(input).resize(width, height, options).png().toBuffer({ resolveWithObject: true })
        assert.deepEqual([ours.info.width, ours.info.height], [theirs.info.width, theirs.info.height])
        // Kernels and crop rounding differ slightly. The pattern has hard edges, which exaggerates
        // small differences in tiny outputs.
        const tolerance = Math.min(ours.info.width, ours.info.height) < 16 ? 25 : 6
        await assertSimilar(ours.data, theirs.data, tolerance)
      })
    }
  }

  test('blur placeholder (like next-image-loader)', async () => {
    const input = await fromRaw(pattern(400, 300)).jpeg().toBuffer()
    const ours = await pool.prepare(input).autoOrient().resize(8, 6).jpeg({ quality: 70 }).toBuffer({ resolveWithObject: true })
    const theirs = await sharp(input).rotate().resize(8, 6).jpeg({ quality: 70 }).toBuffer({ resolveWithObject: true })
    assert.deepEqual([ours.info.width, ours.info.height], [theirs.info.width, theirs.info.height])
    await assertSimilar(ours.data, theirs.data, 25)
  })

  test('withoutReduction', async () => {
    const input = await photo()
    const ours = await pool.prepare(input).resize(100, 100, { withoutReduction: true }).toBuffer({ resolveWithObject: true })
    const theirs = await sharp(input).resize(100, 100, { withoutReduction: true }).toBuffer({ resolveWithObject: true })
    assert.deepEqual([ours.info.width, ours.info.height], [theirs.info.width, theirs.info.height])
  })

  test('resize(options) form', async () => {
    const input = await photo()
    const { info } = await pool.prepare(input).resize({ width: 50 }).toBuffer({ resolveWithObject: true })
    assert.deepEqual([info.width, info.height], [50, 38])
  })

  for (const kernel of ['nearest', 'linear', 'cubic', 'lanczos3'] as const) {
    test(`kernel ${kernel}`, async () => {
      const input = await photo()
      const ours = await pool.prepare(input).resize(123, null, { kernel }).png().toBuffer()
      const theirs = await sharp(input).resize(123, null, { kernel }).png().toBuffer()
      await assertSimilar(ours, theirs, kernel === 'nearest' ? 10 : 6)
    })
  }

  test('premultiplies alpha', async () => {
    // Transparent pixels must not bleed their color into opaque neighbors.
    const input = await fromRaw(pattern(400, 300, 4)).png().toBuffer()
    const ours = await pool.prepare(input).resize(77).png().toBuffer()
    const theirs = await sharp(input).resize(77).png().toBuffer()
    await assertSimilar(ours, theirs, 4, 4)
  })

  test('rejects outputs over the memory limit', async () => {
    const input = await photo()
    await assert.rejects(
      pool.prepare(input).limitAllocatorMemoryBytes(1024 * 1024).resize(1000, 1000).toBuffer(),
      (error: { code?: string }) => error.code === 'ERR_LIMIT_EXCEEDED',
    )
  })
})

describe('orientation matches sharp', () => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    test(`auto-orients EXIF orientation ${orientation}`, async () => {
      const input = await fromRaw(pattern(120, 80)).withMetadata({ orientation }).jpeg({ quality: 95 }).toBuffer()
      const meta = await pool.prepare(input).metadata()
      assert.equal(meta.orientation, orientation)

      const ours = await pool.prepare(input).autoOrient().png().toBuffer({ resolveWithObject: true })
      const theirs = await sharp(input).rotate().png().toBuffer({ resolveWithObject: true })
      assert.deepEqual([ours.info.width, ours.info.height], [theirs.info.width, theirs.info.height])
      assert.deepEqual([meta.autoOrient.width, meta.autoOrient.height], [theirs.info.width, theirs.info.height])
      await assertSimilar(ours.data, theirs.data, 3)
    })

    test(`auto-orients and resizes EXIF orientation ${orientation}`, async () => {
      const input = await fromRaw(pattern(120, 80)).withMetadata({ orientation }).jpeg({ quality: 95 }).toBuffer()
      const ours = await pool.prepare(input).autoOrient().resize(50, 30).png().toBuffer()
      const theirs = await sharp(input).rotate().resize(50, 30).png().toBuffer()
      await assertSimilar(ours, theirs, 8)
    })
  }

  test('ignores EXIF orientation by default, like sharp', async () => {
    const input = await fromRaw(pattern(120, 80)).withMetadata({ orientation: 6 }).jpeg().toBuffer()
    const { info } = await pool.prepare(input).png().toBuffer({ resolveWithObject: true })
    assert.deepEqual([info.width, info.height], [120, 80])
  })

  for (const angle of [90, 180, 270, -90, 450]) {
    test(`rotate(${angle})`, async () => {
      const input = await photo()
      const ours = await pool.prepare(input).rotate(angle).png().toBuffer()
      const theirs = await sharp(input).rotate(angle).png().toBuffer()
      await assertSimilar(ours, theirs, 0)
    })
  }

  test('auto-orient then rotate', async () => {
    const input = await fromRaw(pattern(120, 80)).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer()
    const ours = await pool.prepare(input).autoOrient().rotate(90).png().toBuffer()
    const theirs = await sharp(await sharp(input).rotate().toBuffer()).rotate(90).png().toBuffer()
    await assertSimilar(ours, theirs, 3)
  })

  test('rotate() ignores the EXIF orientation without autoOrient()', async () => {
    const input = await fromRaw(pattern(120, 80)).withMetadata({ orientation: 6 }).jpeg().toBuffer()
    const rotated = await pool.prepare(input).rotate(90).png().toBuffer({ resolveWithObject: true })
    assert.deepEqual([rotated.info.width, rotated.info.height], [80, 120])
    const both = await pool.prepare(input).autoOrient().rotate(90).png().toBuffer({ resolveWithObject: true })
    assert.deepEqual([both.info.width, both.info.height], [120, 80])
  })
})

describe('color management', () => {
  test('converts Display P3 to sRGB', async () => {
    const red = Buffer.alloc(32 * 32 * 3)
    for (let i = 0; i < red.length; i += 3) red[i] = 255
    const srgb = await sharp(red, { raw: { width: 32, height: 32, channels: 3 } }).png().toBuffer()
    const p3 = await sharp(srgb).withIccProfile('p3').png().toBuffer()
    assert.equal((await pool.prepare(p3).metadata()).hasProfile, true)

    // Without color management, P3 pixel values look very different.
    const [p3Raw, srgbRaw] = await Promise.all([p3, srgb].map((b) => sharp(b, { ignoreIcc: true }).raw().toBuffer()))
    assert.ok(Math.abs(p3Raw[0] - srgbRaw[0]) > 10)

    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const ours = await pool.prepare(p3)[format]().toBuffer()
      assert.equal((await sharp(ours).metadata()).hasProfile, false, 'output has no ICC profile')
      await assertSimilar(ours, srgb, 3)
    }
  })

  test('strips metadata', async () => {
    const input = await fromRaw(pattern(64, 64))
      .withMetadata({ orientation: 3 })
      .withIccProfile('srgb')
      .jpeg()
      .toBuffer()
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      const meta = await sharp(await pool.prepare(input)[format]().toBuffer()).metadata()
      assert.equal(meta.exif, undefined)
      assert.equal(meta.icc, undefined)
      assert.equal(meta.orientation, undefined)
    }
  })
})
