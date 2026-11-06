/**
 * The libraries under test, and the pipeline each one runs: auto-orient with EXIF, resize to a
 * width, encode. That's [@napi-rs/image's benchmark] pipeline, and what Next.js's image optimizer
 * does.
 *
 * Every library uses its own defaults for everything else (resampling kernel, JPEG encoder,
 * progressive scans, effort levels), because that's what a caller gets. They aren't all the same,
 * so see `README.md` before reading much into a single number.
 *
 * [@napi-rs/image's benchmark]: https://github.com/Brooooooklyn/Image/blob/main/bench/bench.mjs
 */

import { ChromaSubsampling, Transformer } from '@napi-rs/image'
import sharp from 'sharp'

import { Pool } from '@next/safe-image-optimization'

export const FORMATS = ['webp', 'jpeg', 'avif'] as const
export type Format = (typeof FORMATS)[number]

/** Matching settings, as far as each library can express them. */
export const QUALITY = { webp: 75, jpeg: 75, avif: 70 } as const

export interface Job {
  readonly input: Buffer
  readonly width: number
  readonly format: Format
}

export interface Library {
  readonly name: string
  /** Shown instead of a result when the library can't produce a format. */
  supports(format: Format): boolean
  run(job: Job): Promise<Uint8Array>
  close(): Promise<void>
}

/** A timeout a server would set for untrusted input. Long enough not to fire here. */
const TIMEOUT_MS = 30_000

function sharpLibrary(): Library {
  return {
    name: 'sharp',
    supports: () => true,
    run: ({ input, width, format }) => {
      const pipeline = sharp(input).rotate().resize(width)
      switch (format) {
        case 'webp':
          return pipeline.webp({ quality: QUALITY.webp }).toBuffer()
        case 'jpeg':
          return pipeline.jpeg({ quality: QUALITY.jpeg }).toBuffer()
        case 'avif':
          return pipeline.avif({ quality: QUALITY.avif, chromaSubsampling: '4:2:0' }).toBuffer()
      }
    },
    close: () => Promise.resolve(),
  }
}

function napiLibrary(): Library {
  return {
    name: '@napi-rs/image',
    supports: () => true,
    run: ({ input, width, format }) => {
      // `rotate()` applies the EXIF orientation, like sharp's.
      const transformer = new Transformer(input).rotate().resize(width)
      switch (format) {
        case 'webp':
          return transformer.webp(QUALITY.webp)
        case 'jpeg':
          return transformer.jpeg(QUALITY.jpeg)
        case 'avif':
          return transformer.avif({
            quality: QUALITY.avif,
            chromaSubsampling: ChromaSubsampling.Yuv420,
          })
      }
    },
    close: () => Promise.resolve(),
  }
}

/**
 * `Bun.Image` (Bun 1.4+), which only exists when the benchmark runs under Bun (`pnpm bench:bun`).
 * Like sharp and `@napi-rs/image`, it decodes and encodes in the same process, off the JavaScript
 * thread.
 *
 * There's no call for auto-orienting: `autoOrient` is the constructor's default, and it applies the
 * EXIF orientation before every other operation. `resize(width)` keeps the aspect ratio, like
 * sharp's.
 */
function bunImageLibrary(Image: BunImageConstructor, encodesAvif: boolean): Library {
  return {
    name: 'Bun.Image',
    supports: (format) => format !== 'avif' || encodesAvif,
    run: ({ input, width, format }) => {
      const image = new Image(input).resize(width)
      switch (format) {
        case 'webp':
          return image.webp({ quality: QUALITY.webp }).bytes()
        case 'jpeg':
          return image.jpeg({ quality: QUALITY.jpeg }).bytes()
        case 'avif':
          return image.avif({ quality: QUALITY.avif }).bytes()
      }
    },
    close: () => Promise.resolve(),
  }
}

/**
 * Whether `Bun.Image` can encode AVIF on this machine. Its JPEG, PNG, and WebP codecs are linked
 * into every build, but HEIC and AVIF go through an OS encoder: Linux has none at all, and macOS
 * only has one on Apple Silicon M3+. So the only way to find out is to encode something, which is
 * cheap enough on an 8x8 image.
 */
async function bunEncodesAvif(Image: BunImageConstructor): Promise<boolean> {
  const probe = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
    .jpeg()
    .toBuffer()
  try {
    await new Image(probe).avif({ quality: QUALITY.avif }).bytes()
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_IMAGE_FORMAT_UNSUPPORTED') return false
    throw error
  }
}

/**
 * `maxImagesPerWorker` is the knob that costs the most throughput: the default (1) replaces a
 * worker after every image, so a bug in a decoder can't leak one image into the next. Both
 * settings are measured, because the difference is the price of that guarantee.
 */
function nsioLibrary(concurrency: number, maxImagesPerWorker: number): Library {
  const pool = new Pool({ concurrency, maxImagesPerWorker })
  return {
    name:
      maxImagesPerWorker === 1
        ? '@next/safe-image-optimization'
        : `@next/safe-image-optimization (maxImagesPerWorker: ${maxImagesPerWorker})`,
    // No AVIF encoder: it only decodes AVIF.
    supports: (format) => format !== 'avif',
    run: ({ input, width, format }) => {
      const pipeline = pool.prepare(input).timeoutMs(TIMEOUT_MS).autoOrient().resize(width)
      switch (format) {
        case 'webp':
          return pipeline.webp({ quality: QUALITY.webp }).toBuffer()
        case 'jpeg':
          return pipeline.jpeg({ quality: QUALITY.jpeg }).toBuffer()
        case 'avif':
          throw new Error('unreachable: AVIF output is unsupported')
      }
    },
    close: () => pool.destroy(),
  }
}

/** The libraries that decode in this process first, then the two that use worker processes. */
export async function libraries(concurrency: number): Promise<Library[]> {
  const all = [sharpLibrary(), napiLibrary()]
  // Only under Bun, so a Node.js run measures exactly what it measured before.
  if (typeof Bun !== 'undefined') {
    const Image = Bun.Image
    if (Image === undefined) {
      // On stderr, so that `--json` still writes nothing but JSON to stdout.
      console.error(`Bun ${Bun.version} has no Bun.Image (added in 1.4): leaving that entry out.`)
    } else {
      all.push(bunImageLibrary(Image, await bunEncodesAvif(Image)))
    }
  }
  all.push(nsioLibrary(concurrency, 1), nsioLibrary(concurrency, 64))
  return all
}
