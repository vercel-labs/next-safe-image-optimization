// The native backend: a pool of worker processes (`crates/worker`). On unix, workers are forked by
// a fork server (`crates/worker/src/fork_server.rs`), one per pool, which also kills and reaps them.
// Like the wasm backend, each worker handles one request at a time. Workers are untrusted: one that
// sends a malformed response, or output it wasn't asked for, is killed.

import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { constants, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getSystemErrorName } from 'node:util'

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
/** How long the fork server may take to reply, and a forked worker to connect. */
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
 * The worker is in the package root when built locally, or else in the platform's package. Returns
 * `undefined` if there isn't one for this platform.
 */
export function findWorker(): WorkerBinary | undefined {
  const exe = process.platform === 'win32' ? '.exe' : ''
  for (const platform of platforms()) {
    const name = `blunt-image-optimization-worker.${platform}${exe}`
    const local = join(__dirname, '..', name)
    if (existsSync(local)) {
      return { path: local, local: true }
    }
    let path
    try {
      path = join(dirname(require.resolve(`blunt-image-optimization-${platform}/package.json`)), name)
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
  stdin: Socket
  stdout: Socket
  /** Resolves when it exits, with how to report that. */
  exited: Promise<WorkerError>
}

/** Spawns the worker binary, and resolves once it starts. */
function start(options: NativeOptions, args: readonly string[]): Promise<Started | WorkerError> {
  const memoryLimit = BigInt(options.memoryLimit) > U64_MAX ? U64_MAX : BigInt(options.memoryLimit)
  let child: ChildProcess
  try {
    child = spawn(options.workerPath, [VERSION, String(process.pid), String(memoryLimit), ...args], {
      env: {},
      stdio: ['pipe', 'pipe', options.inheritStderr ? 'inherit' : 'ignore'],
      windowsHide: true,
    })
  } catch (error) {
    return Promise.resolve(failure('ERR_WORKER_SPAWN', `failed to spawn ${options.workerPath}: ${String(error)}`))
  }
  // Child processes' stdio pipes are sockets.
  const stdin = child.stdin as Socket
  const stdout = child.stdout as Socket
  stdin.on('error', ignore)
  stdout.on('error', ignore)
  const exited = new Promise<WorkerError>((resolve) => {
    child.once('exit', (code, signal) => resolve(exitFailure(code, signal)))
  })
  return new Promise((resolve) => {
    child.once('spawn', () => resolve({ child, stdin, stdout, exited }))
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

  constructor({ child, stdin, stdout, exited }: Started) {
    this.#child = child
    this.input = stdin
    this.output = stdout
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

const TOKEN_BYTES = 16

/**
 * Forked workers connect to this, and identify themselves with a random token, which is only used
 * once. On Linux, it's in the abstract namespace, so there's no file to clean up. Elsewhere, it's
 * in a private temporary directory, which is removed when the process exits. One for all pools.
 */
class Listener {
  static #instance: Promise<Listener | WorkerError> | undefined

  /** The name (on Linux) or path that the fork server connects to. */
  readonly address: string
  #pending = new Map<string, (socket: Socket | undefined) => void>()

  /** Retries next time if it fails. */
  static get(): Promise<Listener | WorkerError> {
    if (Listener.#instance === undefined) {
      const instance = Listener.#listen()
      Listener.#instance = instance
      void instance.then((listener) => {
        if (!(listener instanceof Listener) && Listener.#instance === instance) {
          Listener.#instance = undefined
        }
      })
    }
    return Listener.#instance
  }

  static #listen(): Promise<Listener | WorkerError> {
    let address
    let path
    if (process.platform === 'linux') {
      address = `blunt-image-optimization-${process.pid}-${randomBytes(8).toString('hex')}`
      path = `\0${address}`
    } else {
      let dir: string
      try {
        dir = mkdtempSync(join(tmpdir(), 'blunt-'))
      } catch (error) {
        return Promise.resolve(failure('ERR_WORKER_SPAWN', `failed to create a socket directory: ${String(error)}`))
      }
      process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
      address = path = join(dir, 'socket')
    }
    const server = createServer()
    const listener = new Listener(server, address)
    return new Promise((resolve) => {
      server.once('error', (error) => {
        resolve(failure('ERR_WORKER_SPAWN', `failed to listen on a Unix socket: ${error.message}`))
      })
      server.listen(path, () => {
        server.unref()
        // Accepting can fail (like with `EMFILE`), which only fails that worker.
        server.on('error', ignore)
        resolve(listener)
      })
    })
  }

  private constructor(server: Server, address: string) {
    this.address = address
    server.on('connection', (socket) => this.#identify(socket))
  }

  /** Waits for the worker with `token` to connect. Resolves with `undefined` after a timeout. */
  expect(token: Buffer): { connected: Promise<Socket | undefined>; cancel: () => void } {
    const key = token.toString('hex')
    let done!: (socket: Socket | undefined) => void
    const connected = new Promise<Socket | undefined>((resolve) => {
      const timer = setTimeout(() => done(undefined), SERVER_TIMEOUT_MS)
      done = (socket) => {
        clearTimeout(timer)
        this.#pending.delete(key)
        resolve(socket)
      }
    })
    this.#pending.set(key, done)
    return { connected, cancel: () => done(undefined) }
  }

  #identify(socket: Socket) {
    socket.unref()
    socket.on('error', ignore)
    socket.setTimeout(SERVER_TIMEOUT_MS, () => socket.destroy())
    const chunks: Buffer[] = []
    let length = 0
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      length += chunk.length
      if (length < TOKEN_BYTES) {
        return
      }
      socket.off('data', onData)
      socket.pause()
      socket.setTimeout(0)
      const data = Buffer.concat(chunks)
      const done = this.#pending.get(data.toString('hex', 0, TOKEN_BYTES))
      if (done === undefined) {
        socket.destroy()
        return
      }
      if (data.length > TOKEN_BYTES) {
        socket.unshift(data.subarray(TOKEN_BYTES))
      }
      done(socket)
    }
    socket.on('data', onData)
  }
}

// The fork server's protocol. Keep in sync with `crates/worker/src/fork_server.rs`.
const SPAWN = 0
const KILL = 1
const MESSAGE_BYTES = 1 + 8 + TOKEN_BYTES
const SPAWNED = 0
const EXITED = 1
const REPLY_BYTES = 1 + 8 + 4

interface Forked {
  resolve: (exit: WorkerError) => void
  /** Set once it's been killed, in case the server doesn't reap it. */
  timer?: NodeJS.Timeout
}

type ForkResult = { worker: ForkedWorker } | { failure: WorkerError; serverExited: boolean }

/**
 * A worker started with `--fork-server`, which forks workers. It never keeps the process alive by
 * itself, and it exits when the process does (when its stdin closes).
 */
class ForkServer {
  #started: Started
  #listener: Listener
  #nextId = 0
  /** Waiting for `SPAWNED`, which resolves with the pid or negated errno. */
  #spawns = new Map<number, (value: number | undefined) => void>()
  /** Forked, and not yet reaped. */
  #workers = new Map<number, Forked>()
  #replies = Buffer.alloc(0)
  #exited = false
  /** Why it was killed, if it stopped responding. */
  #abandoned: string | undefined
  /** Why it's gone, once it exits. */
  #failure: WorkerError = failure('ERR_WORKER_SPAWN', 'the fork server exited')

  static async start(options: NativeOptions): Promise<ForkServer | WorkerError> {
    const listener = await Listener.get()
    if (!(listener instanceof Listener)) {
      return listener
    }
    const started = await start(options, ['--fork-server', listener.address])
    return 'code' in started ? started : new ForkServer(started, listener)
  }

  private constructor(started: Started, listener: Listener) {
    this.#started = started
    this.#listener = listener
    const { child, stdin, stdout, exited } = started
    child.unref()
    stdin.unref()
    stdout.unref()
    stdout.on('data', (chunk: Buffer) => this.#onReplies(chunk))
    stdout.on('end', () => this.#abandon())
    stdout.on('error', () => this.#abandon())
    stdin.on('error', () => this.#abandon())
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
    const token = randomBytes(TOKEN_BYTES)
    const { connected, cancel } = this.#listener.expect(token)
    const exited = new Promise<WorkerError>((resolve) => this.#workers.set(id, { resolve }))
    const pid = await new Promise<number | undefined>((resolve) => {
      const timer = setTimeout(() => this.#abandon(`the fork server didn't reply in ${SERVER_TIMEOUT_MS}ms`), SERVER_TIMEOUT_MS)
      this.#spawns.set(id, (value) => {
        clearTimeout(timer)
        this.#spawns.delete(id)
        resolve(value)
      })
      this.#send(SPAWN, id, token)
    })
    if (pid === undefined || pid <= 0) {
      cancel()
      this.#workers.delete(id)
      if (pid === undefined) {
        return { failure: this.#failure, serverExited: true }
      }
      const error = pid === 0 ? 'unknown error' : getSystemErrorName(pid)
      return { failure: failure('ERR_WORKER_SPAWN', `failed to fork a worker: ${error}`), serverExited: false }
    }
    const socket = await connected
    if (socket === undefined) {
      this.kill(id)
      return { failure: failure('ERR_WORKER_SPAWN', "the forked worker didn't connect"), serverExited: false }
    }
    return { worker: new ForkedWorker(this, id, socket, exited) }
  }

  /** Does nothing if the worker already exited. */
  kill(id: number) {
    const worker = this.#workers.get(id)
    if (worker === undefined || worker.timer !== undefined) {
      return
    }
    this.#send(KILL, id)
    // If the server doesn't reap it, the server is stuck, so kill the server too. On Linux, that
    // also kills its workers (`PR_SET_PDEATHSIG`).
    worker.timer = setTimeout(() => this.#abandon(`the fork server didn't reap a worker in ${SERVER_TIMEOUT_MS}ms`), SERVER_TIMEOUT_MS)
  }

  #send(op: number, id: number, token?: Buffer) {
    if (this.#exited) {
      return
    }
    const message = Buffer.alloc(MESSAGE_BYTES)
    message[0] = op
    message.writeBigUInt64LE(BigInt(id), 1)
    token?.copy(message, 9)
    this.#started.stdin.write(message)
  }

  #onReplies(chunk: Buffer) {
    this.#replies = Buffer.concat([this.#replies, chunk])
    let offset = 0
    for (; offset + REPLY_BYTES <= this.#replies.length; offset += REPLY_BYTES) {
      const kind = this.#replies[offset]
      const id = Number(this.#replies.readBigUInt64LE(offset + 1))
      const value = this.#replies.readInt32LE(offset + 9)
      if (kind === SPAWNED) {
        this.#spawns.get(id)?.(value)
      } else if (kind === EXITED) {
        const worker = this.#workers.get(id)
        this.#workers.delete(id)
        clearTimeout(worker?.timer)
        worker?.resolve(value >= 0 ? exitFailure(value, null) : exitFailure(null, signalName(-value)))
      } else {
        this.#abandon('the fork server sent an invalid reply')
        return
      }
    }
    this.#replies = this.#replies.subarray(offset)
  }

  /** Kills the server. Once it exits, the pool starts another. */
  #abandon(reason?: string) {
    this.#abandoned ??= reason
    this.#started.child.kill('SIGKILL')
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
    const started = await start(this.#options, [])
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
    // Forked workers' sockets are paused after reading their token.
    worker.output.resume()
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
