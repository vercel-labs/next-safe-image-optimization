/**
 * Input images for the benchmark, generated with sharp so that nothing has to be committed or
 * downloaded (the same rule the tests follow). They're deterministic: the same seed always produces
 * the same bytes, so runs on different machines are comparable.
 *
 * Flat color or a simple gradient would make every decoder and encoder look much faster than it is,
 * so these are fractal (1/f) value noise, which has roughly the frequency distribution of a
 * photograph: large smooth areas with fine detail on top.
 */

import sharp from 'sharp'

export interface Fixture {
  /** Short name, used on the command line (`--inputs`). */
  readonly name: string
  /** Encoded JPEG. */
  readonly data: Buffer
  readonly width: number
  readonly height: number
  /** The EXIF orientation tag, which `autoOrient()` applies. */
  readonly orientation: number
  /** The width the benchmark resizes this input to. */
  readonly resizeWidth: number
  readonly description: string
}

/** Deterministic PRNG (mulberry32), so a fixture doesn't depend on the JS engine. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

/** One octave of value noise: a coarse random grid, interpolated with a smoothstep. */
function octave(width: number, height: number, columns: number, next: () => number): Float32Array {
  const gridWidth = columns + 1
  const gridHeight = Math.max(1, Math.round((columns * height) / width)) + 1
  const grid = new Float32Array(gridWidth * gridHeight)
  for (let i = 0; i < grid.length; i++) {
    grid[i] = next()
  }
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const gy = (y / height) * (gridHeight - 1)
    const y0 = Math.floor(gy)
    const y1 = Math.min(y0 + 1, gridHeight - 1)
    const ty = gy - y0
    const wy = ty * ty * (3 - 2 * ty)
    for (let x = 0; x < width; x++) {
      const gx = (x / width) * (gridWidth - 1)
      const x0 = Math.floor(gx)
      const x1 = Math.min(x0 + 1, gridWidth - 1)
      const tx = gx - x0
      const wx = tx * tx * (3 - 2 * tx)
      const top = grid[y0 * gridWidth + x0] * (1 - wx) + grid[y0 * gridWidth + x1] * wx
      const bottom = grid[y1 * gridWidth + x0] * (1 - wx) + grid[y1 * gridWidth + x1] * wx
      out[y * width + x] = top * (1 - wy) + bottom * wy
    }
  }
  return out
}

const OCTAVES = 9
/** How much each octave contributes relative to the one before it. Higher means more fine detail. */
const FALLOFF = 0.8

/** Fractal noise in three channels, as packed RGB bytes. */
function noise(width: number, height: number, seed: number): Buffer {
  const next = random(seed)
  const data = Buffer.alloc(width * height * 3)
  for (let channel = 0; channel < 3; channel++) {
    const sum = new Float32Array(width * height)
    let amplitude = 1
    let total = 0
    for (let o = 0; o < OCTAVES; o++) {
      const layer = octave(width, height, 2 << o, next)
      for (let i = 0; i < sum.length; i++) {
        sum[i] += layer[i] * amplitude
      }
      total += amplitude
      amplitude *= FALLOFF
    }
    for (let i = 0; i < sum.length; i++) {
      const value = Math.round((sum[i] / total) * 255)
      data[i * 3 + channel] = value < 0 ? 0 : value > 255 ? 255 : value
    }
  }
  return data
}

interface FixtureSpec {
  readonly name: string
  readonly width: number
  readonly height: number
  readonly orientation: number
  readonly resizeWidth: number
  readonly seed: number
  readonly description: string
}

/**
 * `small` is the input from [@napi-rs/image's benchmark]: a 600x450 JPEG with EXIF orientation 5,
 * resized to 225. `large` is closer to an image a user would upload.
 *
 * [@napi-rs/image's benchmark]: https://github.com/Brooooooklyn/Image/blob/main/bench/bench.mjs
 */
export const FIXTURE_SPECS: readonly FixtureSpec[] = [
  {
    name: 'small',
    width: 600,
    height: 450,
    orientation: 5,
    resizeWidth: 225,
    seed: 1,
    description: '600x450 JPEG, EXIF orientation 5, resized to 225px',
  },
  {
    name: 'large',
    width: 3000,
    height: 2000,
    orientation: 1,
    resizeWidth: 640,
    seed: 2,
    description: '3000x2000 JPEG, resized to 640px',
  },
]

export async function buildFixture(spec: FixtureSpec): Promise<Fixture> {
  const raw = noise(spec.width, spec.height, spec.seed)
  const data = await sharp(raw, {
    raw: { width: spec.width, height: spec.height, channels: 3 },
  })
    // The only way to write the EXIF orientation tag. It also embeds an sRGB ICC profile, like most
    // cameras and editors do, so the libraries all have a profile to convert.
    .withMetadata({ orientation: spec.orientation })
    .jpeg({ quality: 90 })
    .toBuffer()
  return {
    name: spec.name,
    data,
    width: spec.width,
    height: spec.height,
    orientation: spec.orientation,
    resizeWidth: spec.resizeWidth,
    description: spec.description,
  }
}
