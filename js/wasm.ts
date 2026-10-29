// The wasm backend: a pool of worker threads, each running an instance of the wasm module
// (`crates/wasm`). Like the native backend, each worker handles one request at a time, and is
// discarded after a timeout or a crash (a trap or `proc_exit`), since its memory may be in an
// inconsistent state.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { EXIT_MEMORY_LIMIT, EXIT_OUT_OF_MEMORY, POOL_CLOSED } from './protocol.js'
import type { Backend, RunOptions, RunResult } from './protocol.js'
import type { WasmRequest, WasmWorkerData, WasmWorkerMessage } from './wasm-worker.js'

export interface WasmOptions {
  wasmPath: string
  maxWorkers: number
  /** With 0, or over `MAX_TIMEOUT_MS`, idle workers never exit. */
  idleTimeoutMs: number
  /** Responses before a worker is terminated, or 0 for no limit. */
  maxImagesPerWorker: number
  /** The maximum size of each instance's memory, or 0 for no limit (the most wasm32 can address). */
  memoryLimit: number
}

/** 64 KiB. */
const PAGE_SIZE = 64 * 1024
/** 32 MiB. Must match `--initial-memory` in `.cargo/config.toml`. */
const INITIAL_PAGES = 512
/** The most that wasm32 can address. */
const MAX_MEMORY_BYTES = 4 * 1024 * 1024 * 1024
const MAX_TIMEOUT_MS = 2 ** 31 - 1

interface Job {
  request: WasmRequest
  timeoutMs?: number
  /** Only the first call does anything. */
  resolve: (result: RunResult) => void
  done: boolean
}

interface Slot {
  worker: Worker
  job?: Job
  timer?: NodeJS.Timeout
  responses: number
}

/** The package with the wasm module, which isn't in the main package, like sharp's `@img/sharp-wasm32`. */
export const WASM_PACKAGE = '@next/safe-image-optimization-wasm32'
const WASM_FILE = 'safe-image-optimization.wasm'

/**
 * The wasm module is in the package root when built locally or by CI (`scripts/build-wasm.mjs`),
 * or else in `WASM_PACKAGE`. Returns `undefined` if neither has it.
 */
export function findWasm(): string | undefined {
  const local = join(__dirname, '..', WASM_FILE)
  if (existsSync(local)) {
    return local
  }
  let path
  try {
    path = join(dirname(require.resolve(`${WASM_PACKAGE}/package.json`)), WASM_FILE)
  } catch {
    return undefined
  }
  return existsSync(path) ? path : undefined
}

function failure(code: string, message: string): RunResult {
  return { error: { code, message } }
}

export class WasmBackend implements Backend {
  readonly name = 'wasm'
  #options: WasmOptions
  #module: WebAssembly.Module | undefined
  #loading: Promise<void> | undefined
  #slots = new Set<Slot>()
  #idle: Slot[] = []
  #queue: Job[] = []
  /** Workers that were terminated, until they exit. */
  #exiting = new Set<Promise<number>>()
  /** Set by `close()`. */
  #closing: Promise<void> | undefined
  /** Resolves `#closing`, once the last job finishes. */
  #onClosed: (() => void) | undefined

  constructor(options: WasmOptions) {
    this.#options = options
  }

  run(input: Uint8Array, options: string, { timeoutMs, maxResponseBytes, signal }: RunOptions): Promise<RunResult> {
    if (this.#closing !== undefined) {
      return Promise.resolve({ error: POOL_CLOSED })
    }
    // Copied now, so that the caller may reuse `input` immediately.
    const json = Buffer.from(options)
    const request = new Uint8Array(input.length + json.length + 4)
    request.set(input)
    request.set(json, input.length)
    new DataView(request.buffer).setUint32(input.length + json.length, json.length, true)
    return new Promise((resolve) => {
      const onAbort = () => this.#abort(job)
      const job: Job = {
        request: { request, maxResponseBytes },
        timeoutMs,
        done: false,
        resolve: (result) => {
          if (!job.done) {
            job.done = true
            signal?.removeEventListener('abort', onAbort)
            resolve(result)
          }
        },
      }
      if (signal?.aborted) {
        job.resolve({ aborted: true })
        return
      }
      signal?.addEventListener('abort', onAbort)
      this.#queue.push(job)
      this.#dispatch()
    })
  }

  close(): Promise<void> {
    this.#closing ??= new Promise((resolve) => {
      this.#onClosed = resolve
      for (const slot of [...this.#idle]) {
        this.#discard(slot)
      }
      this.#dispatch()
    })
    return this.#closing
  }

  destroy(): Promise<void> {
    const jobs = this.#queue.splice(0)
    for (const slot of this.#slots) {
      if (slot.job !== undefined) {
        jobs.push(slot.job)
      }
    }
    for (const job of jobs) {
      job.resolve({ error: POOL_CLOSED })
    }
    const closed = this.close()
    for (const slot of [...this.#slots]) {
      this.#discard(slot)
    }
    return closed
  }

  #abort(job: Job) {
    job.resolve({ aborted: true })
    const index = this.#queue.indexOf(job)
    if (index !== -1) {
      this.#queue.splice(index, 1)
      // In case it was the last job before closing.
      this.#dispatch()
    }
    for (const slot of this.#slots) {
      if (slot.job === job) {
        this.#discard(slot)
      }
    }
  }

  #dispatch() {
    if (this.#module === undefined && this.#queue.length > 0) {
      this.#loading ??= this.#load()
      return
    }
    while (this.#queue.length > 0) {
      let slot = this.#idle.pop()
      if (slot === undefined) {
        if (this.#slots.size >= this.#options.maxWorkers) {
          return
        }
        slot = this.#spawn(this.#module!)
      }
      this.#assign(slot, this.#queue.shift()!)
    }
    // Closing discards idle workers, so once there are none left, every job has finished.
    if (this.#onClosed !== undefined && this.#slots.size === 0) {
      const onClosed = this.#onClosed
      this.#onClosed = undefined
      // Idle workers don't keep the process alive, but whoever awaits `close()` should see it
      // resolve.
      const keepAlive = setTimeout(() => {}, MAX_TIMEOUT_MS)
      void Promise.all(this.#exiting).then(() => {
        clearTimeout(keepAlive)
        onClosed()
      })
    }
  }

  async #load() {
    try {
      this.#module = await WebAssembly.compile(await readFile(this.#options.wasmPath))
    } catch (error) {
      this.#loading = undefined
      for (const job of this.#queue.splice(0)) {
        job.resolve(failure('ERR_WORKER_SPAWN', `failed to load the wasm module: ${String(error)}`))
      }
    }
    this.#dispatch()
  }

  #spawn(module: WebAssembly.Module): Slot {
    const memoryLimit = Math.min(this.#options.memoryLimit || MAX_MEMORY_BYTES, MAX_MEMORY_BYTES)
    const maximumPages = Math.max(INITIAL_PAGES, Math.floor(memoryLimit / PAGE_SIZE))
    const workerData: WasmWorkerData = { module, initialPages: INITIAL_PAGES, maximumPages }
    const slot: Slot = { worker: new Worker(join(__dirname, 'wasm-worker.js'), { workerData }), responses: 0 }
    this.#slots.add(slot)
    slot.worker.on('message', (message: WasmWorkerMessage) => {
      const job = slot.job
      if (job === undefined) {
        return
      }
      slot.job = undefined
      clearTimeout(slot.timer)
      if (message.response !== undefined) {
        job.resolve({ response: message.response })
        this.#release(slot)
      } else if (message.exit === EXIT_OUT_OF_MEMORY) {
        job.resolve(failure('ERR_OUT_OF_MEMORY', 'out of memory'))
        this.#discard(slot)
      } else if (message.exit === EXIT_MEMORY_LIMIT) {
        job.resolve(failure('ERR_LIMIT_EXCEEDED', 'Limit exceeded: processing allocated more than limitAllocatorMemoryBytes'))
        this.#discard(slot)
      } else {
        const reason = message.exit === undefined ? message.crash : `exit code ${message.exit}`
        job.resolve(failure('ERR_WORKER_CRASHED', `the wasm worker crashed (${reason})`))
        this.#discard(slot)
      }
    })
    // Also covers failing to instantiate the module.
    slot.worker.on('error', (error) => {
      slot.job?.resolve(failure('ERR_WORKER_CRASHED', `the wasm worker crashed (${String(error)})`))
      slot.job = undefined
      this.#discard(slot)
    })
    slot.worker.on('exit', (code) => {
      slot.job?.resolve(failure('ERR_WORKER_CRASHED', `the wasm worker exited (${code})`))
      slot.job = undefined
      this.#discard(slot)
    })
    return slot
  }

  #assign(slot: Slot, job: Job) {
    slot.job = job
    clearTimeout(slot.timer)
    slot.worker.ref()
    // `setTimeout` treats longer delays as 1ms. They're over 24 days, so they never arrive.
    if (job.timeoutMs !== undefined && job.timeoutMs <= MAX_TIMEOUT_MS) {
      slot.timer = setTimeout(() => {
        slot.job = undefined
        job.resolve(failure('ERR_TIMEOUT', `processing took longer than ${job.timeoutMs}ms`))
        this.#discard(slot)
      }, job.timeoutMs)
    }
    slot.worker.postMessage(job.request, [job.request.request.buffer as ArrayBuffer])
  }

  #release(slot: Slot) {
    const { maxImagesPerWorker, idleTimeoutMs } = this.#options
    if (maxImagesPerWorker !== 0 && ++slot.responses >= maxImagesPerWorker) {
      this.#discard(slot)
      return
    }
    const job = this.#queue.shift()
    if (job !== undefined) {
      this.#assign(slot, job)
      return
    }
    if (this.#closing !== undefined) {
      this.#discard(slot)
      return
    }
    this.#idle.push(slot)
    // Idle workers don't keep the process alive.
    slot.worker.unref()
    if (idleTimeoutMs !== 0 && idleTimeoutMs <= MAX_TIMEOUT_MS) {
      slot.timer = setTimeout(() => this.#discard(slot), idleTimeoutMs)
      slot.timer.unref()
    }
  }

  #discard(slot: Slot) {
    if (!this.#slots.delete(slot)) {
      return
    }
    clearTimeout(slot.timer)
    slot.job = undefined
    const index = this.#idle.indexOf(slot)
    if (index !== -1) {
      this.#idle.splice(index, 1)
    }
    const terminated = slot.worker.terminate()
    this.#exiting.add(terminated)
    void terminated.then(() => this.#exiting.delete(terminated))
    // Replace the worker if there's queued work.
    this.#dispatch()
  }
}
