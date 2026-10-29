import { availableParallelism } from 'node:os'

import { NativeBackend, findWorker } from './native.js'
import { InvalidResponseError, decodeResponse, encodeOptions, maxResponseBytes } from './protocol.js'
import type { Backend, LimitOptions, RequestOptions, Response, TransformOptions, Unchecked } from './protocol.js'
import type * as generated from './protocol.generated.js'
import { WasmBackend } from './wasm.js'

export type InputFormat = `${generated.InputFormat}`
export type OutputFormat = `${generated.OutputFormat}`
export type Kernel = `${generated.Kernel}`

export type Input = Uint8Array | ArrayBuffer | ArrayBufferView

export interface PipelineOptions {
  /**
   * Reject input images where `width * height` exceeds this. `true` uses the default; `false` or
   * `0` removes the limit (not recommended). Default: `268402689` (`0x3FFF * 0x3FFF`), like sharp.
   *
   * For SVGs, this applies to the natural size and the rendered size, but **not** to raster images
   * embedded in the SVG (`<image href="data:...">`). Those are only bounded by
   * `limitAllocatorMemoryBytes`, `limitProcessMemoryBytes`, and `timeoutMs()`.
   */
  limitInputPixels?: number | boolean
  /**
   * The maximum memory in bytes that processing may allocate, including the input. The worker's
   * allocator enforces this, by exiting the worker, which doesn't cover the C encoders (libwebp and
   * mozjpeg); see the pool's `limitProcessMemoryBytes` for that. Each stage (decode, resize, encode) also estimates
   * its memory before it runs, for a clearer error. Default: 512 MiB.
   */
  limitAllocatorMemoryBytes?: number
  /**
   * The maximum size in bytes of the encoded image. Larger output is rejected with
   * `ERR_LIMIT_EXCEEDED`. The pool also enforces it when it reads the worker's response, so a
   * misbehaving worker can't make it buffer more. Default: 128 MiB.
   */
  limitOutputBytes?: number
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
}

export type BackendName = 'native' | 'wasm'

export interface PoolOptions {
  /**
   * `'native'` processes images in worker processes. `'wasm'` processes them in worker threads,
   * with a wasm build. Default: the `NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND` environment variable,
   * or else `'native'`, falling back to `'wasm'` if there's no native worker binary for this
   * platform.
   */
  backend?: BackendName
  /** The maximum number of workers at once. Default: `os.availableParallelism()`. */
  concurrency?: number
  /**
   * Milliseconds before an idle worker exits. 0 exits as soon as it's idle, and `Infinity` never
   * does. Idle workers don't keep the process alive either way. Default: 10000.
   */
  idleTimeoutMs?: number
  /**
   * The maximum memory of each worker in bytes, enforced by the OS: `RLIMIT_DATA` on Linux, and the
   * memory's maximum size for wasm. There's no limit on macOS or Windows. This is a backstop for
   * `limitAllocatorMemoryBytes`, and unlike it, covers the C encoders (libwebp and mozjpeg). It's per
   * worker, not per image, so it should be larger than `limitAllocatorMemoryBytes`. `false` or
   * `0` removes the limit (not recommended). Default: 768 MiB.
   */
  limitProcessMemoryBytes?: number | false
  /**
   * Fork native workers from a fork server (one per pool), instead of spawning each one, which
   * makes starting a worker faster. Forked workers share the fork server's address space layout
   * (ASLR), and the fork server passes their sockets to Node over its IPC channel, which Node
   * doesn't officially support with a process that isn't Node (though Node, Bun, and Deno have used
   * the same protocol for years). Ignored on Windows and for `'wasm'`. Default: `true`.
   */
  forkServer?: boolean
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

export interface OutputInfo {
  format: OutputFormat
  width: number
  height: number
  channels: number
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

export type ErrorCode =
  /** Errors from the worker. `ERR_ANIMATED`: the input is animated, with `allowAnimated: false`. */
  | Exclude<`${generated.ErrorCode}`, 'ERR_INVALID_OPTIONS'>
  /** Processing took longer than `timeoutMs()`. */
  | 'ERR_TIMEOUT'
  /** The worker ran out of memory. */
  | 'ERR_OUT_OF_MEMORY'
  /** The worker crashed or sent an invalid response. */
  | 'ERR_WORKER_CRASHED'
  /** The worker couldn't be started. */
  | 'ERR_WORKER_SPAWN'

/**
 * Errors from processing an image. Invalid options are `TypeError`s instead. Most are only
 * validated by the worker, so `toBuffer()` or `metadata()` rejects with them. The input, the pool
 * and its options, `timeoutMs()`, and `limitOutputBytes` throw immediately.
 */
export class SafeImageOptimizationError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'SafeImageOptimizationError'
    this.code = code
  }
}

const DEFAULT_LIMIT_INPUT_PIXELS = 0x3fff * 0x3fff

function invalid(name: string, expected: string, value: unknown): TypeError {
  return new TypeError(`Expected ${expected} for ${name} but received ${String(value)} of type ${typeof value}`)
}

function checkInteger(name: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw invalid(name, `integer of at least ${min}`, value)
  }
  return value
}

/** Any number, not just integers: these are only used by JS timers. */
function checkMs(name: string, value: unknown): number {
  if (typeof value !== 'number' || !(value >= 0)) {
    throw invalid(name, 'number of at least 0', value)
  }
  return value
}

/**
 * A shallow copy, so that later changes to `options` don't apply. The worker validates what's in
 * it, and rejects unknown fields.
 */
function copyOptions<T extends object>(options: T | null | undefined): Partial<T> {
  if (options == null) {
    return {}
  }
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw invalid('options', 'object', options)
  }
  return { ...options }
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

/** Same as `DEFAULT_OUTPUT_BYTES` in `crates/core/src/limits.rs`. */
const DEFAULT_LIMIT_OUTPUT_BYTES = 128 * 1024 * 1024
const DEFAULT_LIMIT_PROCESS_MEMORY = 768 * 1024 * 1024
const BACKENDS: readonly BackendName[] = ['native', 'wasm']

function createBackend(options: PoolOptions): Backend {
  const concurrency = optional(options.concurrency, (v) => checkInteger('concurrency', v, 1))
  const idleTimeoutMs = optional(options.idleTimeoutMs, (v) => checkMs('idleTimeoutMs', v)) ?? 10_000
  const memoryLimit =
    options.limitProcessMemoryBytes === false
      ? 0
      : (optional(options.limitProcessMemoryBytes, (v) =>
          checkInteger('limitProcessMemoryBytes', v, 0),
        ) ?? DEFAULT_LIMIT_PROCESS_MEMORY)
  const forkServer: unknown = options.forkServer ?? true
  if (typeof forkServer !== 'boolean') {
    throw invalid('forkServer', 'boolean', forkServer)
  }
  const backend = options.backend ?? process.env.NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND
  if (backend !== undefined) {
    checkOneOf('backend', backend, BACKENDS)
  }
  const maxWorkers = concurrency ?? availableParallelism()
  const wasm = () =>
    new WasmBackend({ maxWorkers, idleTimeoutMs, memoryLimit })
  if (backend === 'wasm') {
    return wasm()
  }
  const worker = findWorker()
  if (worker === undefined) {
    if (backend === 'native') {
      throw new Error(`There's no native worker binary for ${process.platform}-${process.arch}`)
    }
    return wasm()
  }
  return new NativeBackend({
    workerPath: worker.path,
    maxProcesses: maxWorkers,
    idleTimeoutMs,
    memoryLimit,
    forkServer,
    // Local builds show the worker's stderr. Installed ones discard it (rav1d logs errors there).
    inheritStderr: worker.local,
  })
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

  /**
   * Creates a pipeline that processes `input` with this pool's workers. Only in-memory input is
   * supported (never file paths).
   */
  prepare(input: Input, options?: PipelineOptions): Pipeline {
    return new Pipeline(this, input, options)
  }

  /** @internal */
  async run(
    input: Uint8Array,
    options: RequestOptions,
    limitOutputBytes: number | undefined,
    timeoutMs?: number,
  ): Promise<Response> {
    const result = await this.#backend.run(input, encodeOptions(options), {
      timeoutMs,
      maxResponseBytes: maxResponseBytes(limitOutputBytes ?? DEFAULT_LIMIT_OUTPUT_BYTES),
    })
    if (result.error) {
      throw new SafeImageOptimizationError(result.error.code as ErrorCode, result.error.message)
    }
    let response
    try {
      response = decodeResponse(result.response!)
    } catch (error) {
      if (error instanceof InvalidResponseError) {
        throw new SafeImageOptimizationError('ERR_WORKER_CRASHED', `the worker sent an invalid response: ${error.message}`)
      }
      throw error
    }
    if (response.kind === 'error') {
      if (response.code === 'ERR_INVALID_OPTIONS') {
        throw new TypeError(response.message)
      }
      throw new SafeImageOptimizationError(response.code, response.message)
    }
    return response
  }
}

let globalPool: Pool | undefined

/** A shared pool, created with default options on first use. */
export function defaultPool(): Pool {
  globalPool ??= new Pool()
  return globalPool
}

/**
 * A chainable image processing pipeline, similar to a sharp instance, created by `Pool.prepare()`.
 * Operations always run in this order, regardless of call order: auto-orient, rotate, resize.
 */
export class Pipeline {
  #input: Uint8Array
  #pool: Pool
  #limits: Unchecked<LimitOptions>
  /** Validated here, because the response's maximum size depends on it. */
  #limitOutputBytes: number | undefined
  #timeoutMs: number | undefined
  #autoOrient: unknown
  #rotate: unknown
  #resize: ResizeOptions | undefined
  #output: Pick<Unchecked<TransformOptions>, 'format' | 'jpeg' | 'png' | 'webp' | 'gif'> = {}

  /** @internal Use `Pool.prepare()`. */
  constructor(pool: Pool, input: Input, options?: PipelineOptions) {
    this.#pool = pool
    this.#input = toUint8Array(input)
    // The rest are the worker's limits.
    const { autoOrient, limitInputPixels, limitOutputBytes, ...limits } = copyOptions(options)
    this.#limitOutputBytes = optional(limitOutputBytes, (v) => checkInteger('limitOutputBytes', v, 1))
    const { allowedInputFormats } = limits
    this.#limits = {
      ...limits,
      limitInputPixels:
        typeof limitInputPixels === 'boolean' ? (limitInputPixels ? DEFAULT_LIMIT_INPUT_PIXELS : 0) : limitInputPixels,
      limitOutputBytes: this.#limitOutputBytes,
      allowedInputFormats: Array.isArray(allowedInputFormats) ? [...allowedInputFormats] : allowedInputFormats,
    }
    this.#autoOrient = autoOrient
  }

  /**
   * Limits the wall time of processing, in milliseconds (like sharp's `timeout()`, which takes whole
   * seconds). The time starts when a worker picks up the image, not while it waits for a free
   * worker. The worker is killed when the time runs out, so this works even if a decoder hangs.
   *
   * 0 (the default, like sharp) or `Infinity` waits indefinitely, but you should set a timeout for
   * untrusted input. Otherwise, an image that's slow to process can occupy a worker indefinitely.
   */
  timeoutMs(ms: number): this {
    checkMs('timeoutMs', ms)
    this.#timeoutMs = ms === 0 ? undefined : ms
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
    this.#rotate = angle
    return this
  }

  resize(width?: number | null, height?: number | null, options?: ResizeOptions): this
  resize(options: ResizeOptions): this
  resize(widthOrOptions?: number | null | ResizeOptions, height?: number | null, options?: ResizeOptions): this {
    if (widthOrOptions !== null && typeof widthOrOptions === 'object') {
      this.#resize = copyOptions(widthOrOptions)
    } else {
      const resize = copyOptions(options)
      resize.width = widthOrOptions ?? resize.width
      resize.height = height ?? resize.height
      this.#resize = resize
    }
    return this
  }

  jpeg(options?: JpegOptions): this {
    this.#output = { format: 'jpeg', jpeg: copyOptions(options) }
    return this
  }

  png(options?: PngOptions): this {
    this.#output = { format: 'png', png: copyOptions(options) }
    return this
  }

  webp(options?: WebpOptions): this {
    this.#output = { format: 'webp', webp: copyOptions(options) }
    return this
  }

  gif(options?: GifOptions): this {
    this.#output = { format: 'gif', gif: copyOptions(options) }
    return this
  }

  /** Processes the image. Without an explicit output format, uses the input format. */
  toBuffer(options?: ToBufferOptions & { resolveWithObject?: false }): Promise<Buffer>
  toBuffer(options: ToBufferOptions & { resolveWithObject: true }): Promise<{ data: Buffer; info: OutputInfo }>
  async toBuffer(options: ToBufferOptions = {}): Promise<Buffer | { data: Buffer; info: OutputInfo }> {
    const transform: Unchecked<TransformOptions> = {
      limits: this.#limits,
      autoOrient: this.#autoOrient,
      rotate: this.#rotate,
      resize: this.#resize,
      ...this.#output,
    }
    const response = await this.#run({ transform })
    if (response.kind !== 'transform') {
      throw new SafeImageOptimizationError('ERR_WORKER_CRASHED', `the worker sent a ${response.kind} response to a transform`)
    }
    const { data, info } = response
    return options.resolveWithObject ? { data, info } : data
  }

  /** Reads the image header without decoding pixels. Ignores all operations except `timeoutMs()`. */
  async metadata(): Promise<Metadata> {
    const metadata = await this.#run({ metadata: this.#limits })
    if (metadata.kind !== 'metadata') {
      throw new SafeImageOptimizationError('ERR_WORKER_CRASHED', `the worker sent a ${metadata.kind} response to metadata`)
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
    return this.#pool.run(this.#input, options, this.#limitOutputBytes, this.#timeoutMs)
  }
}
