// The pool shared by the native and wasm backends: a queue of requests, and workers that each
// handle one request at a time. Each backend only starts workers (`WorkerPool.startWorker()`), and
// carries their requests and messages. Workers are untrusted: the pool validates everything they
// send, and kills one that sends a malformed response, or anything it wasn't asked for. A worker
// is also killed after a timeout, an abort, or `maxImagesPerWorker` responses.

import { POOL_CLOSED, decodeResponse, encodeRequest, failure, invalidResponse } from './protocol.js'
import type { Backend, RequestKind, RunOptions, RunResult, WorkerError } from './protocol.js'

export interface WorkerPoolOptions {
  maxWorkers: number
  /** With 0, or over `MAX_TIMEOUT_MS`, idle workers never exit. */
  idleTimeoutMs: number
  /** Responses before a worker is killed, or 0 for no limit. */
  maxImagesPerWorker: number
}

/** A request, as the backend's workers see it. */
export interface Job {
  /** From `encodeRequest()`. */
  readonly frame: Buffer
  readonly kind: RequestKind
  /** A larger response is treated as a crash. */
  readonly maxResponseBytes: number
}

/** A worker, from `WorkerPool.startWorker()`. */
export interface PoolWorker {
  /** Sends a request. A worker only gets another once it has responded. */
  send(job: Job): void
  /** Safe to call at any time, even after it exits. Resolves once it has exited. */
  kill(): Promise<unknown>
  /** Whether the worker keeps the process alive. */
  ref(ref: boolean): void
}

/** How a worker reports to the pool. Calls after the pool killed it are ignored. */
export interface WorkerEvents {
  /** The worker decoded a transform's input, before responding. */
  decoded(): void
  /** Without the native worker's length prefix. The pool validates it. */
  response(response: Uint8Array): void
  /** The worker exited, crashed, or misbehaved. The pool kills it, and fails its request. */
  failed(error: WorkerError | Promise<WorkerError>): void
}

interface PendingJob extends Job {
  readonly timeoutMs?: number
  readonly decodeTimeoutMs?: number
  /** Only the first call does anything. */
  resolve(result: RunResult): void
  /** Resolved. If it was aborted or destroyed while its worker was starting, it's still starting. */
  done: boolean
}

interface Slot<W> {
  worker: W
  job?: PendingJob
  /** The job's timeout, or the idle timeout. */
  timer?: NodeJS.Timeout
  /** Until the worker has decoded the job's input. */
  decodeTimer?: NodeJS.Timeout
  /** The job's input is decoded. */
  decoded: boolean
  responses: number
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1

function ignore() {}

export abstract class WorkerPool<W extends PoolWorker> implements Backend {
  abstract readonly name: 'native' | 'wasm'
  #options: WorkerPoolOptions
  #slots = new Set<Slot<W>>()
  /** Jobs whose workers are being started. */
  #starting = new Set<PendingJob>()
  #idle: Slot<W>[] = []
  #queue: PendingJob[] = []
  /** Workers that were killed, until they exit. */
  #exiting = new Set<Promise<unknown>>()
  /** Set by `close()`. */
  #closing: Promise<void> | undefined
  /** Resolves `#closing`, once the last job finishes. */
  #onClosed: (() => void) | undefined

  constructor(options: WorkerPoolOptions) {
    this.#options = options
  }

  /** Starts a worker, which reports to `events`. */
  protected abstract startWorker(events: WorkerEvents): Promise<W | WorkerError>

  /** While closing, once every worker has exited. */
  protected async workersExited(): Promise<void> {}

  run(
    input: Uint8Array,
    options: string,
    { kind, timeoutMs, decodeTimeoutMs, maxResponseBytes, signal }: RunOptions,
  ): Promise<RunResult> {
    if (this.#closing !== undefined) {
      return Promise.resolve({ error: POOL_CLOSED })
    }
    const frame = encodeRequest(input, options)
    return new Promise((resolve) => {
      const onAbort = () => this.#abort(job)
      const job: PendingJob = {
        frame,
        kind,
        timeoutMs,
        decodeTimeoutMs,
        maxResponseBytes,
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
      // oxlint-disable-next-line unicorn/no-useless-spread -- `#discard` splices `#idle`
      for (const slot of [...this.#idle]) {
        this.#discard(slot)
      }
      this.#dispatch()
    })
    return this.#closing
  }

  destroy(): Promise<void> {
    const jobs = [...this.#queue.splice(0), ...this.#starting]
    for (const slot of this.#slots) {
      if (slot.job !== undefined) {
        jobs.push(slot.job)
      }
    }
    for (const job of jobs) {
      job.resolve({ error: POOL_CLOSED })
    }
    const closed = this.close()
    // oxlint-disable-next-line unicorn/no-useless-spread -- `#discard` can add to `#slots`
    for (const slot of [...this.#slots]) {
      this.#discard(slot)
    }
    return closed
  }

  #abort(job: PendingJob) {
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
    while (this.#queue.length > 0) {
      const slot = this.#idle.pop()
      if (slot !== undefined) {
        this.#assign(slot, this.#queue.shift()!)
      } else if (this.#slots.size + this.#starting.size < this.#options.maxWorkers) {
        void this.#start(this.#queue.shift()!)
      } else {
        return
      }
    }
    // Closing discards idle workers, so once there are none left, every job has finished.
    if (this.#onClosed !== undefined && this.#slots.size === 0 && this.#starting.size === 0) {
      const onClosed = this.#onClosed
      this.#onClosed = undefined
      void this.#shutDown().then(onClosed)
    }
  }

  /** Once every job has finished. */
  async #shutDown() {
    // Idle workers don't keep the process alive, but whoever awaits `close()` should see it
    // resolve.
    const keepAlive = setTimeout(ignore, MAX_TIMEOUT_MS)
    try {
      await Promise.all(this.#exiting)
      await this.workersExited()
    } finally {
      clearTimeout(keepAlive)
    }
  }

  async #start(job: PendingJob) {
    this.#starting.add(job)
    let slot: Slot<W> | undefined
    // Events can't arrive before the worker is returned, but they're ignored until it's added.
    const on =
      <A extends unknown[]>(handler: (started: Slot<W>, ...args: A) => void) =>
      (...args: A) => {
        if (slot !== undefined && this.#slots.has(slot)) {
          handler(slot, ...args)
        }
      }
    const worker = await this.startWorker({
      decoded: on((started) => this.#onDecoded(started)),
      response: on((started, response: Uint8Array) => this.#onResponse(started, response)),
      failed: on((started, error: WorkerError | Promise<WorkerError>) =>
        this.#onFailed(started, error),
      ),
    })
    this.#starting.delete(job)
    if ('code' in worker) {
      job.resolve({ error: worker })
      this.#dispatch()
      return
    }
    slot = { worker, decoded: false, responses: 0 }
    this.#slots.add(slot)
    if (job.done) {
      // It was aborted or destroyed while the worker started.
      this.#next(slot)
    } else {
      this.#assign(slot, job)
    }
  }

  #assign(slot: Slot<W>, job: PendingJob) {
    slot.job = job
    slot.decoded = false
    clearTimeout(slot.timer)
    slot.worker.ref(true)
    // If they're equal, the overall timeout fires first, since it was set first.
    slot.timer = this.#timeout(slot, job.timeoutMs, 'processing')
    slot.decodeTimer = this.#timeout(slot, job.decodeTimeoutMs, 'decoding')
    slot.worker.send(job)
  }

  #timeout(slot: Slot<W>, ms: number | undefined, what: string): NodeJS.Timeout | undefined {
    // `setTimeout` treats longer delays as 1ms. They're over 24 days, so they never arrive.
    if (ms === undefined || ms > MAX_TIMEOUT_MS) {
      return undefined
    }
    return setTimeout(() => {
      const { job } = slot
      this.#discard(slot)
      job?.resolve({ error: failure('ERR_TIMEOUT', `${what} took longer than ${ms}ms`) })
    }, ms)
  }

  #onDecoded(slot: Slot<W>) {
    if (slot.job?.kind !== 'transform' || slot.decoded) {
      this.#invalid(slot, 'unexpected decoded event')
      return
    }
    slot.decoded = true
    clearTimeout(slot.decodeTimer)
  }

  #onResponse(slot: Slot<W>, bytes: Uint8Array) {
    const { job } = slot
    if (job === undefined) {
      this.#invalid(slot, 'unexpected response')
      return
    }
    let response
    try {
      response = decodeResponse(bytes, job.kind)
    } catch (error) {
      this.#invalid(slot, (error as Error).message)
      return
    }
    if (response.kind === 'transform' && !slot.decoded) {
      this.#invalid(slot, 'a transform response before the decoded event')
      return
    }
    clearTimeout(slot.timer)
    clearTimeout(slot.decodeTimer)
    slot.job = undefined
    job.resolve({ response })
    this.#release(slot)
  }

  #onFailed(slot: Slot<W>, error: WorkerError | Promise<WorkerError>) {
    const { job } = slot
    this.#discard(slot)
    if (job !== undefined) {
      void Promise.resolve(error).then((error) => job.resolve({ error }))
    }
  }

  #invalid(slot: Slot<W>, reason: string) {
    const { job } = slot
    this.#discard(slot)
    job?.resolve({ error: invalidResponse(reason) })
  }

  #release(slot: Slot<W>) {
    const { maxImagesPerWorker } = this.#options
    if (maxImagesPerWorker !== 0 && ++slot.responses >= maxImagesPerWorker) {
      this.#discard(slot)
      return
    }
    this.#next(slot)
  }

  /** Assigns the next job to the worker, or else keeps it idle (or kills it, while closing). */
  #next(slot: Slot<W>) {
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
    slot.worker.ref(false)
    const { idleTimeoutMs } = this.#options
    if (idleTimeoutMs !== 0 && idleTimeoutMs <= MAX_TIMEOUT_MS) {
      slot.timer = setTimeout(() => this.#discard(slot), idleTimeoutMs)
      slot.timer.unref()
    }
  }

  /** Kills the worker, unless it was already discarded. */
  #discard(slot: Slot<W>) {
    if (!this.#slots.delete(slot)) {
      return
    }
    clearTimeout(slot.timer)
    clearTimeout(slot.decodeTimer)
    slot.job = undefined
    const index = this.#idle.indexOf(slot)
    if (index !== -1) {
      this.#idle.splice(index, 1)
    }
    const exited = slot.worker.kill()
    this.#exiting.add(exited)
    void exited.then(() => this.#exiting.delete(exited))
    // Replace the worker if there's queued work.
    this.#dispatch()
  }
}
