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

  test('limitAllocatorMemory', async () => {
    const input = await fromRaw(pattern(100, 100)).png().toBuffer()
    await assertRejectsWithCode(blunt(input, { limitAllocatorMemory: 20_000 }).toBuffer(), 'ERR_LIMIT_EXCEEDED')
    await blunt(input, { limitAllocatorMemory: 1024 * 1024 }).toBuffer()
  })

  test('limitAllocatorMemory counts actual allocations, not just estimates', async () => {
    // The decoded image (30 KB) fits, but not with the decoder's and encoder's buffers.
    const input = await fromRaw(pattern(100, 100)).png().toBuffer()
    await assert.rejects(blunt(input, { limitAllocatorMemory: 60_000 }).toBuffer(), (error: unknown) => {
      assert.ok(error instanceof BluntError)
      assert.equal(error.code, 'ERR_LIMIT_EXCEEDED')
      assert.match(error.message, /allocated more than limitAllocatorMemory/)
      return true
    })
    // The worker that exceeded the limit was replaced.
    await blunt(input).toBuffer()
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
    // Resizing 4000000x2 to 3000000x2 needs a 128 MB intermediate buffer (16 bytes per pixel),
    // much more than the decoded image (24 MB) and the output (18 MB).
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
    await assert.rejects(
      blunt(input, { limitAllocatorMemory: 96 * 1024 * 1024 }).resize(3_000_000).png().toBuffer(),
      // Checked before resizing, not by the allocator.
      (error: Error & { code?: string }) => error.code === 'ERR_LIMIT_EXCEEDED' && /byte buffer/.test(error.message),
    )
  })

  test('encoder memory counts against the memory limit', async () => {
    const input = await fromRaw(pattern(256, 256)).png().toBuffer()
    // Lossless WebP and mozjpeg need much more memory than PNG and jpeg-encoder for the same image.
    await blunt(input, { limitAllocatorMemory: 1024 * 1024 }).png().toBuffer()
    await blunt(input, { limitAllocatorMemory: 1024 * 1024 }).jpeg().toBuffer()
    await assertRejectsWithCode(
      blunt(input, { limitAllocatorMemory: 1024 * 1024 }).webp({ lossless: true }).toBuffer(),
      'ERR_LIMIT_EXCEEDED',
    )
    // mozjpeg needs ~16 bytes per pixel, exactly 1 MiB here.
    await assertRejectsWithCode(
      blunt(input, { limitAllocatorMemory: 1000 * 1000 }).jpeg({ mozjpeg: true }).toBuffer(),
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

  test('GIF frames larger than the logical screen are bounded by the memory limit', async () => {
    const gif = Buffer.concat([
      Buffer.from('GIF89a', 'latin1'),
      // 1x1 screen with a 2-color global palette.
      Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff]),
      // A 65535x65535 frame at (0, 0).
      Buffer.from([0x2c, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0]),
      Buffer.from([2, 2, 0x4c, 0x01, 0, 0x3b]),
    ])
    await assertRejectsWithCode(blunt(gif).toBuffer(), 'ERR_LIMIT_EXCEEDED')
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

  test('AVIF limitInputPixels is checked before decoding', async () => {
    const input = await fromRaw(pattern(100, 100)).avif().toBuffer()
    await assertRejectsWithCode(blunt(input, { limitInputPixels: 9999 }).metadata(), 'ERR_LIMIT_EXCEEDED')
    await assertRejectsWithCode(blunt(input, { limitInputPixels: 9999 }).png().toBuffer(), 'ERR_LIMIT_EXCEEDED')
    await blunt(input, { limitInputPixels: 10000 }).png().toBuffer()
  })

  test('AVIF decoder memory counts against the memory limit', async () => {
    // 4:4:4 frames are 3 bytes per pixel, counted twice for film grain, plus the RGB output.
    const input = await fromRaw(pattern(256, 256)).avif().toBuffer()
    await assertRejectsWithCode(blunt(input, { limitAllocatorMemory: 400_000 }).png().toBuffer(), 'ERR_LIMIT_EXCEEDED')
    await blunt(input, { limitAllocatorMemory: 1024 * 1024 }).png().toBuffer()
  })

  test('YCbCr TIFFs are rejected', async () => {
    // sharp (like most encoders) writes JPEG-compressed TIFFs as YCbCr, which `image` doesn't
    // support.
    const input = await fromRaw(pattern(64, 64)).tiff({ compression: 'jpeg' }).toBuffer()
    await assertRejectsWithCode(blunt(input).png().toBuffer(), 'ERR_UNSUPPORTED_FORMAT')
  })

  test('other formats that image-rs can detect are rejected', async () => {
    // Valid 1x1 images where they're simple to write by hand, so that these fail even if another
    // crate enables image-rs's decoders for them.
    const bmp = Buffer.alloc(58)
    bmp.write('BM', 'latin1')
    bmp.writeUInt32LE(bmp.length, 2)
    bmp.writeUInt32LE(54, 10) // pixel data offset
    bmp.writeUInt32LE(40, 14) // BITMAPINFOHEADER
    bmp.writeInt32LE(1, 18) // width
    bmp.writeInt32LE(1, 22) // height
    bmp.writeUInt16LE(1, 26) // planes
    bmp.writeUInt16LE(24, 28) // bits per pixel
    const qoi = Buffer.concat([
      Buffer.from('qoif', 'latin1'),
      Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 3, 0]),
      Buffer.from([0xfe, 255, 0, 0]), // QOI_OP_RGB
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
    ])
    const farbfeld = Buffer.concat([Buffer.from('farbfeld', 'latin1'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.alloc(8, 0xff)])
    const inputs = {
      bmp,
      pnm: Buffer.from('P6\n1 1\n255\n\xff\0\0', 'latin1'),
      qoi,
      farbfeld,
      hdr: Buffer.concat([Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n', 'latin1'), Buffer.from([128, 0, 0, 129])]),
      ico: Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(16)]),
      dds: Buffer.concat([Buffer.from('DDS ', 'latin1'), Buffer.alloc(124)]),
      exr: Buffer.concat([Buffer.from([0x76, 0x2f, 0x31, 0x01]), Buffer.alloc(16)]),
    }
    for (const [name, input] of Object.entries(inputs)) {
      await assert.rejects(blunt(input).toBuffer(), (error: unknown) => {
        assert.ok(error instanceof BluntError, `${name}: ${String(error)}`)
        assert.equal(error.code, 'ERR_UNSUPPORTED_FORMAT', `${name}: ${error.message}`)
        assert.match(error.message, /input is not a JPEG/, name)
        return true
      })
      await assertRejectsWithCode(blunt(input).metadata(), 'ERR_UNSUPPORTED_FORMAT')
    }
  })

  test('unsupported formats are rejected', async () => {
    const html = Buffer.from('<!doctype html><html></html>')
    const heif = Buffer.from('000000186674797068656963000000006d696631', 'hex')
    for (const input of [html, heif, Buffer.alloc(0), Buffer.from('RIFF')]) {
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
    avif: () => fromRaw(pattern(64, 48, 4)).avif().toBuffer(),
    svg: async () =>
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48">
        <defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs>
        <rect width="64" height="48" fill="#08f" filter="url(#f)"/>
        <image width="32" height="24" href="data:image/png;base64,${(await fromRaw(pattern(8, 6)).png().toBuffer()).toString('base64')}"/>
      </svg>`),
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
