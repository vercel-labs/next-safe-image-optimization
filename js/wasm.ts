// The wasm backend: a pool of worker threads, each running an instance of the wasm module
// (`crates/wasm`). Like the native backend, each worker handles one request at a time, and is
// discarded after a timeout or a crash (a trap or `proc_exit`), since its memory may be in an
// inconsistent state.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { EXIT_OUT_OF_MEMORY } from './protocol.js'
import type { Backend, RunOptions, RunResult } from './protocol.js'
import type { WasmWorkerData, WasmWorkerMessage } from './wasm-worker.js'

export interface WasmOptions {
  maxWorkers: number
  idleTimeoutMs: number
  /** The maximum size of each instance's memory. */
  maxMemoryBytes: number
}

/** 64 KiB. */
const PAGE_SIZE = 64 * 1024
/** 32 MiB. Must match `--initial-memory` in `.cargo/config.toml`. */
const INITIAL_PAGES = 512
/** The most that wasm32 can address. */
export const MAX_MEMORY_BYTES = 4 * 1024 * 1024 * 1024

interface Job {
  request: Uint8Array
  timeoutMs?: number
  resolve: (result: RunResult) => void
}

interface Slot {
  worker: Worker
  job?: Job
  timer?: NodeJS.Timeout
}

const WASM_PATH = join(__dirname, '..', 'blunt-image-optimization.wasm')

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

  constructor(options: WasmOptions) {
    this.#options = options
  }

  run(input: Uint8Array, options: string, runOptions: RunOptions): Promise<RunResult> {
    // Copied now, so that the caller may reuse `input` immediately.
    const json = Buffer.from(options)
    const request = new Uint8Array(input.length + json.length + 4)
    request.set(input)
    request.set(json, input.length)
    new DataView(request.buffer).setUint32(input.length + json.length, json.length, true)
    return new Promise((resolve) => {
      this.#queue.push({ request, timeoutMs: runOptions.timeoutMs, resolve })
      this.#dispatch()
    })
  }

  #dispatch() {
    if (this.#module === undefined) {
      this.#loading ??= this.#load()
      return
    }
    while (this.#queue.length > 0) {
      let slot = this.#idle.pop()
      if (slot === undefined) {
        if (this.#slots.size >= this.#options.maxWorkers) {
          return
        }
        slot = this.#spawn(this.#module)
      }
      this.#assign(slot, this.#queue.shift()!)
    }
  }

  async #load() {
    try {
      this.#module = await WebAssembly.compile(await readFile(WASM_PATH))
    } catch (error) {
      this.#loading = undefined
      for (const job of this.#queue.splice(0)) {
        job.resolve(failure('ERR_WORKER_SPAWN', `failed to load the wasm module: ${String(error)}`))
      }
      return
    }
    this.#dispatch()
  }

  #spawn(module: WebAssembly.Module): Slot {
    const maximumPages = Math.max(INITIAL_PAGES, Math.floor(this.#options.maxMemoryBytes / PAGE_SIZE))
    const workerData: WasmWorkerData = { module, initialPages: INITIAL_PAGES, maximumPages }
    const slot: Slot = { worker: new Worker(join(__dirname, 'wasm-worker.js'), { workerData }) }
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
    if (job.timeoutMs !== undefined) {
      slot.timer = setTimeout(() => {
        slot.job = undefined
        job.resolve(failure('ERR_TIMEOUT', `processing took longer than ${job.timeoutMs}ms`))
        this.#discard(slot)
      }, job.timeoutMs)
    }
    slot.worker.postMessage(job.request, [job.request.buffer as ArrayBuffer])
  }

  #release(slot: Slot) {
    const job = this.#queue.shift()
    if (job !== undefined) {
      this.#assign(slot, job)
      return
    }
    this.#idle.push(slot)
    // Idle workers don't keep the process alive.
    slot.worker.unref()
    slot.timer = setTimeout(() => this.#discard(slot), this.#options.idleTimeoutMs)
    slot.timer.unref()
  }

  #discard(slot: Slot) {
    if (!this.#slots.delete(slot)) {
      return
    }
    clearTimeout(slot.timer)
    const index = this.#idle.indexOf(slot)
    if (index !== -1) {
      this.#idle.splice(index, 1)
    }
    void slot.worker.terminate()
    // Replace the worker if there's queued work.
    this.#dispatch()
  }
}
