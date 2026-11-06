// The wasm backend: a pool of worker threads, each running an instance of the wasm module
// (`crates/wasm`), managed by `WorkerPool` (like the native backend). A worker is discarded after
// a timeout, a crash (a trap or `proc_exit`), or a malformed response, since its memory may be in
// an inconsistent state.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { EXIT_MEMORY_LIMIT, EXIT_OUT_OF_MEMORY, failure } from './protocol.js'
import type { WorkerError } from './protocol.js'
import type { WasmRequest, WasmWorkerData, WasmWorkerMessage } from './wasm-worker.js'
import { WorkerPool } from './worker-pool.js'
import type { Job, PoolWorker, WorkerEvents, WorkerPoolOptions } from './worker-pool.js'

export interface WasmOptions extends WorkerPoolOptions {
  wasmPath: string
  /** The maximum size of each instance's memory, or 0 for no limit (the most wasm32 can address). */
  memoryLimit: number
}

/** 64 KiB. */
const PAGE_SIZE = 64 * 1024
/** 32 MiB. Must match `--initial-memory` in `.cargo/config.toml`. */
const INITIAL_PAGES = 512
/** The most that wasm32 can address. */
const MAX_MEMORY_BYTES = 4 * 1024 * 1024 * 1024

/** The package with the wasm module, which isn't in the main package, like sharp's `@img/sharp-wasm32`. */
export const WASM_PACKAGE = '@next/safe-image-optimization-wasm32'
const WASM_FILE = 'safe-image-optimization.wasm'

/**
 * A path to the wasm module to use instead of `WASM_PACKAGE`'s, like a local build
 * (`target/wasm32-wasip1/debug/nsio_wasm.wasm`), relative to the current directory. It's used even
 * if it doesn't exist, so that a mistake fails instead of using the package.
 */
export const WASM_PATH_VARIABLE = 'NEXT_SAFE_IMAGE_OPTIMIZATION_WASM_PATH'

/**
 * The wasm module is in `WASM_PACKAGE`, unless `WASM_PATH_VARIABLE` is set. Returns `undefined` if
 * it isn't installed.
 */
export function findWasm(): string | undefined {
  const override = process.env[WASM_PATH_VARIABLE]
  if (override) {
    return resolve(override)
  }
  let path
  try {
    path = join(dirname(require.resolve(`${WASM_PACKAGE}/package.json`)), WASM_FILE)
  } catch {
    return undefined
  }
  return existsSync(path) ? path : undefined
}

/** A worker thread, running an instance of the module (`wasm-worker.ts`). */
class WasmWorker implements PoolWorker {
  #worker: Worker

  constructor(worker: Worker, events: WorkerEvents) {
    this.#worker = worker
    this.#worker.on('message', (message: WasmWorkerMessage) => {
      if (message.decoded) {
        events.decoded()
      } else if (message.response !== undefined) {
        events.response(message.response)
      } else if (message.exit === EXIT_OUT_OF_MEMORY) {
        events.failed(failure('ERR_OUT_OF_MEMORY', 'out of memory'))
      } else if (message.exit === EXIT_MEMORY_LIMIT) {
        events.failed(
          failure(
            'ERR_LIMIT_EXCEEDED',
            'Limit exceeded: processing allocated more than limitAllocatorMemoryBytes',
          ),
        )
      } else {
        const reason = message.exit === undefined ? message.crash : `exit code ${message.exit}`
        events.failed(failure('ERR_WORKER_CRASHED', `the wasm worker crashed (${reason})`))
      }
    })
    // Also covers failing to instantiate the module.
    this.#worker.on('error', (error) => {
      events.failed(failure('ERR_WORKER_CRASHED', `the wasm worker crashed (${String(error)})`))
    })
    this.#worker.on('exit', (code) => {
      events.failed(failure('ERR_WORKER_CRASHED', `the wasm worker exited (${code})`))
    })
  }

  send({ frame, maxResponseBytes }: Job) {
    // Without the length prefix, which only the native worker needs.
    const message: WasmRequest = { request: frame.subarray(8), maxResponseBytes }
    this.#worker.postMessage(message, [frame.buffer as ArrayBuffer])
  }

  kill() {
    return this.#worker.terminate()
  }

  ref(ref: boolean) {
    if (ref) {
      this.#worker.ref()
    } else {
      this.#worker.unref()
    }
  }
}

export class WasmBackend extends WorkerPool<WasmWorker> {
  readonly name = 'wasm'
  #options: WasmOptions
  /** Compiled once, unless it fails. */
  #module: Promise<WebAssembly.Module> | undefined

  constructor(options: WasmOptions) {
    super(options)
    this.#options = options
  }

  protected async startWorker(events: WorkerEvents): Promise<WasmWorker | WorkerError> {
    const pending = (this.#module ??= readFile(this.#options.wasmPath).then(WebAssembly.compile))
    let module
    try {
      module = await pending
    } catch (error) {
      // The next worker tries again.
      if (this.#module === pending) {
        this.#module = undefined
      }
      return failure('ERR_WORKER_SPAWN', `failed to load the wasm module: ${String(error)}`)
    }
    const memoryLimit = Math.min(this.#options.memoryLimit || MAX_MEMORY_BYTES, MAX_MEMORY_BYTES)
    const maximumPages = Math.max(INITIAL_PAGES, Math.floor(memoryLimit / PAGE_SIZE))
    const workerData: WasmWorkerData = { module, initialPages: INITIAL_PAGES, maximumPages }
    const worker = new Worker(join(__dirname, 'wasm-worker.js'), { workerData })
    return new WasmWorker(worker, events)
  }
}
