import { availableParallelism } from 'node:os'

import { NativeBackend, loadBinding } from './native.js'
import { FORMATS, InvalidResponseError, decodeResponse, encodeOptions, maxResponseBytes } from './protocol.js'
import type {
  Backend,
  LimitOptions,
  RequestOptions,
  ResizeOptions as NativeResizeOptions,
  Response,
  TransformOptions,
} from './protocol.js'
import type * as generated from './protocol.generated.js'
import { WasmBackend } from './wasm.js'

export type InputFormat = `${generated.InputFormat}`
export type OutputFormat = `${generated.OutputFormat}`
export type Kernel = `${generated.Kernel}`

export type Input = Uint8Array | ArrayBuffer | ArrayBufferView

export interface BluntOptions {
  /**
   * Reject input images where `width * height` exceeds this. `true` uses the default; `false` or
   * `0` removes the limit (not recommended). Default: `268402689` (`0x3FFF * 0x3FFF`), like sharp.
   *
   * For SVGs, this applies to the natural size and the rendered size, but **not** to raster images
   * embedded in the SVG (`<image href="data:...">`). Those are only bounded by
   * `limitAllocatorMemory`, `limitProcessMemory`, and `timeout()`.
   */
  limitInputPixels?: number | boolean
  /**
   * The maximum memory in bytes that processing may allocate, including the input. The worker's
   * allocator enforces this, by exiting the worker, which doesn't cover the C encoders (libwebp and
   * mozjpeg); see the pool's `limitProcessMemory` for that. Each stage (decode, resize, encode) also estimates
   * its memory before it runs, for a clearer error. Default: 512 MiB.
   */
  limitAllocatorMemory?: number
  /**
   * Reject input in any other format with `ERR_UNSUPPORTED_FORMAT`, before decoding it. The format
   * is always detected from the input's contents. Must not be empty. Default: every `InputFormat`.
   */
  allowedInputFormats?: readonly InputFormat[]
  /**
   * `false` rejects animated input with `ERR_ANIMATED`, before decoding it. Otherwise, only the
   * first frame is decoded. PNG (APNG), WebP, and AVIF count as animated if their header declares an
   * animation, and GIF if it has more than one frame. Default: `true`.
   *
   * A future version may transform every frame of an animated image when this is `true`, depending
   * on the output format (e.g. GIF or WebP). Set this to `false` if you rely on only the first frame
   * being decoded.
   */
  allowAnimated?: boolean
  /** Equivalent to calling `autoOrient()`. */
  autoOrient?: boolean
  /** The pool of workers that processes the image. Default: `defaultPool()`. */
  pool?: Pool
}

export type BackendName = 'native' | 'wasm'

export interface PoolOptions {
  /**
   * `'native'` processes images in worker processes. `'wasm'` processes them in worker threads,
   * with a wasm build. Default: the `BLUNT_IMAGE_OPTIMIZATION_BACKEND` environment variable, or
   * else `'native'`, falling back to `'wasm'` if there's no native binding for this platform.
   */
  backend?: BackendName
  /** The maximum number of workers at once. Default: `os.availableParallelism()`. */
  concurrency?: number
  /** Milliseconds before an idle worker exits. Default: 10000. */
  idleTimeout?: number
  /**
   * The maximum memory of each worker in bytes, enforced by the OS: `RLIMIT_DATA` on Linux, and the
   * memory's maximum size for wasm. There's no limit on macOS or Windows. This is a backstop for
   * `limitAllocatorMemory`, and unlike it, covers the C encoders (libwebp and mozjpeg). It's per
   * worker, not per image, so it should be larger than `limitAllocatorMemory`. `false` or
   * `0` removes the limit (not recommended). Default: 768 MiB.
   */
  limitProcessMemory?: number | false
}

/**
 * Always like sharp's default `fit: 'cover'`, with the default `position: 'centre'`: the aspect
 * ratio is kept, and with both a width and a height, the excess is cropped, centered.
 */
export interface ResizeOptions {
  width?: number | null
  height?: number | null
  /** Default: `'lanczos3'`. */
  kernel?: Kernel
  withoutEnlargement?: boolean
  withoutReduction?: boolean
}

/** Output is always 4:2:0, with optimized Huffman tables, like sharp's defaults. */
export interface JpegOptions {
  /** 1-100. Default: 80. */
  quality?: number
  /**
   * Encode with mozjpeg instead of `jpeg-encoder`, with sharp's mozjpeg preset: progressive, trellis
   * quantization, overshoot deringing, scan optimization, and quantization table 3. Smaller files,
   * but slower. Output is progressive with mozjpeg, and baseline without it. Default: `false`.
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

export interface ToBufferOptions {
  resolveWithObject?: boolean
}

export interface TimeoutOptions {
  /** 0 (the default) waits indefinitely. */
  seconds: number
}

export type ErrorCode =
  /** Errors from the worker. `ERR_ANIMATED`: the input is animated, with `allowAnimated: false`. */
  | `${generated.ErrorCode}`
  /** Processing took longer than `timeout()`. */
  | 'ERR_TIMEOUT'
  /** The worker ran out of memory. */
  | 'ERR_OUT_OF_MEMORY'
  /** The worker crashed or sent an invalid response. */
  | 'ERR_WORKER_CRASHED'
  /** The worker couldn't be started. */
  | 'ERR_WORKER_SPAWN'

/** Errors from processing an image. Invalid arguments throw a `TypeError` instead. */
export class BluntError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'BluntError'
    this.code = code
  }
}

const KERNELS: readonly Kernel[] = ['nearest', 'linear', 'cubic', 'lanczos3']
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

/** Same as `DEFAULT_MEMORY` in `crates/core/src/limits.rs`. */
const DEFAULT_LIMIT_ALLOCATOR_MEMORY = 512 * 1024 * 1024
const DEFAULT_LIMIT_PROCESS_MEMORY = 768 * 1024 * 1024
const BACKENDS: readonly BackendName[] = ['native', 'wasm']

function createBackend(options: PoolOptions): Backend {
  const concurrency = optional(options.concurrency, (v) => checkInteger('concurrency', v, 1, 0xffffffff))
  const idleTimeout = optional(options.idleTimeout, (v) => checkInteger('idleTimeout', v, 0, 0xffffffff))
  const memoryLimit =
    options.limitProcessMemory === false
      ? 0
      : (optional(options.limitProcessMemory, (v) =>
          checkInteger('limitProcessMemory', v, 0, Number.MAX_SAFE_INTEGER),
        ) ?? DEFAULT_LIMIT_PROCESS_MEMORY)
  const backend = options.backend ?? process.env.BLUNT_IMAGE_OPTIMIZATION_BACKEND
  if (backend !== undefined) {
    checkOneOf('backend', backend, BACKENDS)
  }
  const maxWorkers = concurrency ?? availableParallelism()
  const idleTimeoutMs = idleTimeout ?? 10_000
  const wasm = () =>
    new WasmBackend({ maxWorkers, idleTimeoutMs, memoryLimit })
  if (backend === 'wasm') {
    return wasm()
  }
  let binding
  try {
    binding = loadBinding()
  } catch (error) {
    if (backend === 'native') {
      throw error
    }
    return wasm()
  }
  return new NativeBackend(binding, { maxProcesses: maxWorkers, idleTimeoutMs, memoryLimit })
}

/**
 * A pool of workers (processes, or threads running wasm) that process images, one image per worker
 * at a time. Workers are started on demand, and exit when idle. A worker that crashes or times out
 * is replaced.
 */
export class Pool {
  readonly backend: BackendName
  #backend: Backend

  constructor(options: PoolOptions = {}) {
    this.#backend = createBackend(options)
    this.backend = this.#backend.name
  }

  /** @internal */
  async run(input: Uint8Array, options: RequestOptions, limits: LimitOptions, timeoutMs?: number): Promise<Response> {
    const result = await this.#backend.run(input, encodeOptions(options), {
      timeoutMs,
      maxResponseBytes: maxResponseBytes(limits.limitAllocatorMemory ?? DEFAULT_LIMIT_ALLOCATOR_MEMORY),
    })
    if (result.error) {
      throw new BluntError(result.error.code as ErrorCode, result.error.message)
    }
    let response
    try {
      response = decodeResponse(result.response!)
    } catch (error) {
      if (error instanceof InvalidResponseError) {
        throw new BluntError('ERR_WORKER_CRASHED', `the worker sent an invalid response: ${error.message}`)
      }
      throw error
    }
    if (response.kind === 'error') {
      throw new BluntError(response.code, response.message)
    }
    return response
  }
}

let globalPool: Pool | undefined

/** The pool used by pipelines without a `pool` option. Created with default options on first use. */
export function defaultPool(): Pool {
  globalPool ??= new Pool()
  return globalPool
}

/**
 * A chainable image processing pipeline, similar to a sharp instance. Operations always run in this
 * order, regardless of call order: auto-orient, rotate, resize.
 */
export class Pipeline {
  #input: Uint8Array
  #pool: Pool | undefined
  #limits: LimitOptions = {}
  #timeoutMs: number | undefined
  #autoOrient = false
  #rotate: number | undefined
  #resize: NativeResizeOptions | undefined
  #output: Pick<TransformOptions, 'format' | 'jpeg' | 'png' | 'webp' | 'gif'> = {}

  constructor(input: Input, options: BluntOptions = {}) {
    this.#input = toUint8Array(input)
    const { limitInputPixels, limitAllocatorMemory, allowedInputFormats, allowAnimated, autoOrient, pool } = options
    if (pool !== undefined && !(pool instanceof Pool)) {
      throw invalid('pool', 'Pool', pool)
    }
    this.#pool = pool
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
    this.#limits.limitAllocatorMemory = optional(limitAllocatorMemory, (v) =>
      checkInteger('limitAllocatorMemory', v, 1, Number.MAX_SAFE_INTEGER),
    )
    if (allowedInputFormats !== undefined) {
      if (!Array.isArray(allowedInputFormats) || allowedInputFormats.length === 0) {
        throw invalid('allowedInputFormats', 'non-empty array', allowedInputFormats)
      }
      this.#limits.allowedInputFormats = allowedInputFormats.map((v) =>
        checkOneOf('allowedInputFormats', v, FORMATS),
      )
    }
    this.#limits.allowAnimated = optional(allowAnimated, (v) => checkBoolean('allowAnimated', v))
    if (optional(autoOrient, (v) => checkBoolean('autoOrient', v))) {
      this.autoOrient()
    }
  }

  /**
   * Limits the wall time of processing (in seconds, 0-3600), like sharp. The time starts when a
   * worker picks up the image, not while it waits for a free worker. The worker is killed when the
   * time runs out, so this works even if a decoder hangs.
   *
   * There's no timeout by default (like sharp), but you should set one for untrusted input.
   * Otherwise, an image that's slow to process can occupy a worker indefinitely.
   */
  timeout(options: TimeoutOptions): this {
    const seconds = checkInteger('timeout.seconds', options?.seconds, 0, 3600)
    this.#timeoutMs = seconds === 0 ? undefined : seconds * 1000
    return this
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
      kernel: optional(options.kernel, (v) => checkOneOf('kernel', v, KERNELS)),
      withoutEnlargement: optional(options.withoutEnlargement, (v) => checkBoolean('withoutEnlargement', v)),
      withoutReduction: optional(options.withoutReduction, (v) => checkBoolean('withoutReduction', v)),
    }
    this.#resize = resize
    return this
  }

  jpeg(options: JpegOptions = {}): this {
    this.#output = {
      format: 'jpeg',
      jpeg: {
        quality: optional(options.quality, (v) => checkInteger('quality', v, 1, 100)),
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

  /** Processes the image. Without an explicit output format, uses the input format. */
  toBuffer(options?: ToBufferOptions & { resolveWithObject?: false }): Promise<Buffer>
  toBuffer(options: ToBufferOptions & { resolveWithObject: true }): Promise<{ data: Buffer; info: OutputInfo }>
  async toBuffer(options: ToBufferOptions = {}): Promise<Buffer | { data: Buffer; info: OutputInfo }> {
    const transform: TransformOptions = {
      limits: this.#limits,
      autoOrient: this.#autoOrient,
      rotate: this.#rotate,
      resize: this.#resize,
      ...this.#output,
    }
    const response = await this.#run({ transform })
    if (response.kind !== 'transform') {
      throw new BluntError('ERR_WORKER_CRASHED', `the worker sent a ${response.kind} response to a transform`)
    }
    const { data, info } = response
    return options.resolveWithObject ? { data, info } : data
  }

  /** Reads the image header without decoding pixels. Ignores all operations except `timeout()`. */
  async metadata(): Promise<Metadata> {
    const metadata = await this.#run({ metadata: this.#limits })
    if (metadata.kind !== 'metadata') {
      throw new BluntError('ERR_WORKER_CRASHED', `the worker sent a ${metadata.kind} response to metadata`)
    }
    const swap = metadata.orientation >= 5
    return {
      format: metadata.format,
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

  #run(options: RequestOptions): Promise<Response> {
    return (this.#pool ?? defaultPool()).run(this.#input, options, this.#limits, this.#timeoutMs)
  }
}

/**
 * Creates a pipeline, like `sharp(input, options)`. Unlike sharp, only in-memory input is supported
 * (never file paths).
 */
export function blunt(input: Input, options?: BluntOptions): Pipeline {
  return new Pipeline(input, options)
}
