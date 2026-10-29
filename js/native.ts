// The native backend: a pool of worker processes (`crates/worker`). On unix, workers are forked by
// a fork server (`crates/worker/src/fork_server.rs`), one per pool, which also kills and reaps them.
// Like the wasm backend, each worker handles one request at a time. Workers are untrusted: one that
// sends a malformed response, or output it wasn't asked for, is killed.

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import type { Socket } from 'node:net'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'

import { isMusl } from './musl.js'
import { EXIT_MEMORY_LIMIT, EXIT_OUT_OF_MEMORY, EXIT_SANDBOX_FAILED, EXIT_VERSION_MISMATCH } from './protocol.js'
import type { Backend, RunOptions, RunResult, WorkerError } from './protocol.js'

export interface NativeOptions {
  workerPath: string
  maxProcesses: number
  /** Over `MAX_TIMEOUT_MS` (like `Infinity`), idle workers never exit. */
  idleTimeoutMs: number
  /** Each worker's `RLIMIT_DATA` in bytes (Linux only), or 0 for none. */
  memoryLimit: number
  /** Fork workers from a fork server, instead of spawning each one (unix only). Default: `true`. */
  forkServer?: boolean
  /** Show the workers' stderr, instead of discarding it. Default: `false`. */
  inheritStderr?: boolean
}

/** The worker exits with `EXIT_VERSION_MISMATCH` unless this matches its own version. */
const VERSION = (require('../package.json') as { version: string }).version
/** How long the fork server may take to reply, and to reap a worker after killing it. */
const SERVER_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 2 ** 31 - 1
const U64_MAX = 2n ** 64n - 1n

/** The platform in the worker's file name, like `linux-x64-gnu`, in order of preference. */
function platforms(): string[] {
  const platform = `${process.platform}-${process.arch}`
  switch (process.platform) {
    case 'linux':
      // musl builds are static, so they also run with glibc.
      return isMusl() ? [`${platform}-musl`] : [`${platform}-gnu`, `${platform}-musl`]
    case 'win32':
      return [`${platform}-msvc`]
    default:
      return [platform]
  }
}

export interface WorkerBinary {
  path: string
  /** Built locally, instead of installed from the platform's package. */
  local: boolean
}

/**
 * The worker is in `target/debug` or `target/release` when built locally (whichever is newer), in
 * the package root when CI built it (`scripts/build-native.mjs`), or else in the platform's package.
 * Returns `undefined` if there isn't one for this platform.
 */
export function findWorker(): WorkerBinary | undefined {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const built = ['debug', 'release']
    .map((profile) => join(__dirname, '..', 'target', profile, `safe-image-optimization-worker${exe}`))
    .filter((path) => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (built.length > 0) {
    return { path: built[0], local: true }
  }
  for (const platform of platforms()) {
    const name = `safe-image-optimization-worker.${platform}${exe}`
    const local = join(__dirname, '..', name)
    if (existsSync(local)) {
      return { path: local, local: true }
    }
    let path
    try {
      path = join(dirname(require.resolve(`@next/safe-image-optimization-${platform}/package.json`)), name)
    } catch {
      continue
    }
    if (existsSync(path)) {
      return { path, local: false }
    }
  }
  return undefined
}

function failure(code: string, message: string): WorkerError {
  return { code, message }
}

function signalName(signal: number): string {
  const names = Object.keys(constants.signals) as NodeJS.Signals[]
  return names.find((name) => constants.signals[name] === signal) ?? String(signal)
}

/** For a worker (or fork server) that exited unexpectedly. */
function exitFailure(code: number | null, signal: string | null): WorkerError {
  switch (code) {
    case EXIT_OUT_OF_MEMORY:
      return failure('ERR_OUT_OF_MEMORY', 'out of memory')
    case EXIT_MEMORY_LIMIT:
      return failure('ERR_LIMIT_EXCEEDED', 'Limit exceeded: processing allocated more than limitAllocatorMemoryBytes')
    case EXIT_VERSION_MISMATCH:
      return failure('ERR_WORKER_SPAWN', "the worker binary doesn't match the package's version")
    case EXIT_SANDBOX_FAILED:
      return failure('ERR_WORKER_SPAWN', 'the worker failed to set up its sandbox')
    default:
      return failure('ERR_WORKER_CRASHED', `the worker crashed (${code === null ? `signal ${signal}` : `exit code ${code}`})`)
  }
}

function ignore() {}

interface Started {
  child: ChildProcess
  /** Resolves when it exits, with how to report that. */
  exited: Promise<WorkerError>
}

/**
 * Spawns the worker binary, and resolves once it starts. A worker gets pipes for stdin and stdout,
 * and the fork server gets an IPC channel instead (fd 3, see `node_ipc.rs`).
 */
function start(options: NativeOptions, forkServer: boolean): Promise<Started | WorkerError> {
  const memoryLimit = BigInt(options.memoryLimit) > U64_MAX ? U64_MAX : BigInt(options.memoryLimit)
  const args = [VERSION, String(process.pid), String(memoryLimit), ...(forkServer ? ['--fork-server'] : [])]
  const stderr = options.inheritStderr ? 'inherit' : 'ignore'
  let child: ChildProcess
  try {
    child = spawn(options.workerPath, args, {
      env: {},
      stdio: forkServer ? ['ignore', 'ignore', stderr, 'ipc'] : ['pipe', 'pipe', stderr],
      windowsHide: true,
    })
  } catch (error) {
    return Promise.resolve(failure('ERR_WORKER_SPAWN', `failed to spawn ${options.workerPath}: ${String(error)}`))
  }
  child.stdin?.on('error', ignore)
  child.stdout?.on('error', ignore)
  const exited = new Promise<WorkerError>((resolve) => {
    child.once('exit', (code, signal) => resolve(exitFailure(code, signal)))
  })
  return new Promise((resolve) => {
    child.once('spawn', () => resolve({ child, exited }))
    // Also emitted if killing it fails (but not if it already exited).
    child.on('error', (error) => {
      resolve(failure('ERR_WORKER_SPAWN', `failed to spawn ${options.workerPath}: ${error.message}`))
    })
  })
}

/** A worker process, spawned or forked. */
interface WorkerProcess {
  readonly input: Socket
  readonly output: Socket
  /** Resolves when it exits, with how to report that. */
  readonly exited: Promise<WorkerError>
  /** Safe to call at any time, even after it exits. */
  kill(): void
  /** Whether the worker keeps the process alive. */
  ref(ref: boolean): void
}

class SpawnedWorker implements WorkerProcess {
  readonly input: Socket
  readonly output: Socket
  readonly exited: Promise<WorkerError>
  #child: ChildProcess

  constructor({ child, exited }: Started) {
    this.#child = child
    // Child processes' stdio pipes are sockets.
    this.input = child.stdin as Socket
    this.output = child.stdout as Socket
    this.exited = exited
  }

  kill() {
    // Node doesn't signal a process it has reaped, so this can't hit a reused pid.
    this.#child.kill('SIGKILL')
  }

  ref(ref: boolean) {
    for (const handle of [this.#child, this.input, this.output]) {
      if (ref) {
        handle.ref()
      } else {
        handle.unref()
      }
    }
  }
}

class ForkedWorker implements WorkerProcess {
  readonly exited: Promise<WorkerError>
  #server: ForkServer
  #id: number
  #socket: Socket

  constructor(server: ForkServer, id: number, socket: Socket, exited: Promise<WorkerError>) {
    this.#server = server
    this.#id = id
    this.#socket = socket
    this.exited = exited
  }

  get input() {
    return this.#socket
  }

  get output() {
    return this.#socket
  }

  kill() {
    this.#server.kill(this.#id)
  }

  ref(ref: boolean) {
    if (ref) {
      this.#socket.ref()
    } else {
      this.#socket.unref()
    }
  }
}

// The fork server's messages, over Node's IPC channel (which isn't supported with a process that
// isn't Node, but hasn't changed significantly since Node 0.8 in 2012, and Bun and Deno use the
// same protocol, see `crates/worker/src/node_ipc.rs`). Keep in sync with
// `crates/worker/src/fork_server.rs`. The server is trusted, so replies aren't validated.
type Message = { type: 'spawn'; id: number } | { type: 'kill'; id: number }
type Reply =
  /** Sent with the worker's socket. */
  | { type: 'spawned'; id: number; pid: number }
  | { type: 'spawnFailed'; id: number; error: string }
  | { type: 'exited'; id: number; code: number | null; signal: number | null }
type Spawn = { socket: Socket } | { error: string }

interface Forked {
  resolve: (exit: WorkerError) => void
  /** Set once it's been killed, in case the server doesn't reap it. */
  timer?: NodeJS.Timeout
}

type ForkResult = { worker: ForkedWorker } | { failure: WorkerError; serverExited: boolean }

/**
 * A worker started with `--fork-server`, which forks workers. It never keeps the process alive by
 * itself, and it exits when the process does (when the IPC channel closes).
 */
class ForkServer {
  #child: ChildProcess
  #nextId = 0
  /** Waiting for `spawned` or `spawnFailed`. */
  #spawns = new Map<number, (spawn: Spawn | undefined) => void>()
  /** Forked, and not yet reaped. */
  #workers = new Map<number, Forked>()
  #exited = false
  /** Why it was killed, if it stopped responding. */
  #abandoned: string | undefined
  /** Why it's gone, once it exits. */
  #failure: WorkerError = failure('ERR_WORKER_SPAWN', 'the fork server exited')

  static async start(options: NativeOptions): Promise<ForkServer | WorkerError> {
    const started = await start(options, true)
    return 'code' in started ? started : new ForkServer(started)
  }

  private constructor({ child, exited }: Started) {
    this.#child = child
    // Bun has no `channel.unref()`, but there, `child.unref()` covers the channel too.
    child.unref()
    child.channel?.unref?.()
    child.on('message', (reply: Reply, socket?: Socket) => this.#onReply(reply, socket))
    child.on('disconnect', () => this.#abandon())
    void exited.then((exit) => this.#onExit(exit))
  }

  get exited() {
    return this.#exited
  }

  async fork(): Promise<ForkResult> {
    if (this.#exited) {
      return { failure: this.#failure, serverExited: true }
    }
    const id = this.#nextId++
    const exited = new Promise<WorkerError>((resolve) => this.#workers.set(id, { resolve }))
    const spawn = await new Promise<Spawn | undefined>((resolve) => {
      const timer = setTimeout(() => this.#abandon(`the fork server didn't reply in ${SERVER_TIMEOUT_MS}ms`), SERVER_TIMEOUT_MS)
      this.#spawns.set(id, (spawn) => {
        clearTimeout(timer)
        this.#spawns.delete(id)
        resolve(spawn)
      })
      this.#send({ type: 'spawn', id })
    })
    if (spawn === undefined || 'error' in spawn) {
      this.#workers.delete(id)
      if (spawn === undefined) {
        return { failure: this.#failure, serverExited: true }
      }
      return { failure: failure('ERR_WORKER_SPAWN', `the fork server ${spawn.error}`), serverExited: false }
    }
    spawn.socket.unref()
    spawn.socket.on('error', ignore)
    return { worker: new ForkedWorker(this, id, spawn.socket, exited) }
  }

  /** Does nothing if the worker already exited. */
  kill(id: number) {
    const worker = this.#workers.get(id)
    if (worker === undefined || worker.timer !== undefined) {
      return
    }
    this.#send({ type: 'kill', id })
    // If the server doesn't reap it, the server is stuck, so kill the server too. On Linux, that
    // also kills its workers (`PR_SET_PDEATHSIG`).
    worker.timer = setTimeout(() => this.#abandon(`the fork server didn't reap a worker in ${SERVER_TIMEOUT_MS}ms`), SERVER_TIMEOUT_MS)
  }

  #send(message: Message) {
    if (this.#exited) {
      return
    }
    // Errors (if the channel closed) are handled by `'disconnect'`.
    this.#child.send(message, ignore)
  }

  #onReply(reply: Reply, socket: Socket | undefined) {
    if (reply.type === 'exited') {
      const worker = this.#workers.get(reply.id)
      this.#workers.delete(reply.id)
      clearTimeout(worker?.timer)
      worker?.resolve(exitFailure(reply.code, reply.signal === null ? null : signalName(reply.signal)))
      return
    }
    const resolve = this.#spawns.get(reply.id)
    if (reply.type === 'spawnFailed') {
      resolve?.({ error: reply.error })
    } else if (socket === undefined) {
      this.#abandon("the fork server didn't send a worker's socket")
    } else if (resolve === undefined) {
      // It already timed out.
      socket.destroy()
    } else {
      resolve({ socket })
    }
  }

  /** Kills the server. Once it exits, the pool starts another. */
  #abandon(reason?: string) {
    this.#abandoned ??= reason
    this.#child.kill('SIGKILL')
  }

  #onExit(exit: WorkerError) {
    this.#exited = true
    this.#failure = this.#abandoned === undefined ? exit : failure('ERR_WORKER_SPAWN', this.#abandoned)
    for (const resolve of this.#spawns.values()) {
      resolve(undefined)
    }
    const gone = failure('ERR_WORKER_CRASHED', this.#abandoned ?? 'the fork server exited')
    for (const worker of this.#workers.values()) {
      clearTimeout(worker.timer)
      worker.resolve(gone)
    }
    this.#workers.clear()
  }
}

interface Job {
  /** `[u64 LE length][request]`. */
  frame: Buffer
  timeoutMs?: number
  maxResponseBytes: number
  resolve: (result: RunResult) => void
}

interface Slot {
  process: WorkerProcess
  job?: Job
  timer?: NodeJS.Timeout
  /** The response's length prefix. */
  header: Buffer
  response?: Buffer
  /** Bytes received of `header`, or once it's complete, of `response`. */
  received: number
}

export class NativeBackend implements Backend {
  readonly name = 'native'
  #options: NativeOptions
  #forkServer: Promise<ForkServer | WorkerError> | undefined
  #slots = new Set<Slot>()
  /** Workers being spawned, each for a job. */
  #starting = 0
  #idle: Slot[] = []
  #queue: Job[] = []

  constructor(options: NativeOptions) {
    this.#options = options
  }

  run(input: Uint8Array, options: string, runOptions: RunOptions): Promise<RunResult> {
    // Copied now, so that the caller may reuse `input` immediately, and can't change it while it's
    // being written.
    const json = Buffer.from(options)
    const length = input.length + json.length + 4
    const frame = Buffer.allocUnsafe(8 + length)
    frame.writeBigUInt64LE(BigInt(length))
    frame.set(input, 8)
    json.copy(frame, 8 + input.length)
    frame.writeUInt32LE(json.length, 8 + input.length + json.length)
    return new Promise((resolve) => {
      const { timeoutMs, maxResponseBytes } = runOptions
      this.#queue.push({ frame, timeoutMs, maxResponseBytes, resolve })
      this.#dispatch()
    })
  }

  #dispatch() {
    while (this.#queue.length > 0) {
      const slot = this.#idle.pop()
      if (slot !== undefined) {
        this.#assign(slot, this.#queue.shift()!)
      } else if (this.#slots.size + this.#starting < this.#options.maxProcesses) {
        void this.#start(this.#queue.shift()!)
      } else {
        return
      }
    }
  }

  async #start(job: Job) {
    this.#starting++
    const worker = await this.#spawn()
    this.#starting--
    if ('code' in worker) {
      job.resolve({ error: worker })
      this.#dispatch()
      return
    }
    this.#assign(this.#add(worker), job)
  }

  async #spawn(): Promise<WorkerProcess | WorkerError> {
    if ((this.#options.forkServer ?? true) && process.platform !== 'win32') {
      return this.#fork()
    }
    const started = await start(this.#options, false)
    return 'code' in started ? started : new SpawnedWorker(started)
  }

  async #fork(): Promise<WorkerProcess | WorkerError> {
    // Retries once, in case the server exited since the last fork.
    for (let attempt = 0; ; attempt++) {
      const fresh = this.#forkServer === undefined
      const pending = (this.#forkServer ??= ForkServer.start(this.#options))
      const server = await pending
      const result: ForkResult = server instanceof ForkServer ? await server.fork() : { failure: server, serverExited: true }
      if ('worker' in result) {
        return result.worker
      }
      if (result.serverExited && this.#forkServer === pending) {
        this.#forkServer = undefined
      }
      if (!result.serverExited || fresh || attempt > 0) {
        return result.failure
      }
    }
  }

  #add(worker: WorkerProcess): Slot {
    const slot: Slot = { process: worker, header: Buffer.alloc(8), received: 0 }
    this.#slots.add(slot)
    const closed = () => void this.#closed(slot)
    worker.output.on('data', (chunk: Buffer) => this.#onData(slot, chunk))
    worker.output.on('end', closed)
    worker.output.on('close', closed)
    worker.output.on('error', closed)
    worker.input.on('error', closed)
    return slot
  }

  #assign(slot: Slot, job: Job) {
    slot.job = job
    slot.response = undefined
    slot.received = 0
    clearTimeout(slot.timer)
    slot.process.ref(true)
    // `setTimeout` treats longer delays as 1ms. They're over 24 days, so they never arrive.
    if (job.timeoutMs !== undefined && job.timeoutMs <= MAX_TIMEOUT_MS) {
      slot.timer = setTimeout(() => {
        this.#discard(slot)
        job.resolve({ error: failure('ERR_TIMEOUT', `processing took longer than ${job.timeoutMs}ms`) })
      }, job.timeoutMs)
    }
    slot.process.input.write(job.frame)
  }

  #onData(slot: Slot, chunk: Buffer) {
    const { job } = slot
    if (job === undefined) {
      this.#discard(slot)
      return
    }
    let offset = 0
    if (slot.response === undefined) {
      offset = chunk.copy(slot.header, slot.received)
      slot.received += offset
      if (slot.received < slot.header.length) {
        return
      }
      const length = slot.header.readBigUInt64LE()
      if (length > BigInt(job.maxResponseBytes)) {
        this.#invalid(slot, `${length} bytes exceeds the limit of ${job.maxResponseBytes} bytes`)
        return
      }
      try {
        slot.response = Buffer.allocUnsafe(Number(length))
      } catch (error) {
        this.#invalid(slot, String(error))
        return
      }
      slot.received = 0
    }
    const copied = chunk.copy(slot.response, slot.received, offset)
    slot.received += copied
    if (offset + copied < chunk.length) {
      this.#invalid(slot, 'unexpected data after the response')
    } else if (slot.received === slot.response.length) {
      const response = slot.response
      clearTimeout(slot.timer)
      slot.job = undefined
      slot.response = undefined
      job.resolve({ response })
      this.#release(slot)
    }
  }

  #invalid(slot: Slot, message: string) {
    const { job } = slot
    this.#discard(slot)
    job?.resolve({ error: failure('ERR_WORKER_CRASHED', `the worker sent an invalid response: ${message}`) })
  }

  /** The worker's output ended, or its pipes failed. */
  async #closed(slot: Slot) {
    const { job } = slot
    if (this.#discard(slot) && job !== undefined) {
      job.resolve({ error: await slot.process.exited })
    }
  }

  #release(slot: Slot) {
    const job = this.#queue.shift()
    if (job !== undefined) {
      this.#assign(slot, job)
      return
    }
    this.#idle.push(slot)
    // Idle workers don't keep the process alive.
    slot.process.ref(false)
    if (this.#options.idleTimeoutMs <= MAX_TIMEOUT_MS) {
      slot.timer = setTimeout(() => this.#discard(slot), this.#options.idleTimeoutMs)
      slot.timer.unref()
    }
  }

  /** Kills the worker. Returns `false` if it was already discarded. */
  #discard(slot: Slot): boolean {
    if (!this.#slots.delete(slot)) {
      return false
    }
    clearTimeout(slot.timer)
    slot.job = undefined
    const index = this.#idle.indexOf(slot)
    if (index !== -1) {
      this.#idle.splice(index, 1)
    }
    slot.process.kill()
    slot.process.input.destroy()
    slot.process.output.destroy()
    // Replace the worker if there's queued work.
    this.#dispatch()
    return true
  }
}
