// The worker protocol (see `crates/core/src/protocol.rs`). Requests are built by the backends, from
// `input` and `encodeOptions()`. Responses come from a worker, so they're untrusted, and parsed
// defensively.
//
// The request options and protocol constants are generated from the Rust code
// (`protocol.generated.ts`, by `pnpm generate`).

import type { InputFormat, OutputFormat, OutputInfo } from './index.js'
import * as generated from './protocol.generated.js'
import type { LimitOptions, TransformOptions } from './protocol.generated.js'

export type { LimitOptions, ResizeOptions, TransformOptions } from './protocol.generated.js'
export { EXIT_MEMORY_LIMIT, EXIT_OUT_OF_MEMORY } from './protocol.generated.js'

/**
 * Options as the caller passed them. The worker validates them (`crates/core/src/request.rs`), and
 * rejects unknown fields with `ERR_INVALID_OPTIONS`.
 */
export type Unchecked<T> = { [K in keyof T]?: unknown }

/** `Request` in `crates/core/src/request.rs`, which typeshare can't export. Exactly one is set. */
export interface RequestOptions {
  transform?: Unchecked<TransformOptions>
  metadata?: Unchecked<LimitOptions>
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

/** In order: responses send formats and error codes as indexes. */
export const FORMATS: readonly InputFormat[] = Object.values(generated.InputFormat)
const OUTPUT_FORMATS: readonly OutputFormat[] = Object.values(generated.OutputFormat)
const ERROR_CODES: readonly `${generated.ErrorCode}`[] = Object.values(generated.ErrorCode)

/** Room for everything in a response besides the encoded image. */
const RESPONSE_OVERHEAD = 64 * 1024

/**
 * The encoded image is bounded by the encoder's memory, which is bounded by `limitAllocatorMemory`. So
 * anything larger means the worker is misbehaving.
 */
export function maxResponseBytes(limitAllocatorMemory: number): number {
  return limitAllocatorMemory + RESPONSE_OVERHEAD
}

/**
 * Throws a `TypeError` for values that JSON can't represent, instead of letting `JSON.stringify`
 * turn them into `null` (which means unset) or drop them. `undefined` also means unset.
 */
export function encodeOptions(options: RequestOptions): string {
  return JSON.stringify(options, (key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`Expected a finite number for ${key} but received ${value}`)
    }
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError(`Expected a JSON value for ${key} but received a ${typeof value}`)
    }
    return value
  })
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

function format<T extends InputFormat>(index: number, allowed: readonly T[]): T {
  const name = FORMATS[index]
  if (name === undefined || !(allowed as readonly string[]).includes(name)) {
    throw new InvalidResponseError(`invalid format ${index}`)
  }
  return name as T
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
    case generated.KIND_TRANSFORM: {
      fixed(11)
      const channels = response[10]
      if (channels < 1 || channels > 4) {
        throw new InvalidResponseError(`invalid channel count ${channels}`)
      }
      const data = Buffer.from(response.buffer, response.byteOffset + 11, response.length - 11)
      const info: OutputInfo = {
        format: format(response[1], OUTPUT_FORMATS),
        width: view.getUint32(2, true),
        height: view.getUint32(6, true),
        channels,
        size: data.length,
      }
      return { kind: 'transform', data, info }
    }
    case generated.KIND_METADATA: {
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
        format: format(response[1], FORMATS),
        width: view.getUint32(2, true),
        height: view.getUint32(6, true),
        hasAlpha: boolean(response[10]),
        orientation,
        hasProfile: boolean(response[12]),
      }
    }
    case generated.KIND_ERROR: {
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
