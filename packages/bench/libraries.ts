/**
 * The libraries under test, and the pipeline each one runs: what Next.js's image optimizer runs with
 * sharp (`packages/next/src/server/image-optimizer/sharp.ts`): auto-orient with EXIF, resize to a
 * width (without enlarging), and encode at Next.js's default quality (`images.qualities: [75]`).
 *
 * sharp gets Next.js's exact options. The other libraries get the closest equivalent each one can
 * express, at the same visual quality: their AVIF quality scales aren't sharp's (see `AVIF`). Things
 * none of them can configure (resampling kernel, `Bun.Image`'s JPEG encoder) are left at their
 * defaults, so see `README.md` before reading much into a single number.
 */

import os from 'node:os'

import { ChromaSubsampling, Transformer } from '@napi-rs/image'
import sharp from 'sharp'

import { Pool } from '@next/safe-image-optimization'

export const FORMATS = ['webp', 'jpeg', 'avif'] as const
export type Format = (typeof FORMATS)[number]

/** Next.js's default `quality` (`images.qualities`), which WebP and JPEG use as is. */
export const NEXT_QUALITY = 75

/**
 * Next.js scales AVIF's quality by 50/80 (so 47), and uses `effort: 3`, with sharp's default 4:4:4.
 * The other encoders were matched to that by SSIMULACRA2, on the 24 Kodak photos (median quality):
 * `@napi-rs/image` is libavif with libaom too, and matched at libaom's speed 6 (the preset sharp's
 * effort 3 uses) and nearly the same quality, 48. ravif's scale is different, and matched at 63.
 */
export const AVIF = {
  sharp: { quality: Math.max(Math.round(NEXT_QUALITY * (50 / 80)), 1), effort: 3 },
  napi: { quality: 47, speed: 6 },
  ravif: { quality: 63, effort: 3 },
} as const

/** Next.js's timeout (`imgOptTimeoutInSeconds`). */
const TIMEOUT_MS = 7_000

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

function sharpLibrary(): Library {
  // Like Next.js in production, which halves libvips's thread pool to reduce memory use.
  sharp.concurrency(Math.max(Math.floor(os.availableParallelism() / 2), 1))
  return {
    name: 'sharp',
    supports: () => true,
    run: ({ input, width, format }) => {
      const pipeline = sharp(input)
        .timeout({ seconds: TIMEOUT_MS / 1000 })
        .rotate()
        .resize(width, undefined, { withoutEnlargement: true })
      switch (format) {
        case 'webp':
          return pipeline.webp({ quality: NEXT_QUALITY }).toBuffer()
        case 'jpeg':
          return pipeline.jpeg({ quality: NEXT_QUALITY, mozjpeg: true }).toBuffer()
        case 'avif':
          return pipeline.avif(AVIF.sharp).toBuffer()
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
      // `rotate()` applies the EXIF orientation, like sharp's. Its JPEG encoder is mozjpeg, like
      // Next.js's. AVIF uses its default thread count (every core).
      const transformer = new Transformer(input).rotate().resize(width)
      switch (format) {
        case 'webp':
          return transformer.webp(NEXT_QUALITY)
        case 'jpeg':
          return transformer.jpeg(NEXT_QUALITY)
        case 'avif':
          return transformer.avif({ ...AVIF.napi, chromaSubsampling: ChromaSubsampling.Yuv444 })
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
 * sharp's. It has no mozjpeg option, and its AVIF quality scale (the OS encoder's) is unknown, so
 * AVIF gets sharp's number.
 */
function bunImageLibrary(Image: BunImageConstructor, encodesAvif: boolean): Library {
  return {
    name: 'Bun.Image',
    supports: (format) => format !== 'avif' || encodesAvif,
    run: ({ input, width, format }) => {
      const image = new Image(input).resize(width)
      switch (format) {
        case 'webp':
          return image.webp({ quality: NEXT_QUALITY }).bytes()
        case 'jpeg':
          return image.jpeg({ quality: NEXT_QUALITY }).bytes()
        case 'avif':
          return image.avif({ quality: AVIF.sharp.quality }).bytes()
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
    await new Image(probe).avif({ quality: AVIF.sharp.quality }).bytes()
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
    supports: () => true,
    run: ({ input, width, format }) => {
      const pipeline = pool
        .prepare(input)
        .timeoutMs(TIMEOUT_MS)
        .autoOrient()
        .resize(width, null, { withoutEnlargement: true })
      switch (format) {
        case 'webp':
          return pipeline.webp({ quality: NEXT_QUALITY }).toBuffer()
        case 'jpeg':
          return pipeline.jpeg({ quality: NEXT_QUALITY, mozjpeg: true }).toBuffer()
        case 'avif':
          return pipeline.avif(AVIF.ravif).toBuffer()
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
