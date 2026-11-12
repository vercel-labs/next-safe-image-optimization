// The wasm backend: a pool of worker threads, each running an instance of the wasm module
// (`crates/wasm`), managed by `WorkerPool` (like the native backend). A worker is discarded after
// a timeout, a crash (a trap or `proc_exit`), or a malformed response, since its memory may be in
// an inconsistent state.

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { EXIT_MEMORY_LIMIT, EXIT_OUT_OF_MEMORY, VERSION, failure } from './protocol.js'
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

/**
 * A path to the wasm module to use instead of `WASM_PACKAGE`'s, like a local build
 * (`target/wasm32-wasip1/debug/nsio_wasm.wasm`), relative to the current directory. It's used even
 * if it doesn't exist, so that a mistake fails instead of using the package.
 */
export const WASM_PATH_VARIABLE = 'NEXT_SAFE_IMAGE_OPTIMIZATION_WASM_PATH'

interface WasmPackage {
  manifest: () => { name: string; version: string }
  /** Only required if the manifest's version matches. */
  path: () => string
}

/**
 * The wasm module is in `WASM_PACKAGE` (or its copies), unless `WASM_PATH_VARIABLE` is set. A
 * package must have the main package's version: package managers don't enforce the optional peer's
 * pinned version. Returns `mismatched` (like `name@version`) if every installed package is from
 * another version, and `undefined` if none is installed.
 */
export function findWasm(): { path: string } | { mismatched: string } | undefined {
  const override = process.env[WASM_PATH_VARIABLE]
  if (override) {
    return { path: resolve(override) }
  }
  // Literal, like the requires in `findWorker`, so that tracers include the module. Each is
  // declared in the published package.json (scripts/pack-npm.mjs), so none rely on hoisting.
  const packages: WasmPackage[] = [
    // Optional dependencies with their own copies of the module, only installed on FreeBSD and
    // WebContainers. First, because they're exact-pinned, so the nearest copy is always the right
    // version.
    {
      manifest: () => require('@next/safe-image-optimization-freebsd-wasm/package.json'),
      path: () => require('@next/safe-image-optimization-freebsd-wasm'),
    },
    {
      manifest: () => require('@next/safe-image-optimization-webcontainers-wasm/package.json'),
      path: () => require('@next/safe-image-optimization-webcontainers-wasm'),
    },
    // An optional peer dependency, for when it's installed directly. Last, because if nothing
    // provides the peer, Node finds whatever copy it can, like one hoisted from another version.
    {
      manifest: () => require('@next/safe-image-optimization-wasm32/package.json'),
      path: () => require('@next/safe-image-optimization-wasm32'),
    },
  ]
  let mismatched
  for (const wasmPackage of packages) {
    let manifest
    try {
      manifest = wasmPackage.manifest()
    } catch {
      // Not installed.
      continue
    }
    if (manifest.version !== VERSION) {
      mismatched ??= `${manifest.name}@${manifest.version}`
      continue
    }
    try {
      return { path: wasmPackage.path() }
    } catch {
      // Its module is missing.
    }
  }
  return mismatched === undefined ? undefined : { mismatched }
}

/** A worker thread, running an instance of the module (`wasm-worker.ts`). */
class WasmWorker implements PoolWorker {
  #worker: Worker

  constructor(worker: Worker, events: WorkerEvents) {
    this.#worker = worker
    this.#worker.on('message', (message: WasmWorkerMessage) => {
      if (message.type === 'decoded') {
        events.decoded()
      } else if (message.type === 'response') {
        events.response(message.response)
      } else if (message.type === 'exit' && message.code === EXIT_OUT_OF_MEMORY) {
        events.failed(failure('ERR_OUT_OF_MEMORY', 'out of memory'))
      } else if (message.type === 'exit' && message.code === EXIT_MEMORY_LIMIT) {
        events.failed(
          failure(
            'ERR_LIMIT_EXCEEDED',
            'Limit exceeded: processing allocated more than limitAllocatorMemoryBytes',
          ),
        )
      } else {
        const reason = message.type === 'exit' ? `exit code ${message.code}` : message.reason
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
