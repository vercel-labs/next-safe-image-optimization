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

export function libraries(concurrency: number): Library[] {
  return [sharpLibrary(), napiLibrary(), nsioLibrary(concurrency, 1), nsioLibrary(concurrency, 64)]
}
