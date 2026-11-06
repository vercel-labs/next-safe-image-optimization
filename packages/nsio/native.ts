// The native backend: a pool of worker processes (`crates/worker`), managed by `WorkerPool` (like the
// wasm backend). On unix, workers are forked by a fork server (`crates/worker/src/fork_server.rs`),
// one per pool, which also kills and reaps them.

import { type ChildProcess, spawn } from 'node:child_process'
import type { Socket } from 'node:net'
import { constants } from 'node:os'
import { resolve } from 'node:path'

import { isMusl } from './musl.js'
import {
  EXIT_MEMORY_LIMIT,
  EXIT_OUT_OF_MEMORY,
  EXIT_SANDBOX_FAILED,
  EXIT_VERSION_MISMATCH,
  VERSION,
  failure,
  invalidResponse,
} from './protocol.js'
import type { WorkerError } from './protocol.js'
import { WorkerPool } from './worker-pool.js'
import type { Job, PoolWorker, WorkerEvents, WorkerPoolOptions } from './worker-pool.js'

export interface NativeOptions extends WorkerPoolOptions {
  workerPath: string
  /** Each worker's `RLIMIT_DATA` in bytes (Linux only), or 0 for no limit. */
  memoryLimit: number
  /** Fork workers from a fork server, instead of spawning each one (unix only). Default: `true`. */
  forkServer?: boolean
  /** Show the workers' stderr, instead of discarding it. Default: `false`. */
  inheritStderr?: boolean
}

/**
 * Passed through to workers on Linux, which otherwise get an empty environment. With `1`, they run
 * without seccomp filters if installing them fails (like under QEMU's user mode emulation), instead
 * of failing with `ERR_WORKER_SPAWN`.
 */
const IGNORE_SECCOMP_FAILURES = 'NEXT_SAFE_IMAGE_OPTIMIZATION_DANGEROUSLY_IGNORE_SECCOMP_FAILURES'

/** How long the fork server may take to reply, and to reap a worker after killing it. */
const SERVER_TIMEOUT_MS = 10_000
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

/**
 * A path to the worker binary to use instead of the platform's package's, like a local build
 * (`target/debug/safe-image-optimization-worker`), relative to the current directory. It's used
 * even if it doesn't exist, so that a mistake fails instead of using the package.
 */
export const WORKER_PATH_VARIABLE = 'NEXT_SAFE_IMAGE_OPTIMIZATION_WORKER_PATH'

export interface WorkerBinary {
  path: string
  /** From `WORKER_PATH_VARIABLE`, instead of the platform's package. */
  local: boolean
}

/**
 * The worker is in the platform's package, unless `WORKER_PATH_VARIABLE` is set. Returns
 * `undefined` if there isn't one for this platform.
 */
export function findWorker(): WorkerBinary | undefined {
  const override = process.env[WORKER_PATH_VARIABLE]
  if (override) {
    return { path: resolve(override), local: true }
  }
  for (const platform of platforms()) {
    try {
      // Keep these requires literal so @vercel/nft and Turbopack can trace the optional packages.
      // Each package's entry point exposes its worker through a traceable filesystem reference;
      // resolving a dynamically constructed package name would omit it from standalone output.
      let path: string
      switch (platform) {
        case 'darwin-arm64':
          path = require('@next/safe-image-optimization-darwin-arm64')
          break
        case 'darwin-x64':
          path = require('@next/safe-image-optimization-darwin-x64')
          break
        case 'win32-x64-msvc':
          path = require('@next/safe-image-optimization-win32-x64-msvc')
          break
        case 'win32-arm64-msvc':
          path = require('@next/safe-image-optimization-win32-arm64-msvc')
          break
        case 'linux-x64-gnu':
          path = require('@next/safe-image-optimization-linux-x64-gnu')
          break
        case 'linux-arm64-gnu':
          path = require('@next/safe-image-optimization-linux-arm64-gnu')
          break
        case 'linux-x64-musl':
          path = require('@next/safe-image-optimization-linux-x64-musl')
          break
        case 'linux-arm64-musl':
          path = require('@next/safe-image-optimization-linux-arm64-musl')
          break
        case 'linux-riscv64-gnu':
          path = require('@next/safe-image-optimization-linux-riscv64-gnu')
          break
        default:
          continue
      }
      return { path, local: false }
    } catch {
      // Optional packages may be absent, or their worker missing. Try the next platform.
      continue
    }
  }
  return undefined
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
      return failure(
        'ERR_LIMIT_EXCEEDED',
        'Limit exceeded: processing allocated more than limitAllocatorMemoryBytes',
      )
    case EXIT_VERSION_MISMATCH:
      return failure('ERR_WORKER_SPAWN', "the worker binary doesn't match the package's version")
    case EXIT_SANDBOX_FAILED:
      return failure('ERR_WORKER_SPAWN', 'the worker failed to set up its sandbox')
    default:
      return failure(
        'ERR_WORKER_CRASHED',
        `the worker crashed (${code === null ? `signal ${signal}` : `exit code ${code}`})`,
      )
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
  const args = [
    VERSION,
    String(process.pid),
    String(memoryLimit),
    ...(forkServer ? ['--fork-server'] : []),
  ]
  const stderr = options.inheritStderr ? 'inherit' : 'ignore'
  let child: ChildProcess
  try {
    child = spawn(options.workerPath, args, {
      env:
        process.platform === 'linux' && process.env[IGNORE_SECCOMP_FAILURES] === '1'
          ? { [IGNORE_SECCOMP_FAILURES]: '1' }
          : {},
      stdio: forkServer ? ['ignore', 'ignore', stderr, 'ipc'] : ['pipe', 'pipe', stderr],
      windowsHide: true,
    })
  } catch (error) {
    return Promise.resolve(
      failure('ERR_WORKER_SPAWN', `failed to spawn ${options.workerPath}: ${String(error)}`),
    )
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
      resolve(
        failure('ERR_WORKER_SPAWN', `failed to spawn ${options.workerPath}: ${error.message}`),
      )
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
  #onExited: Promise<void>

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
    this.#onExited = exited.then((exit) => this.#onExit(exit))
  }

  get exited() {
    return this.#exited
  }

  /** Kills the server, once its workers have exited. Resolves once it has exited too. */
  close(): Promise<void> {
    this.#child.kill('SIGKILL')
    return this.#onExited
  }

  async fork(): Promise<ForkResult> {
    if (this.#exited) {
      return { failure: this.#failure, serverExited: true }
    }
    const id = this.#nextId++
    const exited = new Promise<WorkerError>((resolve) => this.#workers.set(id, { resolve }))
    const spawn = await new Promise<Spawn | undefined>((resolve) => {
      const timer = setTimeout(
        () => this.#abandon(`the fork server didn't reply in ${SERVER_TIMEOUT_MS}ms`),
        SERVER_TIMEOUT_MS,
      )
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
      return {
        failure: failure('ERR_WORKER_SPAWN', `the fork server ${spawn.error}`),
        serverExited: false,
      }
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
    worker.timer = setTimeout(
      () => this.#abandon(`the fork server didn't reap a worker in ${SERVER_TIMEOUT_MS}ms`),
      SERVER_TIMEOUT_MS,
    )
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
      worker?.resolve(
        exitFailure(reply.code, reply.signal === null ? null : signalName(reply.signal)),
      )
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
    this.#failure =
      this.#abandoned === undefined ? exit : failure('ERR_WORKER_SPAWN', this.#abandoned)
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

/**
 * Reads a worker process's stdout: `[u64 LE length][response]` frames (see
 * `crates/core/src/protocol.rs`), and empty ones for `decoded`.
 */
class NativeWorker implements PoolWorker {
  #process: WorkerProcess
  #events: WorkerEvents
  /** The current request's limit, until it has a response. */
  #maxResponseBytes: number | undefined
  /** The next frame's length prefix. */
  #header = Buffer.alloc(8)
  #response: Buffer | undefined
  /** Bytes received of `#header`, or once it's complete, of `#response`. */
  #received = 0

  constructor(process: WorkerProcess, events: WorkerEvents) {
    this.#process = process
    this.#events = events
    const closed = () => events.failed(process.exited)
    process.output.on('data', (chunk: Buffer) => this.#onData(chunk))
    process.output.on('end', closed)
    process.output.on('close', closed)
    process.output.on('error', closed)
    process.input.on('error', closed)
  }

  send(job: Job) {
    this.#maxResponseBytes = job.maxResponseBytes
    this.#process.input.write(job.frame)
  }

  kill() {
    this.#process.kill()
    this.#process.input.destroy()
    this.#process.output.destroy()
    return this.#process.exited
  }

  ref(ref: boolean) {
    this.#process.ref(ref)
  }

  #onData(chunk: Buffer) {
    let offset = 0
    while (offset < chunk.length) {
      const max = this.#maxResponseBytes
      if (max === undefined) {
        this.#invalid('unexpected data')
        return
      }
      if (this.#response === undefined) {
        const copied = chunk.copy(this.#header, this.#received, offset)
        offset += copied
        this.#received += copied
        if (this.#received < this.#header.length) {
          return
        }
        this.#received = 0
        const length = this.#header.readBigUInt64LE()
        if (length === 0n) {
          this.#events.decoded()
          continue
        }
        if (length > BigInt(max)) {
          this.#invalid(`${length} bytes exceeds the limit of ${max} bytes`)
          return
        }
        try {
          this.#response = Buffer.allocUnsafe(Number(length))
        } catch (error) {
          this.#invalid(String(error))
          return
        }
      }
      const copied = chunk.copy(this.#response, this.#received, offset)
      offset += copied
      this.#received += copied
      if (this.#received === this.#response.length) {
        const response = this.#response
        this.#response = undefined
        this.#received = 0
        this.#maxResponseBytes = undefined
        // Before the pool sees the response, and sends the next request.
        if (offset < chunk.length) {
          this.#invalid('unexpected data after the response')
          return
        }
        this.#events.response(response)
      }
    }
  }

  #invalid(reason: string) {
    this.#events.failed(invalidResponse(reason))
  }
}

export class NativeBackend extends WorkerPool<NativeWorker> {
  readonly name = 'native'
  #options: NativeOptions
  #forkServer: Promise<ForkServer | WorkerError> | undefined

  constructor(options: NativeOptions) {
    super(options)
    this.#options = options
  }

  protected async startWorker(events: WorkerEvents): Promise<NativeWorker | WorkerError> {
    const process = await this.#spawn()
    return 'code' in process ? process : new NativeWorker(process, events)
  }

  protected async workersExited() {
    const server = await this.#forkServer
    if (server instanceof ForkServer) {
      await server.close()
    }
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
      const result: ForkResult =
        server instanceof ForkServer ? await server.fork() : { failure: server, serverExited: true }
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
}
