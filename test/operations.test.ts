import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import sharp from 'sharp'

import { blunt } from '../dist/index.js'
import type { Fit, Position } from '../dist/index.js'
import { assertSimilar, fromRaw, pattern } from './helpers.ts'

const photo = () => fromRaw(pattern(400, 300)).png().toBuffer()

describe('resize matches sharp', () => {
  const fits: Fit[] = ['cover', 'contain', 'fill', 'inside', 'outside']
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
  for (const fit of fits) {
    for (const [width, height] of cases) {
      for (const withoutEnlargement of [false, true]) {
        const options = { fit, withoutEnlargement }
        test(`${width}x${height} ${JSON.stringify(options)}`, async () => {
          const input = await photo()
          const ours = await blunt(input).resize(width, height, options).png().toBuffer({ resolveWithObject: true })
          const theirs = await sharp(input).resize(width, height, options).png().toBuffer({ resolveWithObject: true })
          assert.deepEqual([ours.info.width, ours.info.height], [theirs.info.width, theirs.info.height])
          // Kernels and crop rounding differ slightly. The pattern has hard edges, which exaggerates
          // small differences in tiny outputs.
          const tolerance = Math.min(ours.info.width, ours.info.height) < 16 ? 25 : 6
          await assertSimilar(ours.data, theirs.data, tolerance)
        })
      }
    }
  }

  test('withoutReduction', async () => {
    const input = await photo()
    const ours = await blunt(input).resize(100, 100, { withoutReduction: true }).toBuffer({ resolveWithObject: true })
    const theirs = await sharp(input).resize(100, 100, { withoutReduction: true }).toBuffer({ resolveWithObject: true })
    assert.deepEqual([ours.info.width, ours.info.height], [theirs.info.width, theirs.info.height])
  })

  test('resize(options) form', async () => {
    const input = await photo()
    const { info } = await blunt(input).resize({ width: 50 }).toBuffer({ resolveWithObject: true })
    assert.deepEqual([info.width, info.height], [50, 38])
  })

  const positions: Position[] = ['north', 'east', 'southwest', 'left top', 'centre']
  for (const position of positions) {
    test(`cover with position ${position}`, async () => {
      const input = await photo()
      const ours = await blunt(input).resize(100, 300, { position }).png().toBuffer()
      const theirs = await sharp(input).resize(100, 300, { position }).png().toBuffer()
      await assertSimilar(ours, theirs, 6)
    })

    test(`contain with position ${position} and transparent background`, async () => {
      const input = await photo()
      const background = { r: 255, g: 0, b: 0, alpha: 0.5 }
      const ours = await blunt(input).resize(300, 100, { fit: 'contain', position, background }).png().toBuffer()
      const theirs = await sharp(input).resize(300, 100, { fit: 'contain', position, background }).png().toBuffer()
      await assertSimilar(ours, theirs, 6, 4)
    })
  }

  for (const kernel of ['nearest', 'linear', 'cubic', 'mitchell', 'lanczos2', 'lanczos3'] as const) {
    test(`kernel ${kernel}`, async () => {
      const input = await photo()
      const ours = await blunt(input).resize(123, null, { kernel }).png().toBuffer()
      const theirs = await sharp(input).resize(123, null, { kernel }).png().toBuffer()
      await assertSimilar(ours, theirs, kernel === 'nearest' ? 10 : 6)
    })
  }

  test('premultiplies alpha', async () => {
    // Transparent pixels must not bleed their color into opaque neighbors.
    const input = await fromRaw(pattern(400, 300, 4)).png().toBuffer()
    const ours = await blunt(input).resize(77).png().toBuffer()
    const theirs = await sharp(input).resize(77).png().toBuffer()
    await assertSimilar(ours, theirs, 4, 4)
  })

  test('rejects outputs over the memory limit', async () => {
    const input = await photo()
    await assert.rejects(
      blunt(input, { limitMemory: 1024 * 1024 }).resize(1000, 1000).toBuffer(),
      (error: { code?: string }) => error.code === 'ERR_LIMIT_EXCEEDED',
    )
  })
})

describe('orientation matches sharp', () => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    test(`auto-orients EXIF orientation ${orientation}`, async () => {
      const input = await fromRaw(pattern(120, 80)).withMetadata({ orientation }).jpeg({ quality: 95 }).toBuffer()
      const meta = await blunt(input).metadata()
      assert.equal(meta.orientation, orientation)

      const ours = await blunt(input).rotate().png().toBuffer({ resolveWithObject: true })
      const theirs = await sharp(input).rotate().png().toBuffer({ resolveWithObject: true })
      assert.deepEqual([ours.info.width, ours.info.height], [theirs.info.width, theirs.info.height])
      assert.deepEqual([meta.autoOrient.width, meta.autoOrient.height], [theirs.info.width, theirs.info.height])
      await assertSimilar(ours.data, theirs.data, 3)
    })

    test(`auto-orients and resizes EXIF orientation ${orientation} with gravity`, async () => {
      const input = await fromRaw(pattern(120, 80)).withMetadata({ orientation }).jpeg({ quality: 95 }).toBuffer()
      const options = { position: 'north' as const }
      const ours = await blunt(input).rotate().resize(50, 30, options).png().toBuffer()
      // sharp applies gravity before rotating, so orient first to get the expected output.
      const oriented = await sharp(input).rotate().png().toBuffer()
      const theirs = await sharp(oriented).resize(50, 30, options).png().toBuffer()
      await assertSimilar(ours, theirs, 8)
    })
  }

  test('ignores EXIF orientation by default, like sharp', async () => {
    const input = await fromRaw(pattern(120, 80)).withMetadata({ orientation: 6 }).jpeg().toBuffer()
    const { info } = await blunt(input).png().toBuffer({ resolveWithObject: true })
    assert.deepEqual([info.width, info.height], [120, 80])
  })

  for (const angle of [90, 180, 270, -90, 450]) {
    test(`rotate(${angle})`, async () => {
      const input = await photo()
      const ours = await blunt(input).rotate(angle).png().toBuffer()
      const theirs = await sharp(input).rotate(angle).png().toBuffer()
      await assertSimilar(ours, theirs, 0)
    })
  }

  test('auto-orient then rotate', async () => {
    const input = await fromRaw(pattern(120, 80)).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer()
    const ours = await blunt(input).rotate().rotate(90).png().toBuffer()
    const theirs = await sharp(await sharp(input).rotate().toBuffer()).rotate(90).png().toBuffer()
    await assertSimilar(ours, theirs, 3)
  })

  test('autoOrient constructor option', async () => {
    const input = await fromRaw(pattern(120, 80)).withMetadata({ orientation: 6 }).jpeg().toBuffer()
    const { info } = await blunt(input, { autoOrient: true }).png().toBuffer({ resolveWithObject: true })
    assert.deepEqual([info.width, info.height], [80, 120])
  })
})

describe('blur', () => {
  for (const sigma of [0.5, 2, 10, 50]) {
    test(`sigma ${sigma} is close to sharp`, async () => {
      const input = await photo()
      const ours = await blunt(input).blur(sigma).png().toBuffer()
      const theirs = await sharp(input).blur(sigma).png().toBuffer()
      // Large sigmas use a box blur approximation, and edge handling differs.
      await assertSimilar(ours, theirs, sigma > 3 ? 6 : 2)
    })
  }

  test('mild blur without sigma', async () => {
    const input = await photo()
    const ours = await blunt(input).blur().png().toBuffer()
    const theirs = await sharp(input).blur().png().toBuffer()
    await assertSimilar(ours, theirs, 2)
  })

  test('blur(false) is a no-op', async () => {
    const input = await photo()
    await assertSimilar(await blunt(input).blur(5).blur(false).png().toBuffer(), input, 0)
  })

  test('blur placeholder pipeline (like next-image-loader)', async () => {
    const input = await fromRaw(pattern(400, 300)).jpeg().toBuffer()
    const { data, info } = await blunt(input)
      .resize(8, 6)
      .blur(1)
      .jpeg({ quality: 70 })
      .toBuffer({ resolveWithObject: true })
    assert.deepEqual([info.width, info.height], [8, 6])
    assert.ok(data.length < 1000)
  })

  test('large sigma on a large image is fast', async () => {
    const input = await fromRaw(pattern(2000, 2000)).png({ compressionLevel: 1 }).toBuffer()
    const start = performance.now()
    await blunt(input).blur(1000).jpeg().toBuffer()
    assert.ok(performance.now() - start < 10_000)
  })
})

describe('color management', () => {
  test('converts Display P3 to sRGB', async () => {
    const red = Buffer.alloc(32 * 32 * 3)
    for (let i = 0; i < red.length; i += 3) red[i] = 255
    const srgb = await sharp(red, { raw: { width: 32, height: 32, channels: 3 } }).png().toBuffer()
    const p3 = await sharp(srgb).withIccProfile('p3').png().toBuffer()
    assert.equal((await blunt(p3).metadata()).hasProfile, true)

    // Without color management, P3 pixel values look very different.
    const [p3Raw, srgbRaw] = await Promise.all([p3, srgb].map((b) => sharp(b, { ignoreIcc: true }).raw().toBuffer()))
    assert.ok(Math.abs(p3Raw[0] - srgbRaw[0]) > 10)

    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const ours = await blunt(p3).toFormat(format).toBuffer()
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
      const meta = await sharp(await blunt(input).toFormat(format).toBuffer()).metadata()
      assert.equal(meta.exif, undefined)
      assert.equal(meta.icc, undefined)
      assert.equal(meta.orientation, undefined)
    }
  })
})
