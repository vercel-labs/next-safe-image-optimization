import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'

import sharp from 'sharp'

import { BluntError, blunt } from '../dist/index.js'
import { assertRejectsWithCode, fromRaw, pattern } from './helpers.ts'

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

/** A PNG that declares the given dimensions, but contains (almost) no pixel data. */
function pngWithDimensions(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(16))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0])
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([header, payload])
}

/** Deterministic PRNG (mulberry32). */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('limits', () => {
  test('limitInputPixels', async () => {
    const input = await fromRaw(pattern(100, 100)).png().toBuffer()
    await assertRejectsWithCode(blunt(input, { limitInputPixels: 9999 }).toBuffer(), 'ERR_LIMIT_EXCEEDED')
    await assertRejectsWithCode(blunt(input, { limitInputPixels: 9999 }).metadata(), 'ERR_LIMIT_EXCEEDED')
    await blunt(input, { limitInputPixels: 10000 }).toBuffer()
    await blunt(input, { limitInputPixels: false }).toBuffer()
    await blunt(input, { limitInputPixels: 0 }).toBuffer()
  })

  test('limitMemory', async () => {
    const input = await fromRaw(pattern(100, 100)).png().toBuffer()
    await assertRejectsWithCode(blunt(input, { limitMemory: 20_000 }).toBuffer(), 'ERR_LIMIT_EXCEEDED')
    await blunt(input, { limitMemory: 100_000 }).toBuffer()
  })

  test('default pixel limit rejects huge declared dimensions before allocating', async () => {
    for (const [width, height] of [
      [100_000, 100_000],
      [0x7fffffff, 1],
    ]) {
      await assertRejectsWithCode(blunt(pngWithDimensions(width, height)).toBuffer(), 'ERR_LIMIT_EXCEEDED')
    }
  })

  test('default memory limit rejects large images within the pixel limit', async () => {
    // 16000x16000 RGB is 768 MB, over the 512 MiB default.
    await assertRejectsWithCode(blunt(pngWithDimensions(16_000, 16_000)).toBuffer(), 'ERR_LIMIT_EXCEEDED')
  })

  test('resampling buffers count against the memory limit', async () => {
    // Resizing 4000000x2 to 100x100 needs a 1.2 GB intermediate buffer, and large filter tables.
    const width = 4_000_000
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(2, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 2 // RGB
    const input = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(Buffer.alloc((1 + width * 3) * 2))),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
    assert.deepEqual(await blunt(input).metadata().then((m) => [m.width, m.height]), [width, 2])
    await assertRejectsWithCode(
      blunt(input).resize(100, 100, { fit: 'fill' }).png().toBuffer(),
      'ERR_LIMIT_EXCEEDED',
    )
  })

  test('encoder memory counts against the memory limit', async () => {
    const input = await fromRaw(pattern(256, 256)).png().toBuffer()
    // Lossless WebP needs much more memory than PNG for the same image.
    await blunt(input, { limitMemory: 1024 * 1024 }).png().toBuffer()
    await assertRejectsWithCode(
      blunt(input, { limitMemory: 1024 * 1024 }).webp({ lossless: true }).toBuffer(),
      'ERR_LIMIT_EXCEEDED',
    )
  })

  test('WebP frames must match the canvas', async () => {
    const valid = await fromRaw(pattern(64, 64)).webp().toBuffer()
    assert.equal(valid.toString('latin1', 12, 16), 'VP8 ')
    const vp8 = Buffer.from(valid.subarray(12))
    const wrap = (frame: Buffer) => {
      // A VP8X header declaring a 1x1 canvas (dimensions are stored minus one).
      const vp8x = Buffer.concat([Buffer.from('VP8X', 'latin1'), Buffer.from([10, 0, 0, 0]), Buffer.alloc(10)])
      const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), vp8x, frame])
      const header = Buffer.from('RIFF\0\0\0\0', 'latin1')
      header.writeUInt32LE(body.length, 4)
      return Buffer.concat([header, body])
    }
    await assertRejectsWithCode(blunt(wrap(vp8)).toBuffer(), 'ERR_DECODE_FAILED')
    // The largest frame VP8 can declare. image-webp would allocate it before comparing it with
    // the canvas.
    vp8.writeUInt16LE(0x3fff, 8 + 6)
    vp8.writeUInt16LE(0x3fff, 8 + 8)
    await assertRejectsWithCode(blunt(wrap(vp8)).toBuffer(), 'ERR_DECODE_FAILED')
  })

  test('PNG iCCP decompression bombs are bounded', async () => {
    const bomb = Buffer.concat([Buffer.from('icc\0\0', 'latin1'), deflateSync(Buffer.alloc(64 * 1024 * 1024))])
    const valid = await fromRaw(pattern(8, 8)).png().toBuffer()
    // Insert the iCCP chunk right after IHDR.
    const input = Buffer.concat([valid.subarray(0, 33), pngChunk('iCCP', bomb), valid.subarray(33)])
    const start = performance.now()
    try {
      await blunt(input).toBuffer()
    } catch (error) {
      assert.ok(error instanceof BluntError && error.code === 'ERR_LIMIT_EXCEEDED', String(error))
    }
    assert.ok(performance.now() - start < 5000)
  })

  test('GIF frames must fit inside the logical screen', async () => {
    const gif = Buffer.concat([
      Buffer.from('GIF89a', 'latin1'),
      // 1x1 screen with a 2-color global palette.
      Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff]),
      // A 65535x65535 frame at (0, 0).
      Buffer.from([0x2c, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0]),
      Buffer.from([2, 2, 0x4c, 0x01, 0, 0x3b]),
    ])
    await assertRejectsWithCode(blunt(gif).toBuffer(), 'ERR_DECODE_FAILED')
  })

  test('JPEGs with excessive metadata segments are rejected', async () => {
    const valid = await fromRaw(pattern(8, 8)).jpeg().toBuffer()
    const segments = Array.from({ length: 5000 }, () => jpegSegment(0xe1, Buffer.from('http://ns.adobe.com/xmp/extension/\0')))
    const input = Buffer.concat([valid.subarray(0, 2), ...segments, valid.subarray(2)])
    await assertRejectsWithCode(blunt(input).toBuffer(), 'ERR_LIMIT_EXCEEDED')
  })

  test('progressive JPEGs with many empty scans do bounded work', async () => {
    // Each scan in a progressive JPEG is a pass over the whole image, even if it has no data.
    const valid = await fromRaw(pattern(1024, 1024)).jpeg({ progressive: true }).toBuffer()
    const time = async (input: Buffer) => {
      const start = performance.now()
      await blunt(input).toBuffer().catch(() => {})
      return performance.now() - start
    }
    const baseline = await time(valid)
    for (const index of [valid.indexOf(Buffer.from([0xff, 0xda])), valid.lastIndexOf(Buffer.from([0xff, 0xda]))]) {
      const header = valid.subarray(index, index + 2 + valid.readUInt16BE(index + 2))
      const scans = Array(1000).fill(header)
      const input = Buffer.concat([valid.subarray(0, valid.length - 2), ...scans, Buffer.from([0xff, 0xd9])])
      const elapsed = await time(input)
      assert.ok(elapsed < baseline * 5 + 100, `${elapsed}ms vs baseline ${baseline}ms`)
    }
  })

  test('JPEG-compressed TIFFs are rejected', async () => {
    const input = await fromRaw(pattern(64, 64)).tiff({ compression: 'jpeg' }).toBuffer()
    await assertRejectsWithCode(blunt(input).png().toBuffer(), 'ERR_UNSUPPORTED_FORMAT')
  })

  test('unsupported formats are rejected', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
    const heif = Buffer.from('000000186674797068656963000000006d696631', 'hex')
    for (const input of [svg, heif, Buffer.alloc(0), Buffer.from('RIFF')]) {
      await assertRejectsWithCode(blunt(input).toBuffer(), 'ERR_UNSUPPORTED_FORMAT')
    }
  })
})

describe('malformed input never crashes or panics', () => {
  const fixtures = {
    jpeg: () => fromRaw(pattern(64, 48)).jpeg().toBuffer(),
    'progressive jpeg': () => fromRaw(pattern(64, 48)).jpeg({ progressive: true }).toBuffer(),
    png: () => fromRaw(pattern(64, 48, 4)).png().toBuffer(),
    'lossy webp': () => fromRaw(pattern(64, 48, 4)).webp().toBuffer(),
    'lossless webp': () => fromRaw(pattern(64, 48)).webp({ lossless: true }).toBuffer(),
    gif: () => fromRaw(pattern(64, 48)).gif().toBuffer(),
    tiff: () => fromRaw(pattern(64, 48)).tiff({ compression: 'lzw' }).toBuffer(),
  }
  const allowed = new Set(['ERR_DECODE_FAILED', 'ERR_LIMIT_EXCEEDED', 'ERR_UNSUPPORTED_FORMAT'])

  for (const [name, make] of Object.entries(fixtures)) {
    test(name, async () => {
      const valid = await make()
      const next = random(name.length)
      const inputs: Buffer[] = []
      for (let i = 1; i < 32; i++) {
        inputs.push(valid.subarray(0, Math.floor((valid.length * i) / 32)))
      }
      for (let i = 0; i < 200; i++) {
        const mutated = Buffer.from(valid)
        const flips = 1 + Math.floor(next() * 8)
        for (let j = 0; j < flips; j++) {
          // Leave the magic bytes alone so that the decoder actually runs.
          const offset = 8 + Math.floor(next() * (mutated.length - 8))
          mutated[offset] = Math.floor(next() * 256)
        }
        inputs.push(mutated)
      }
      for (const input of inputs) {
        try {
          await blunt(input).resize(32).png().toBuffer()
        } catch (error) {
          assert.ok(error instanceof BluntError, String(error))
          assert.ok(allowed.has(error.code), `${error.code}: ${error.message}`)
        }
      }
    })
  }
})

describe('concurrency', () => {
  test('input is copied, so it can be mutated immediately', async () => {
    const original = await fromRaw(pattern(64, 64)).png().toBuffer()
    const input = Buffer.from(original)
    const promise = blunt(input).png().toBuffer()
    input.fill(0)
    const output = await promise
    assert.deepEqual(await sharp(output).raw().toBuffer(), await sharp(original).raw().toBuffer())
  })

  test('many parallel pipelines', async () => {
    const input = await fromRaw(pattern(300, 200)).jpeg().toBuffer()
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, i) => blunt(input).resize(10 + i).webp().toBuffer({ resolveWithObject: true })),
    )
    results.forEach(({ info }, i) => assert.equal(info.width, 10 + i))
  })
})
