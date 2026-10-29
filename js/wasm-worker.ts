// Runs the wasm module (`crates/wasm`) in a worker thread, so that the pool can terminate it on a
// timeout. The module can only reach the imports below: there's no filesystem, network, or
// environment access, and no way to call into JS.

import { parentPort, workerData } from 'node:worker_threads'

export interface WasmWorkerData {
  module: WebAssembly.Module
  initialPages: number
  maximumPages: number
}

/** A message from the pool. */
export interface WasmRequest {
  request: Uint8Array
  /** A larger response is treated as a crash. */
  maxResponseBytes: number
}

/** A message to the pool. Exactly one field is set. */
export interface WasmWorkerMessage {
  /** Without the length prefix. */
  response?: Uint8Array
  /** The module called `proc_exit`. */
  exit?: number
  /** The module trapped (e.g. panicked), or returned an invalid response. */
  crash?: string
}

interface Exports {
  _initialize?(): void
  nsio_alloc(len: number): number
  nsio_handle(ptr: number, len: number): number
  nsio_free_response(): void
}

const ERRNO_SUCCESS = 0
const ERRNO_BADF = 8

class ProcExit {
  constructor(readonly code: number) {}
}

const { module: wasmModule, initialPages, maximumPages } = workerData as WasmWorkerData
const memory = new WebAssembly.Memory({ initial: initialPages, maximum: maximumPages })
// The buffer is replaced when memory grows, so never cache it.
const view = () => new DataView(memory.buffer)

const wasi = {
  // rav1d logs errors to stderr. Drop them, like the native worker's release builds.
  fd_write(fd: number, iovs: number, iovsLen: number, written: number): number {
    if (fd !== 1 && fd !== 2) {
      return ERRNO_BADF
    }
    let total = 0
    for (let i = 0; i < iovsLen; i++) {
      total += view().getUint32(iovs + i * 8 + 4, true)
    }
    view().setUint32(written, total, true)
    return ERRNO_SUCCESS
  },
  // Linked in by mozjpeg's use of stdio (`fprintf(stderr, ...)`), but there are no files to close
  // or seek.
  fd_close(): number {
    return ERRNO_BADF
  },
  fd_seek(): number {
    return ERRNO_BADF
  },
  // Linked in by usvg's default `<image href>` resolver (`std::fs`), which we replace. There are no
  // preopened directories, so wasi-libc can't resolve any path, and there are no files to read.
  fd_prestat_get(): number {
    return ERRNO_BADF
  },
  fd_prestat_dir_name(): number {
    return ERRNO_BADF
  },
  path_open(): number {
    return ERRNO_BADF
  },
  path_filestat_get(): number {
    return ERRNO_BADF
  },
  fd_fdstat_get(): number {
    return ERRNO_BADF
  },
  fd_filestat_get(): number {
    return ERRNO_BADF
  },
  fd_read(): number {
    return ERRNO_BADF
  },
  proc_exit(code: number): never {
    throw new ProcExit(code)
  },
  random_get(ptr: number, len: number): number {
    // `getRandomValues` fills at most 64 KiB at a time.
    for (let offset = 0; offset < len; offset += 65536) {
      crypto.getRandomValues(new Uint8Array(memory.buffer, ptr + offset, Math.min(65536, len - offset)))
    }
    return ERRNO_SUCCESS
  },
  clock_time_get(id: number, _precision: bigint, time: number): number {
    const now = id === 0 ? BigInt(Date.now()) * 1_000_000n : process.hrtime.bigint()
    view().setBigUint64(time, now, true)
    return ERRNO_SUCCESS
  },
  environ_get(): number {
    return ERRNO_SUCCESS
  },
  environ_sizes_get(count: number, size: number): number {
    view().setUint32(count, 0, true)
    view().setUint32(size, 0, true)
    return ERRNO_SUCCESS
  },
  sched_yield(): number {
    return ERRNO_SUCCESS
  },
}

const instance = new WebAssembly.Instance(wasmModule, { env: { memory }, wasi_snapshot_preview1: wasi })
const wasm = instance.exports as unknown as Exports
// The module is a WASI reactor, so this runs its constructors. Rust before 1.100 doesn't link
// wasi-libc's reactor startup code, and has the linker call constructors from each export instead.
wasm._initialize?.()

function handle({ request, maxResponseBytes }: WasmRequest): Uint8Array {
  const ptr = wasm.nsio_alloc(request.length)
  new Uint8Array(memory.buffer, ptr, request.length).set(request)
  const parts = wasm.nsio_handle(ptr, request.length)
  const [headPtr, headLen, dataPtr, dataLen] = new Uint32Array(memory.buffer, parts, 4)
  if (headLen < 8) {
    throw new Error('invalid response')
  }
  if (headLen - 8 + dataLen > maxResponseBytes) {
    throw new Error(`the response is ${headLen - 8 + dataLen} bytes, which exceeds the limit of ${maxResponseBytes} bytes`)
  }
  // These throw if the module returned out-of-bounds pointers. The head starts with a length
  // prefix, which only the native worker needs.
  const head = new Uint8Array(memory.buffer, headPtr, headLen).subarray(8)
  const data = new Uint8Array(memory.buffer, dataPtr, dataLen)
  const response = new Uint8Array(head.length + data.length)
  response.set(head)
  response.set(data, head.length)
  wasm.nsio_free_response()
  return response
}

parentPort!.on('message', (request: WasmRequest) => {
  let message: WasmWorkerMessage
  let transfer: ArrayBuffer[] = []
  try {
    const response = handle(request)
    message = { response }
    transfer = [response.buffer as ArrayBuffer]
  } catch (error) {
    message = error instanceof ProcExit ? { exit: error.code } : { crash: String(error) }
  }
  parentPort!.postMessage(message, transfer)
})
