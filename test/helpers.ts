import assert from 'node:assert/strict'

import sharp from 'sharp'

import { BluntError } from '../dist/index.js'
import type { ErrorCode } from '../dist/index.js'

export interface RawImage {
  data: Buffer
  width: number
  height: number
  channels: number
}

/** A smooth-ish RGB test pattern with distinct quadrants, so orientation mistakes are visible. */
export function pattern(width: number, height: number, channels: 3 | 4 = 3): RawImage {
  const data = Buffer.alloc(width * height * channels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const right = x >= width / 2
      const bottom = y >= height / 2
      data[i] = right ? 220 : 30
      data[i + 1] = bottom ? 200 : 40
      data[i + 2] = Math.round((x / width) * 255)
      if (channels === 4) {
        // Transparent on the left edge, opaque elsewhere.
        data[i + 3] = x < width / 8 ? 0 : 255
      }
    }
  }
  return { data, width, height, channels }
}

/**
 * `pattern` with deterministic noise, so it compresses like a photo. Highly compressible images
 * are decoded with few input reads, so they're interrupted less precisely.
 */
export function noisy(width: number, height: number): RawImage {
  const img = pattern(width, height)
  let seed = 1
  for (let i = 0; i < img.data.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + ((seed >>> 24) % 32) - 16))
  }
  return img
}

export function fromRaw(raw: RawImage) {
  return sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: raw.channels as 3 | 4 },
  })
}

/** With 3 channels, alpha is flattened onto black (which also hides the color of transparent pixels). */
export async function toRaw(input: Buffer, channels: 3 | 4 = 3): Promise<RawImage> {
  let image = sharp(input)
  image = channels === 3 ? image.flatten({ background: '#000000' }) : image.ensureAlpha()
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

/** Mean absolute difference per channel, 0-255. */
export function meanAbsDiff(a: RawImage, b: RawImage): number {
  assert.equal(a.width, b.width, 'width')
  assert.equal(a.height, b.height, 'height')
  assert.equal(a.channels, b.channels, 'channels')
  let sum = 0
  for (let i = 0; i < a.data.length; i++) {
    sum += Math.abs(a.data[i] - b.data[i])
  }
  return sum / a.data.length
}

/** Asserts that two encoded images look similar, after decoding both with sharp. */
export async function assertSimilar(actual: Buffer, expected: Buffer, tolerance: number, channels: 3 | 4 = 3) {
  const diff = meanAbsDiff(await toRaw(actual, channels), await toRaw(expected, channels))
  assert.ok(diff <= tolerance, `mean absolute difference ${diff.toFixed(2)} exceeds ${tolerance}`)
}

export async function assertRejectsWithCode(promise: Promise<unknown>, code: ErrorCode) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BluntError, `expected a BluntError, got ${String(error)}`)
    assert.equal(error.code, code, error.message)
    return true
  })
}

export function formatOf(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg'
  if (buffer.subarray(1, 4).toString('latin1') === 'PNG') return 'png'
  if (buffer.subarray(0, 3).toString('latin1') === 'GIF') return 'gif'
  if (buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return 'unknown'
}
