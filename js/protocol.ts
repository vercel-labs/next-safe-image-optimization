// The worker protocol (see `crates/core/src/protocol.rs`). Requests are built by the backends, from
// `input` and `encodeOptions()`. Responses come from a worker, so they're untrusted, and parsed
// defensively.

import type { InputFormat, OutputFormat, OutputInfo } from './index.js'

export interface RequestOptions {
  transform?: TransformOptions
  metadata?: LimitOptions
}

export interface LimitOptions {
  /** 0 disables the limit. */
  limitInputPixels?: number
  limitAllocatorMemory?: number
}

export interface ColorOptions {
  r: number
  g: number
  b: number
  /** 0-1 */
  alpha: number
}

export interface ResizeOptions {
  width?: number
  height?: number
  fit?: string
  /** 0 (left) to 1 (right). */
  gravityX?: number
  /** 0 (top) to 1 (bottom). */
  gravityY?: number
  kernel?: string
  withoutEnlargement?: boolean
  withoutReduction?: boolean
  background?: ColorOptions
}

export interface TransformOptions {
  limits?: LimitOptions
  autoOrient?: boolean
  /** Clockwise degrees, a multiple of 90. */
  rotate?: number
  resize?: ResizeOptions
  /** Omit `sigma` for a mild 3x3 box blur. */
  blur?: { sigma?: number }
  /** Defaults to the input format. */
  format?: OutputFormat
  jpeg?: {
    quality?: number
    mozjpeg?: boolean
  }
  png?: { compressionLevel?: number; adaptiveFiltering?: boolean }
  webp?: {
    quality?: number
    alphaQuality?: number
    lossless?: boolean
    nearLossless?: boolean
    smartSubsample?: boolean
    effort?: number
  }
  gif?: { effort?: number }
}

export interface RunOptions {
  /** Wall time, starting when a worker picks up the request. Omit to wait indefinitely. */
  timeoutMs?: number
  /** A larger response is treated as a crash. */
  maxResponseBytes: number
}

export interface WorkerError {
  code: string
  message: string
}

/** Exactly one of `response` (untrusted, without the length prefix) or `error` is set. */
export interface RunResult {
  response?: Uint8Array
  error?: WorkerError
}

export interface Backend {
  readonly name: 'native' | 'wasm'
  run(input: Uint8Array, options: string, runOptions: RunOptions): Promise<RunResult>
}

/** These must match `crates/core/src/protocol.rs`. */
export const EXIT_OUT_OF_MEMORY = 86
export const EXIT_MEMORY_LIMIT = 90
const KIND_TRANSFORM = 0
const KIND_METADATA = 1
const KIND_ERROR = 2
const FORMATS: readonly InputFormat[] = ['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif']
const ERROR_CODES = [
  'ERR_UNSUPPORTED_FORMAT',
  'ERR_LIMIT_EXCEEDED',
  'ERR_DECODE_FAILED',
  'ERR_ENCODE_FAILED',
  'ERR_INTERNAL',
] as const

/** Room for everything in a response besides the encoded image. */
const RESPONSE_OVERHEAD = 64 * 1024

/**
 * The encoded image is bounded by the encoder's memory, which is bounded by `limitAllocatorMemory`. So
 * anything larger means the worker is misbehaving.
 */
export function maxResponseBytes(limitAllocatorMemory: number): number {
  return limitAllocatorMemory + RESPONSE_OVERHEAD
}

export function encodeOptions(options: RequestOptions): string {
  return JSON.stringify(options)
}

export class InvalidResponseError extends Error {}

export type Response =
  | { kind: 'transform'; data: Buffer; info: OutputInfo }
  | {
      kind: 'metadata'
      format: InputFormat
      width: number
      height: number
      hasAlpha: boolean
      orientation: number
      hasProfile: boolean
    }
  | { kind: 'error'; code: (typeof ERROR_CODES)[number]; message: string }

function format(index: number, allowed: readonly string[] = FORMATS): InputFormat {
  const name = FORMATS[index]
  if (name === undefined || !allowed.includes(name)) {
    throw new InvalidResponseError(`invalid format ${index}`)
  }
  return name
}

function boolean(value: number): boolean {
  if (value > 1) {
    throw new InvalidResponseError(`invalid boolean ${value}`)
  }
  return value === 1
}

/** Throws an `InvalidResponseError` if the response is malformed. */
export function decodeResponse(response: Uint8Array): Response {
  const view = new DataView(response.buffer, response.byteOffset, response.byteLength)
  const fixed = (length: number) => {
    if (response.length < length) {
      throw new InvalidResponseError(`truncated response (${response.length} bytes)`)
    }
  }
  fixed(1)
  switch (response[0]) {
    case KIND_TRANSFORM: {
      fixed(11)
      const channels = response[10]
      if (channels < 1 || channels > 4) {
        throw new InvalidResponseError(`invalid channel count ${channels}`)
      }
      const data = Buffer.from(response.buffer, response.byteOffset + 11, response.length - 11)
      const info: OutputInfo = {
        format: format(response[1], ['jpeg', 'png', 'webp', 'gif']) as OutputFormat,
        width: view.getUint32(2, true),
        height: view.getUint32(6, true),
        channels,
        size: data.length,
      }
      return { kind: 'transform', data, info }
    }
    case KIND_METADATA: {
      fixed(13)
      if (response.length !== 13) {
        throw new InvalidResponseError('metadata response is too long')
      }
      const orientation = response[11]
      if (orientation < 1 || orientation > 8) {
        throw new InvalidResponseError(`invalid orientation ${orientation}`)
      }
      return {
        kind: 'metadata',
        format: format(response[1]),
        width: view.getUint32(2, true),
        height: view.getUint32(6, true),
        hasAlpha: boolean(response[10]),
        orientation,
        hasProfile: boolean(response[12]),
      }
    }
    case KIND_ERROR: {
      fixed(2)
      const code = ERROR_CODES[response[1]]
      if (code === undefined) {
        throw new InvalidResponseError(`invalid error code ${response[1]}`)
      }
      const message = new TextDecoder().decode(response.subarray(2))
      return { kind: 'error', code, message }
    }
    default:
      throw new InvalidResponseError(`invalid response kind ${response[0]}`)
  }
}
