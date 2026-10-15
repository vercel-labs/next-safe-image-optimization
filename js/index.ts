import { CancelToken, metadata as nativeMetadata, transform as nativeTransform } from '../binding.js'
import type {
  NativeError,
  NativeLimitOptions,
  NativeResizeOptions,
  NativeTransformOptions,
} from '../binding.js'

export type InputFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'tiff'
export type OutputFormat = 'jpeg' | 'png' | 'webp' | 'gif'
export type Fit = 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
export type Kernel = 'nearest' | 'linear' | 'cubic' | 'mitchell' | 'lanczos2' | 'lanczos3'
export type Position =
  | 'centre'
  | 'center'
  | 'north'
  | 'northeast'
  | 'east'
  | 'southeast'
  | 'south'
  | 'southwest'
  | 'west'
  | 'northwest'
  | 'top'
  | 'right top'
  | 'right'
  | 'right bottom'
  | 'bottom'
  | 'left bottom'
  | 'left'
  | 'left top'

export type Input = Uint8Array | ArrayBuffer | ArrayBufferView

export interface Color {
  /** 0-255 */
  r: number
  /** 0-255 */
  g: number
  /** 0-255 */
  b: number
  /** 0-1, defaults to 1. */
  alpha?: number
}

export interface BluntOptions {
  /**
   * Reject input images where `width * height` exceeds this. `true` uses the default; `false` or
   * `0` removes the limit (not recommended). Default: `268402689` (`0x3FFF * 0x3FFF`), like sharp.
   */
  limitInputPixels?: number | boolean
  /**
   * The maximum memory in bytes that each stage (decode, resize, blur, encode) may allocate,
   * estimated before the stage runs. Also passed to decoders as their allocation budget. Default:
   * 512 MiB.
   */
  limitMemory?: number
  /** Equivalent to calling `autoOrient()`. */
  autoOrient?: boolean
}

export interface ResizeOptions {
  width?: number | null
  height?: number | null
  /** Default: `'cover'`. */
  fit?: Fit
  /** Where to crop (`cover`) or embed (`contain`). Default: `'centre'`. */
  position?: Position
  /** Default: `'lanczos3'`. */
  kernel?: Kernel
  /** Background for `contain`. Default: opaque black. */
  background?: Color
  withoutEnlargement?: boolean
  withoutReduction?: boolean
}

export interface JpegOptions {
  /** 1-100. Default: 80. */
  quality?: number
  progressive?: boolean
  /** Default: `'4:2:0'`. */
  chromaSubsampling?: '4:2:0' | '4:4:4'
  /** Optimize Huffman tables. Default: `true`. */
  optimiseCoding?: boolean
  optimizeCoding?: boolean
  /** mozjpeg's quantization table index, 0-8. Default: 0. */
  quantisationTable?: number
  quantizationTable?: number
  /**
   * Approximates sharp's mozjpeg preset (progressive, optimized coding, quantization table 3). There
   * is no trellis quantization, so output is somewhat larger than real mozjpeg.
   */
  mozjpeg?: boolean
}

export interface PngOptions {
  /** zlib compression level, 0-9. Default: 6. */
  compressionLevel?: number
  /** Default: `true` (sharp defaults to `false`). */
  adaptiveFiltering?: boolean
  /**
   * Accepted for compatibility with sharp, but ignored. Output is always lossless truecolor; there
   * is no palette quantization.
   */
  quality?: number
}

export interface WebpOptions {
  /** 1-100. Default: 80. */
  quality?: number
  /** 0-100. Default: 100. */
  alphaQuality?: number
  lossless?: boolean
  nearLossless?: boolean
  smartSubsample?: boolean
  /** 0 (fastest) to 6 (slowest). Default: 4. */
  effort?: number
}

export interface GifOptions {
  /** 1 (fastest) to 10 (slowest). Default: 7. */
  effort?: number
}

export type FormatOptions = JpegOptions | PngOptions | WebpOptions | GifOptions

export interface TimeoutOptions {
  /** Processing time (not including time spent queued) after which to fail. 0 disables. */
  seconds: number
}

export interface OutputInfo {
  format: OutputFormat
  width: number
  height: number
  channels: number
  size: number
}

export interface Metadata {
  format: InputFormat
  /** Stored width, before applying the EXIF orientation. */
  width: number
  /** Stored height, before applying the EXIF orientation. */
  height: number
  hasAlpha: boolean
  /** EXIF orientation, 1-8. 1 if absent. */
  orientation: number
  /** Whether the image has an embedded ICC profile. */
  hasProfile: boolean
  /** Dimensions after applying the EXIF orientation. */
  autoOrient: { width: number; height: number }
}

export interface ProcessOptions {
  /** Aborting rejects with `signal.reason` and stops processing at the next checkpoint. */
  signal?: AbortSignal
}

export interface ToBufferOptions extends ProcessOptions {
  resolveWithObject?: boolean
}

export type ErrorCode =
  | 'ERR_UNSUPPORTED_FORMAT'
  | 'ERR_LIMIT_EXCEEDED'
  | 'ERR_DECODE_FAILED'
  | 'ERR_ENCODE_FAILED'
  | 'ERR_TIMEOUT'
  | 'ERR_ABORTED'
  | 'ERR_INTERNAL'

/** Errors from processing an image. Invalid arguments throw a `TypeError` instead. */
export class BluntError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'BluntError'
    this.code = code
  }
}

const GRAVITY: Record<Position, [number, number]> = {
  centre: [0.5, 0.5],
  center: [0.5, 0.5],
  north: [0.5, 0],
  top: [0.5, 0],
  northeast: [1, 0],
  'right top': [1, 0],
  east: [1, 0.5],
  right: [1, 0.5],
  southeast: [1, 1],
  'right bottom': [1, 1],
  south: [0.5, 1],
  bottom: [0.5, 1],
  southwest: [0, 1],
  'left bottom': [0, 1],
  west: [0, 0.5],
  left: [0, 0.5],
  northwest: [0, 0],
  'left top': [0, 0],
}

const FITS: readonly Fit[] = ['cover', 'contain', 'fill', 'inside', 'outside']
const KERNELS: readonly Kernel[] = ['nearest', 'linear', 'cubic', 'mitchell', 'lanczos2', 'lanczos3']
const DEFAULT_LIMIT_INPUT_PIXELS = 0x3fff * 0x3fff

function invalid(name: string, expected: string, value: unknown): TypeError {
  return new TypeError(`Expected ${expected} for ${name} but received ${String(value)} of type ${typeof value}`)
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function checkInteger(name: string, value: unknown, min: number, max: number): number {
  if (!isInteger(value, min, max)) {
    throw invalid(name, `integer between ${min} and ${max}`, value)
  }
  return value
}

function checkNumber(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !(value >= min && value <= max)) {
    throw invalid(name, `number between ${min} and ${max}`, value)
  }
  return value
}

function checkBoolean(name: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw invalid(name, 'boolean', value)
  }
  return value
}

function optional<T, U>(value: T | undefined, check: (value: T) => U): U | undefined {
  return value === undefined ? undefined : check(value)
}

function checkOneOf<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    throw invalid(name, `one of ${allowed.join(', ')}`, value)
  }
  return value as T
}

function toUint8Array(input: Input): Uint8Array {
  if (input instanceof Uint8Array) {
    return input
  }
  if (input instanceof ArrayBuffer || input instanceof SharedArrayBuffer) {
    return new Uint8Array(input)
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  throw invalid('input', 'Buffer, Uint8Array, ArrayBuffer, or ArrayBufferView', input)
}

function toError(error: NativeError, signal: AbortSignal | undefined): unknown {
  if (error.code === 'ERR_ABORTED' && signal?.aborted) {
    return signal.reason
  }
  return new BluntError(error.code as ErrorCode, error.message)
}

async function withCancelToken<T>(signal: AbortSignal | undefined, run: (token: CancelToken) => Promise<T>) {
  signal?.throwIfAborted()
  const token = new CancelToken()
  const onAbort = () => token.cancel()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await run(token)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * A chainable image processing pipeline, similar to a sharp instance. Operations always run in this
 * order, regardless of call order: auto-orient, rotate, resize, blur.
 */
export class Pipeline {
  #input: Uint8Array
  #limits: NativeLimitOptions = {}
  #autoOrient = false
  #rotate: number | undefined
  #resize: NativeResizeOptions | undefined
  #blur: NativeTransformOptions['blur']
  #output: Pick<NativeTransformOptions, 'format' | 'jpeg' | 'png' | 'webp' | 'gif'> = {}

  constructor(input: Input, options: BluntOptions = {}) {
    this.#input = toUint8Array(input)
    const { limitInputPixels, limitMemory, autoOrient } = options
    if (limitInputPixels !== undefined) {
      if (typeof limitInputPixels === 'boolean') {
        this.#limits.limitInputPixels = limitInputPixels ? DEFAULT_LIMIT_INPUT_PIXELS : 0
      } else {
        this.#limits.limitInputPixels = checkInteger(
          'limitInputPixels',
          limitInputPixels,
          0,
          Number.MAX_SAFE_INTEGER,
        )
      }
    }
    this.#limits.limitMemory = optional(limitMemory, (v) =>
      checkInteger('limitMemory', v, 1, Number.MAX_SAFE_INTEGER),
    )
    if (optional(autoOrient, (v) => checkBoolean('autoOrient', v))) {
      this.autoOrient()
    }
  }

  /** Rotates using the EXIF orientation, which is then stripped (like all metadata). */
  autoOrient(): this {
    this.#autoOrient = true
    return this
  }

  /**
   * Without an angle, auto-orients (like sharp). With an angle, rotates clockwise after
   * auto-orientation. Only multiples of 90 are supported.
   */
  rotate(angle?: number): this {
    if (angle === undefined) {
      return this.autoOrient()
    }
    if (!isInteger(angle, -3600, 3600) || angle % 90 !== 0) {
      throw invalid('angle', 'multiple of 90', angle)
    }
    this.#rotate = angle
    return this
  }

  resize(width?: number | null, height?: number | null, options?: ResizeOptions): this
  resize(options: ResizeOptions): this
  resize(
    widthOrOptions?: number | null | ResizeOptions,
    height?: number | null,
    options: ResizeOptions = {},
  ): this {
    let width: number | null | undefined
    if (widthOrOptions !== null && typeof widthOrOptions === 'object') {
      options = widthOrOptions
      width = options.width
      height = options.height
    } else {
      width = widthOrOptions ?? options.width
      height = height ?? options.height
    }
    const dimension = (name: string, value: number | null | undefined) =>
      value == null ? undefined : checkInteger(name, value, 1, 0xffffffff)
    const resize: NativeResizeOptions = {
      width: dimension('width', width),
      height: dimension('height', height),
      fit: optional(options.fit, (v) => checkOneOf('fit', v, FITS)),
      kernel: optional(options.kernel, (v) => checkOneOf('kernel', v, KERNELS)),
      withoutEnlargement: optional(options.withoutEnlargement, (v) => checkBoolean('withoutEnlargement', v)),
      withoutReduction: optional(options.withoutReduction, (v) => checkBoolean('withoutReduction', v)),
    }
    if (options.position !== undefined) {
      const gravity = GRAVITY[checkOneOf('position', options.position, Object.keys(GRAVITY) as Position[])]
      ;[resize.gravityX, resize.gravityY] = gravity
    }
    if (options.background !== undefined) {
      const { r, g, b, alpha = 1 } = options.background
      resize.background = {
        r: checkInteger('background.r', r, 0, 255),
        g: checkInteger('background.g', g, 0, 255),
        b: checkInteger('background.b', b, 0, 255),
        alpha: checkNumber('background.alpha', alpha, 0, 1),
      }
    }
    this.#resize = resize
    return this
  }

  /**
   * Without arguments (or `true`), performs a mild 3x3 box blur. With a sigma (0.3-1000), performs
   * a Gaussian blur. `false` disables blurring.
   */
  blur(sigma?: number | boolean | { sigma: number }): this {
    if (sigma === undefined || sigma === true) {
      this.#blur = {}
    } else if (sigma === false) {
      this.#blur = undefined
    } else {
      const value = typeof sigma === 'object' && sigma !== null ? sigma.sigma : sigma
      this.#blur = { sigma: checkNumber('sigma', value, 0.3, 1000) }
    }
    return this
  }

  jpeg(options: JpegOptions = {}): this {
    const { chromaSubsampling } = options
    if (chromaSubsampling !== undefined) {
      checkOneOf('chromaSubsampling', chromaSubsampling, ['4:2:0', '4:4:4'])
    }
    const optimizeCoding = options.optimizeCoding ?? options.optimiseCoding
    const quantizationTable = options.quantizationTable ?? options.quantisationTable
    this.#output = {
      format: 'jpeg',
      jpeg: {
        quality: optional(options.quality, (v) => checkInteger('quality', v, 1, 100)),
        progressive: optional(options.progressive, (v) => checkBoolean('progressive', v)),
        chromaSubsampling: chromaSubsampling === undefined ? undefined : chromaSubsampling === '4:2:0',
        optimizeCoding: optional(optimizeCoding, (v) => checkBoolean('optimizeCoding', v)),
        quantizationTable: optional(quantizationTable, (v) => checkInteger('quantizationTable', v, 0, 8)),
        mozjpeg: optional(options.mozjpeg, (v) => checkBoolean('mozjpeg', v)),
      },
    }
    return this
  }

  png(options: PngOptions = {}): this {
    if (options.quality !== undefined) {
      checkInteger('quality', options.quality, 1, 100)
    }
    this.#output = {
      format: 'png',
      png: {
        compressionLevel: optional(options.compressionLevel, (v) => checkInteger('compressionLevel', v, 0, 9)),
        adaptiveFiltering: optional(options.adaptiveFiltering, (v) => checkBoolean('adaptiveFiltering', v)),
      },
    }
    return this
  }

  webp(options: WebpOptions = {}): this {
    this.#output = {
      format: 'webp',
      webp: {
        quality: optional(options.quality, (v) => checkInteger('quality', v, 1, 100)),
        alphaQuality: optional(options.alphaQuality, (v) => checkInteger('alphaQuality', v, 0, 100)),
        lossless: optional(options.lossless, (v) => checkBoolean('lossless', v)),
        nearLossless: optional(options.nearLossless, (v) => checkBoolean('nearLossless', v)),
        smartSubsample: optional(options.smartSubsample, (v) => checkBoolean('smartSubsample', v)),
        effort: optional(options.effort, (v) => checkInteger('effort', v, 0, 6)),
      },
    }
    return this
  }

  gif(options: GifOptions = {}): this {
    this.#output = {
      format: 'gif',
      gif: { effort: optional(options.effort, (v) => checkInteger('effort', v, 1, 10)) },
    }
    return this
  }

  toFormat(format: 'jpeg' | 'jpg', options?: JpegOptions): this
  toFormat(format: 'png', options?: PngOptions): this
  toFormat(format: 'webp', options?: WebpOptions): this
  toFormat(format: 'gif', options?: GifOptions): this
  toFormat(format: OutputFormat | 'jpg', options?: FormatOptions): this
  toFormat(format: OutputFormat | 'jpg', options?: FormatOptions): this {
    switch (format) {
      case 'jpeg':
      case 'jpg':
        return this.jpeg(options as JpegOptions)
      case 'png':
        return this.png(options as PngOptions)
      case 'webp':
        return this.webp(options as WebpOptions)
      case 'gif':
        return this.gif(options as GifOptions)
      default:
        throw invalid('format', 'one of jpeg, jpg, png, webp, gif', format)
    }
  }

  timeout({ seconds }: TimeoutOptions): this {
    // Round up, because 0 disables the timeout.
    this.#limits.timeoutMs = Math.ceil(checkNumber('seconds', seconds, 0, 3600) * 1000)
    return this
  }

  /** Processes the image. Without an explicit output format, uses the input format. */
  toBuffer(options?: ToBufferOptions & { resolveWithObject?: false }): Promise<Buffer>
  toBuffer(options: ToBufferOptions & { resolveWithObject: true }): Promise<{ data: Buffer; info: OutputInfo }>
  async toBuffer(options: ToBufferOptions = {}): Promise<Buffer | { data: Buffer; info: OutputInfo }> {
    const { signal, resolveWithObject } = options
    const nativeOptions: NativeTransformOptions = {
      limits: this.#limits,
      autoOrient: this.#autoOrient,
      rotate: this.#rotate,
      resize: this.#resize,
      blur: this.#blur,
      ...this.#output,
    }
    const result = await withCancelToken(signal, (token) => nativeTransform(this.#input, nativeOptions, token))
    if (result.error) {
      throw toError(result.error, signal)
    }
    const data = result.data!
    const info = result.info as OutputInfo
    return resolveWithObject ? { data, info } : data
  }

  /** Reads the image header without decoding pixels. Ignores all operations. */
  async metadata(options: ProcessOptions = {}): Promise<Metadata> {
    const { signal } = options
    const result = await withCancelToken(signal, (token) => nativeMetadata(this.#input, this.#limits, token))
    if (result.error) {
      throw toError(result.error, signal)
    }
    const metadata = result.metadata!
    const swap = metadata.orientation >= 5
    return {
      format: metadata.format as InputFormat,
      width: metadata.width,
      height: metadata.height,
      hasAlpha: metadata.hasAlpha,
      orientation: metadata.orientation,
      hasProfile: metadata.hasProfile,
      autoOrient: {
        width: swap ? metadata.height : metadata.width,
        height: swap ? metadata.width : metadata.height,
      },
    }
  }
}

/**
 * Creates a pipeline, like `sharp(input, options)`. Unlike sharp, only in-memory input is supported
 * (never file paths).
 */
export function blunt(input: Input, options?: BluntOptions): Pipeline {
  return new Pipeline(input, options)
}
