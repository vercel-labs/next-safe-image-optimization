// Run by scripts/test-npm-packages.mjs, in a project that has the packed packages installed, with
// NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND set to the backend to test.

const { Pool } = require('@next/safe-image-optimization')
const { crc32, deflateSync } = require('node:zlib')

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** An 8-bit RGB PNG with a gradient. */
function png(width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rows.set([(x * 255) / width, (y * 255) / height, 128], y * (width * 3 + 1) + 1 + x * 3)
    }
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

async function main() {
  const backend = process.env.NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND
  const pool = new Pool()
  if (pool.backend !== backend) {
    throw new Error(`expected the ${backend} backend, got ${pool.backend}`)
  }
  const input = png(64, 48)
  const outputs = { jpeg: { mozjpeg: false }, 'jpeg (mozjpeg)': { mozjpeg: true }, png: {}, webp: {}, gif: {} }
  for (const [name, options] of Object.entries(outputs)) {
    const format = name.split(' ')[0]
    const { info } = await pool.prepare(input).timeoutMs(30_000).resize(32)[format](options).toBuffer({ resolveWithObject: true })
    if (info.format !== format || info.width !== 32 || info.height !== 24) {
      throw new Error(`${name}: unexpected output ${JSON.stringify(info)}`)
    }
  }
  await pool.close()
  console.log(`${backend}: ok`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
