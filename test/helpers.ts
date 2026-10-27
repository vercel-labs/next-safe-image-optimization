import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import type Sharp from 'sharp'

import { BluntError } from '../dist/index.js'
import type { ErrorCode } from '../dist/index.js'

/** sharp's ES module uses import attributes (`with`), which need Node.js 20.10, so this loads its CommonJS one. */
export const sharp: typeof Sharp = createRequire(import.meta.url)('sharp')

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

/** The CRC-32 that PNG chunks use. `zlib.crc32` needs Node.js 20.15. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
