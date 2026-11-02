import { availableParallelism } from 'node:os'

import { NativeBackend, findWorker } from './native.js'
import { encodeOptions, invalidOptions, maxResponseBytes } from './protocol.js'
import type {
  Backend,
  LimitOptions,
  RequestKind,
  RequestOptions,
  Response,
  TransformOptions,
  Unchecked,
} from './protocol.js'
import type * as generated from './protocol.generated.js'
import { WASM_PACKAGE, WasmBackend, findWasm } from './wasm.js'

export type InputFormat = `${generated.InputFormat}`
export type OutputFormat = `${generated.OutputFormat}`
export type Kernel = `${generated.Kernel}`
/**
 * What to do with animated input (see `Pipeline.animated()`). PNG (APNG), WebP, and AVIF count as
 * animated if their header declares an animation, and GIF if it has more than one frame.
 * - `'first-frame'`: decode only the first frame.
 * - `'reject'`: reject animated input with `ERR_ANIMATED`, before decoding it.
 */
export type Animated = `${generated.Animated}`

/** The encoded image, in memory (never a file path). `Buffer` and `Uint8Array` are `ArrayBufferView`s. */
export type Input = ArrayBufferView | ArrayBuffer | SharedArrayBuffer

export type BackendName = 'native' | 'wasm'

export interface PoolOptions {
  /** The maximum number of workers at once. Default: `os.availableParallelism()`. */
  concurrency?: number
  /**
   * Milliseconds before an idle worker exits. 0 means no limit: idle workers never exit. Idle
   * workers don't keep the process alive either way. Default: 10000.
   *
   * Workers are only idle if they're reused, so this has no effect with `maxImagesPerWorker: 1`
   * (the default, except on Windows).
   */
  idleTimeoutMs?: number
  /**
   * The maximum number of images a worker processes before it's killed and
   * replaced.
   *
   * If there is a vulnerability in an image codec, a malicious input image
   * could corrupt memory in a worker, leaking information across requests. A
   * limit of `1` ensures that memory is not shared across requests.
   *
   * 0 means no limit: workers are reused until they're idle for `idleTimeoutMs`.
   *
   * The latency overhead of `maxImagesPerWorker: 1` is roughly:
   * - Linux native, with the fork server (default): ~0.5ms
   * - Linux native, without the fork server: ~1-3ms
   * - WASM: ~16ms
   *
   * Default: 1, except 64 for native workers on Windows, where the per-process
   * overhead is higher.
   */
  maxImagesPerWorker?: number
  /**
   * The maximum memory of each worker process in bytes, enforced by the
   * operating system or platform. This option is unsupported and ignored on
   * native macOS and Windows builds.
   *
   * - On Linux, this is enforced using [`RLIMIT_DATA`].
   * - On WASM, this enforced by configuring the maximum number of pages when
   *   constructing [`WebAssembly.Memory`].
   *
   * [`RLIMIT_DATA`]: https://sourceware.org/glibc/manual/2.44/html_node/Limits-on-Resources.html#index-struct-rlimit64
   * [`WebAssembly.Memory`]: https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory
   *
   * This is a backstop for `limitAllocatorMemoryBytes()`. It covers non-Rust
   * image codecs (libwebp and mozjpeg). This should be larger than
   * `limitAllocatorMemoryBytes()`.
   *
   * Exceeding it fails with `ERR_OUT_OF_MEMORY`, not `ERR_LIMIT_EXCEEDED`: to the worker, it's
   * the same as the system running out of memory.
   *
   * 0 means no limit (not recommended). Default: 768 MiB.
   */
  limitProcessMemoryBytes?: number
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

export interface MetadataOptions {
  /**
   * Aborts processing: the image is removed from the queue, or the worker processing it is killed.
   * The promise rejects with `signal.reason`.
   */
  signal?: AbortSignal
}

export interface ToBufferOptions extends MetadataOptions {
  resolveWithObject?: boolean
}

/**
 * `SafeImageOptimizationError`'s codes:
 * - `ERR_UNSUPPORTED_FORMAT`: the input's format isn't supported, or isn't allowed by
 *   `allowInputFormats()`, or the output format isn't supported.
 * - `ERR_ANIMATED`: the input is animated, with `animated('reject')`.
 * - `ERR_LIMIT_EXCEEDED`: the image exceeded `limitInputPixels()`, `limitAllocatorMemoryBytes()`, or
 *   `limitOutputBytes()`.
 * - `ERR_DECODE_FAILED`, `ERR_ENCODE_FAILED`: the input is invalid, or encoding failed.
 * - `ERR_INTERNAL`: a bug.
 * - `ERR_TIMEOUT`: processing took longer than `timeoutMs()`.
 * - `ERR_OUT_OF_MEMORY`: the worker ran out of memory, either because it exceeded the pool's
 *   `limitProcessMemoryBytes`, or because the system did.
 * - `ERR_WORKER_CRASHED`: the worker crashed, or sent an invalid response.
 * - `ERR_WORKER_SPAWN`: the worker couldn't be started.
 * - `ERR_BACKEND_UNAVAILABLE`: thrown by `new Pool()` (and `defaultPool()`) if there's no native
 *   worker binary for this platform and `@next/safe-image-optimization-wasm32` isn't installed, or
 *   `NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND` chose a backend that isn't available.
 * - `ERR_POOL_CLOSED`: the pool was closed before the image was submitted, or destroyed before it
 *   finished.
 *
 * Invalid options throw (or reject with) a `TypeError` instead, with the code `ERR_INVALID_OPTIONS`.
 */
export type ErrorCode =
  | Exclude<`${generated.ErrorCode}`, 'ERR_INVALID_OPTIONS'>
  | 'ERR_TIMEOUT'
  | 'ERR_OUT_OF_MEMORY'
  | 'ERR_WORKER_CRASHED'
  | 'ERR_WORKER_SPAWN'
  | 'ERR_BACKEND_UNAVAILABLE'
  | 'ERR_POOL_CLOSED'

/**
 * Errors from processing an image (see `ErrorCode`). Invalid options are `TypeError`s instead. Most
 * are only validated by the worker, so `toBuffer()` or `metadata()` rejects with them. The input,
 * the pool and its options, `timeoutMs()`, `limitOutputBytes()`, and `rotate()` without an angle
 * throw immediately.
 */
export class SafeImageOptimizationError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'SafeImageOptimizationError'
    this.code = code
  }
}

function invalid(name: string, expected: string, value: unknown): TypeError {
  return invalidOptions(
    `Expected ${expected} for ${name} but received ${String(value)} of type ${typeof value}`,
  )
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

function checkSignal(signal: unknown): AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw invalid('signal', 'AbortSignal', signal)
  }
  return signal
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
const BACKEND_VARIABLE = 'NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND'

function createBackend(options: PoolOptions): Backend {
  const concurrency = optional(options.concurrency, (v) => checkInteger('concurrency', v, 1))
  const idleTimeoutMs =
    optional(options.idleTimeoutMs, (v) => checkMs('idleTimeoutMs', v)) ?? 10_000
  const memoryLimit =
    optional(options.limitProcessMemoryBytes, (v) =>
      checkInteger('limitProcessMemoryBytes', v, 0),
    ) ?? DEFAULT_LIMIT_PROCESS_MEMORY
  const forkServer: unknown = options.forkServer ?? true
  if (typeof forkServer !== 'boolean') {
    throw invalid('forkServer', 'boolean', forkServer)
  }
  const maxImagesPerWorker = optional(options.maxImagesPerWorker, (v) =>
    checkInteger('maxImagesPerWorker', v, 0),
  )
  const backend = process.env[BACKEND_VARIABLE] || undefined
  if (backend !== undefined) {
    checkOneOf(BACKEND_VARIABLE, backend, BACKENDS)
  }
  const maxWorkers = concurrency ?? availableParallelism()
  const unavailable = (message: string) =>
    new SafeImageOptimizationError('ERR_BACKEND_UNAVAILABLE', message)
  const wasm = (context: string) => {
    const wasmPath = findWasm()
    if (wasmPath === undefined) {
      throw unavailable(`${context}Install ${WASM_PACKAGE} to use the wasm backend.`)
    }
    return new WasmBackend({
      wasmPath,
      maxWorkers,
      idleTimeoutMs,
      maxImagesPerWorker: maxImagesPerWorker ?? 1,
      memoryLimit,
    })
  }
  if (backend === 'wasm') {
    return wasm('')
  }
  const worker = findWorker()
  if (worker === undefined) {
    const noNative = `There's no native worker binary for ${process.platform}-${process.arch}.`
    if (backend === 'native') {
      throw unavailable(noNative)
    }
    return wasm(`${noNative} `)
  }
  return new NativeBackend({
    workerPath: worker.path,
    maxProcesses: maxWorkers,
    idleTimeoutMs,
    maxImagesPerWorker: maxImagesPerWorker ?? (process.platform === 'win32' ? 64 : 1),
    memoryLimit,
    forkServer,
    // Local builds show the worker's stderr. Installed ones discard it (rav1d logs errors there).
    inheritStderr: worker.local,
  })
}

/**
 * A pool of workers (processes, or threads running wasm) that process images, one image per worker
 * at a time. Workers are started on demand, and exit when idle or after `maxImagesPerWorker`
 * images. A worker that crashes or times out is replaced.
 *
 * Idle workers don't keep the process alive, so a pool doesn't need to be closed. To stop its
 * workers, call `close()` (or use `await using`), or `destroy()`.
 */
export class Pool {
  /**
   * `'native'` processes images in worker processes. `'wasm'` processes them in worker threads,
   * with a wasm build. The `NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND` environment variable chooses one
   * (read when the pool is created). Otherwise, it's `'native'`, falling back to `'wasm'` if
   * there's no native worker binary for this platform. The wasm build is in a separate package,
   * `@next/safe-image-optimization-wasm32`, which isn't installed by default.
   *
   * `NEXT_SAFE_IMAGE_OPTIMIZATION_WORKER_PATH` and `NEXT_SAFE_IMAGE_OPTIMIZATION_WASM_PATH` replace
   * the installed worker binary and wasm module with other files, like local builds.
   */
  readonly backend: BackendName
  #backend: Backend
  #closed = false

  constructor(options: PoolOptions = {}) {
    this.#backend = createBackend(options)
    this.backend = this.#backend.name
  }

  /** Creates a pipeline that processes `input` with this pool's workers. */
  prepare(input: Input): Pipeline {
    return new Pipeline(this, input)
  }

  /**
   * Shuts the pool down gracefully: images submitted from now on reject with `ERR_POOL_CLOSED`,
   * but the ones already submitted (including queued ones) are still processed. Resolves once
   * they've finished and every worker has exited. Calling it again returns the same promise.
   *
   * `await using pool = new Pool()` calls this at the end of the scope.
   */
  close(): Promise<void> {
    this.#closed = true
    return this.#backend.close()
  }

  /**
   * Shuts the pool down immediately: kills every worker, and rejects images that are queued or
   * being processed (and ones submitted later) with `ERR_POOL_CLOSED`. Resolves once every worker
   * has exited. Can also be called after `close()`, to stop waiting for its images.
   */
  destroy(): Promise<void> {
    this.#closed = true
    return this.#backend.destroy()
  }

  /** @internal */
  async run<K extends RequestKind>(
    input: Uint8Array,
    kind: K,
    options: NonNullable<RequestOptions[K]>,
    limitOutputBytes: number | undefined,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Extract<Response, { kind: K }>> {
    signal?.throwIfAborted()
    if (this.#closed) {
      throw new SafeImageOptimizationError('ERR_POOL_CLOSED', 'the pool is closed')
    }
    const result = await this.#backend.run(input, encodeOptions({ [kind]: options }), {
      kind,
      timeoutMs,
      maxResponseBytes: maxResponseBytes(limitOutputBytes ?? DEFAULT_LIMIT_OUTPUT_BYTES),
      signal,
    })
    if (result.aborted) {
      throw signal!.reason
    }
    if (result.error) {
      throw new SafeImageOptimizationError(result.error.code as ErrorCode, result.error.message)
    }
    const response = result.response!
    if (response.kind === 'error') {
      if (response.code === 'ERR_INVALID_OPTIONS') {
        throw invalidOptions(response.message)
      }
      throw new SafeImageOptimizationError(response.code, response.message)
    }
    // The backend checked that it matches `kind`.
    return response as Extract<Response, { kind: K }>
  }

  /** `close()`. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

let globalPool: Pool | undefined

/**
 * A shared pool, created with default options on first use. Closing it closes it for every caller,
 * and later calls return the same (closed) pool.
 */
export function defaultPool(): Pool {
  globalPool ??= new Pool()
  return globalPool
}

/**
 * A chainable image processing pipeline, similar to a sharp instance, created by `Pool.prepare()`.
 * Operations always run in this order, regardless of call order: auto-orient, rotate, resize.
 *
 * A pipeline can process its input more than once (e.g. `metadata()`, then `toBuffer()`).
 */
export class Pipeline {
  #input: Uint8Array
  #pool: Pool
  #limits: Unchecked<LimitOptions> = {}
  /** Validated here, because the response's maximum size depends on it. */
  #limitOutputBytes: number | undefined
  #timeoutMs: number | undefined
  #autoOrient = false
  #rotate: unknown
  #resize: ResizeOptions | undefined
  #output: Pick<Unchecked<TransformOptions>, 'format' | 'jpeg' | 'png' | 'webp' | 'gif'> = {}
  /** Aborted when the pipeline is disposed. */
  #disposed = new AbortController()
  #pending = new Set<Promise<unknown>>()

  /** @internal Use `Pool.prepare()`. */
  constructor(pool: Pool, input: Input) {
    this.#pool = pool
    this.#input = toUint8Array(input)
  }

  /**
   * Rejects input images where `width * height` exceeds this, with `ERR_LIMIT_EXCEEDED`. 0 means no
   * limit (not recommended). Default: `268402689` (`0x3FFF * 0x3FFF`), like sharp.
   *
   * For SVGs, this applies to the natural size and the rendered size, but **not** to raster images
   * embedded in the SVG (`<image href="data:...">`). Those are only bounded by
   * `limitAllocatorMemoryBytes()`, the pool's `limitProcessMemoryBytes`, and `timeoutMs()`.
   */
  limitInputPixels(pixels: number): this {
    this.#limits.limitInputPixels = pixels
    return this
  }

  /**
   * The maximum memory in bytes that processing may allocate, including the input. The worker's
   * allocator enforces this, by exiting the worker, which doesn't cover the C encoders (libwebp and
   * mozjpeg); see the pool's `limitProcessMemoryBytes` for that. Each stage (decode, resize,
   * encode) also estimates its memory before it runs, for a clearer error. Either way, exceeding it
   * fails with `ERR_LIMIT_EXCEEDED`. 0 means no limit (not recommended). Default: 512 MiB.
   */
  limitAllocatorMemoryBytes(bytes: number): this {
    this.#limits.limitAllocatorMemoryBytes = bytes
    return this
  }

  /**
   * The maximum size in bytes of the encoded image. Larger output is rejected with
   * `ERR_LIMIT_EXCEEDED`. The pool also enforces it when it reads the worker's response, so a
   * misbehaving worker can't make it buffer more. 0 means no limit (not recommended).
   * Default: 128 MiB.
   */
  limitOutputBytes(bytes: number): this {
    this.#limitOutputBytes = checkInteger('limitOutputBytes', bytes, 0)
    this.#limits.limitOutputBytes = bytes
    return this
  }

  /**
   * Rejects input in any other format with `ERR_UNSUPPORTED_FORMAT`, before decoding it. The format
   * is always detected from the input's contents. Must not be empty. Default: every `InputFormat`
   * except `'svg'`, which must be allowed explicitly: the pixel limit doesn't apply to raster images
   * embedded in an SVG (see `limitInputPixels()`).
   */
  allowInputFormats(formats: readonly InputFormat[]): this {
    this.#limits.allowedInputFormats = Array.isArray(formats) ? [...formats] : formats
    return this
  }

  /** What to do with animated input (see `Animated`). Default: `'first-frame'`. */
  animated(mode: Animated): this {
    this.#limits.animated = mode
    return this
  }

  /**
   * Limits the wall time of processing, in milliseconds (like sharp's `timeout()`, which takes whole
   * seconds). The time starts when a worker picks up the image, not while it waits for a free
   * worker. The worker is killed when the time runs out, so this works even if a decoder hangs.
   *
   * 0 means no limit, and is the default (like sharp), but you should set a timeout for untrusted
   * input. Otherwise, an image that's slow to process can occupy a worker indefinitely.
   */
  timeoutMs(ms: number): this {
    checkMs('timeoutMs', ms)
    this.#timeoutMs = ms === 0 ? undefined : ms
    return this
  }

  /**
   * Rotates and flips the image using its EXIF orientation, which is then stripped (like all
   * metadata). Runs before `rotate()` and `resize()`, regardless of call order.
   */
  autoOrient(): this {
    this.#autoOrient = true
    return this
  }

  /**
   * Rotates clockwise by `angle` degrees, which must be a multiple of 90 (negative angles rotate
   * counterclockwise). Calling it again replaces the angle. This ignores the EXIF orientation, unless
   * `autoOrient()` is also called, which runs first.
   *
   * Unlike sharp's, this doesn't auto-orient without an angle: `rotate()` throws a `TypeError`. Use
   * `autoOrient()` instead.
   */
  rotate(angle: number): this {
    if (angle === undefined) {
      throw invalidOptions(
        'rotate() requires an angle. To rotate using the EXIF orientation, use autoOrient().',
      )
    }
    this.#rotate = angle
    return this
  }

  resize(width?: number | null, height?: number | null, options?: ResizeOptions): this
  resize(options: ResizeOptions): this
  resize(
    widthOrOptions?: number | null | ResizeOptions,
    height?: number | null,
    options?: ResizeOptions,
  ): this {
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
  toBuffer(
    options: ToBufferOptions & { resolveWithObject: true },
  ): Promise<{ data: Buffer; info: OutputInfo }>
  async toBuffer(
    options: ToBufferOptions = {},
  ): Promise<Buffer | { data: Buffer; info: OutputInfo }> {
    const { resolveWithObject, signal } = copyOptions(options)
    const transform: Unchecked<TransformOptions> = {
      limits: this.#limits,
      autoOrient: this.#autoOrient,
      rotate: this.#rotate,
      resize: this.#resize,
      ...this.#output,
    }
    const { data, info } = await this.#run('transform', transform, signal)
    return resolveWithObject ? { data, info } : data
  }

  /**
   * Reads the image header without decoding pixels. Only the limits apply (`limitInputPixels()`,
   * `limitAllocatorMemoryBytes()`, `allowInputFormats()`, `animated()`, and `timeoutMs()`), and
   * other operations are ignored.
   */
  async metadata(options: MetadataOptions = {}): Promise<Metadata> {
    const { signal } = copyOptions(options)
    const metadata = await this.#run('metadata', this.#limits, signal)
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

  async #run<K extends RequestKind>(
    kind: K,
    options: NonNullable<RequestOptions[K]>,
    signal: unknown,
  ): Promise<Extract<Response, { kind: K }>> {
    const disposed = this.#disposed.signal
    const checked = checkSignal(signal)
    const combined = checked === undefined ? disposed : AbortSignal.any([checked, disposed])
    const promise = this.#pool.run(
      this.#input,
      kind,
      options,
      this.#limitOutputBytes,
      this.#timeoutMs,
      combined,
    )
    this.#pending.add(promise)
    try {
      return await promise
    } finally {
      this.#pending.delete(promise)
    }
  }

  /**
   * Aborts any of the pipeline's images that are still queued or being processed (killing their
   * workers), and resolves once they've stopped. Their promises, and ones for images submitted
   * later, reject with an `AbortError`. Called by `await using pipeline = pool.prepare(input)`. To
   * abort individual images, pass a `signal` to `toBuffer()` or `metadata()`.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    this.#disposed.abort()
    await Promise.allSettled(this.#pending)
  }
}
