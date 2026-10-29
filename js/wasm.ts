// The wasm backend: a pool of worker threads, each running an instance of the wasm module
// (`crates/wasm`). Like the native backend, each worker handles one request at a time, and is
// discarded after a timeout or a crash (a trap or `proc_exit`), since its memory may be in an
// inconsistent state.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { EXIT_MEMORY_LIMIT, EXIT_OUT_OF_MEMORY } from './protocol.js'
import type { Backend, RunOptions, RunResult } from './protocol.js'
import type { WasmRequest, WasmWorkerData, WasmWorkerMessage } from './wasm-worker.js'

export interface WasmOptions {
  wasmPath: string
  maxWorkers: number
  /** Over `MAX_TIMEOUT_MS` (like `Infinity`), idle workers never exit. */
  idleTimeoutMs: number
  /** The maximum size of each instance's memory, or 0 for the most possible. */
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
  resolve: (result: RunResult) => void
}

interface Slot {
  worker: Worker
  job?: Job
  timer?: NodeJS.Timeout
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
      const { timeoutMs, maxResponseBytes } = runOptions
      this.#queue.push({ request: { request, maxResponseBytes }, timeoutMs, resolve })
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
      this.#module = await WebAssembly.compile(await readFile(this.#options.wasmPath))
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
    const memoryLimit = Math.min(this.#options.memoryLimit || MAX_MEMORY_BYTES, MAX_MEMORY_BYTES)
    const maximumPages = Math.max(INITIAL_PAGES, Math.floor(memoryLimit / PAGE_SIZE))
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
    const job = this.#queue.shift()
    if (job !== undefined) {
      this.#assign(slot, job)
      return
    }
    this.#idle.push(slot)
    // Idle workers don't keep the process alive.
    slot.worker.unref()
    if (this.#options.idleTimeoutMs <= MAX_TIMEOUT_MS) {
      slot.timer = setTimeout(() => this.#discard(slot), this.#options.idleTimeoutMs)
      slot.timer.unref()
    }
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
