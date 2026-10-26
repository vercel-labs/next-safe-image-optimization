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
export {
  EXIT_MEMORY_LIMIT,
  EXIT_OUT_OF_MEMORY,
  EXIT_SANDBOX_FAILED,
  EXIT_VERSION_MISMATCH,
} from './protocol.generated.js'

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

const FORMATS: readonly InputFormat[] = Object.values(generated.InputFormat)
const OUTPUT_FORMATS: readonly OutputFormat[] = Object.values(generated.OutputFormat)
const ERROR_CODES: readonly `${generated.ErrorCode}`[] = Object.values(generated.ErrorCode)

/**
 * The JSON's length, the JSON, and the encoded image. The worker rejects larger images itself, so
 * anything larger means it's misbehaving.
 */
export function maxResponseBytes(limitOutputBytes: number): number {
  return 4 + generated.MAX_JSON_BYTES + limitOutputBytes
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
  | ({ kind: 'metadata' } & generated.MetadataResponse)
  | ({ kind: 'error' } & generated.ErrorResponse)

// Checks for the untrusted JSON. They never include the worker's values in their messages.

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidResponseError(`${name} is not an object`)
  }
  return value as Record<string, unknown>
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidResponseError(`invalid ${name}`)
  }
  return value
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new InvalidResponseError(`invalid ${name}`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    throw new InvalidResponseError(`invalid ${name}`)
  }
  return value as T
}

const U32_MAX = 0xffffffff

/**
 * Splits the response into its JSON (a `generated.Response`) and data. Throws an
 * `InvalidResponseError` if it's malformed.
 */
export function decodeResponse(response: Uint8Array): Response {
  if (response.length < 4) {
    throw new InvalidResponseError(`truncated response (${response.length} bytes)`)
  }
  const jsonLength = new DataView(response.buffer, response.byteOffset, 4).getUint32(0, true)
  if (jsonLength > generated.MAX_JSON_BYTES) {
    throw new InvalidResponseError(`the JSON is ${jsonLength} bytes`)
  }
  const jsonEnd = 4 + jsonLength
  if (jsonEnd > response.length) {
    throw new InvalidResponseError(`truncated response (${response.length} bytes)`)
  }
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.subarray(4, jsonEnd)))
  } catch {
    throw new InvalidResponseError('invalid JSON')
  }
  const { type: kind, meta: untrusted } = object(json, 'the response')
  const meta = object(untrusted, 'meta')
  // Only transforms send data.
  if (kind !== 'transform' && jsonEnd !== response.length) {
    throw new InvalidResponseError('unexpected data after the JSON')
  }
  switch (kind) {
    case 'transform': {
      const data = Buffer.from(response.buffer, response.byteOffset + jsonEnd, response.length - jsonEnd)
      const info: OutputInfo = {
        format: oneOf(meta.format, 'format', OUTPUT_FORMATS),
        width: integer(meta.width, 'width', 0, U32_MAX),
        height: integer(meta.height, 'height', 0, U32_MAX),
        channels: integer(meta.channels, 'channels', 1, 4),
        size: data.length,
      }
      return { kind, data, info }
    }
    case 'metadata':
      return {
        kind,
        format: oneOf(meta.format, 'format', FORMATS),
        width: integer(meta.width, 'width', 0, U32_MAX),
        height: integer(meta.height, 'height', 0, U32_MAX),
        hasAlpha: boolean(meta.hasAlpha, 'hasAlpha'),
        orientation: integer(meta.orientation, 'orientation', 1, 8),
        hasProfile: boolean(meta.hasProfile, 'hasProfile'),
      }
    case 'error':
      if (typeof meta.message !== 'string') {
        throw new InvalidResponseError('invalid message')
      }
      return { kind, code: oneOf(meta.code, 'code', ERROR_CODES), message: meta.message }
    default:
      throw new InvalidResponseError('invalid response type')
  }
}
