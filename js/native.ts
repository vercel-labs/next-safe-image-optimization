// The native backend: the native binding (`crates/shim`) manages a pool of worker processes.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { WorkerPool } from '../binding.js'
import type { Backend, RunOptions, RunResult } from './protocol.js'

type Binding = typeof import('../binding.js')

export interface NativeOptions {
  maxProcesses: number
  idleTimeoutMs: number
  workerPath?: string
}

/** Throws if there's no native binding for this platform. */
export function loadBinding(): Binding {
  return require('../binding.js') as Binding
}

/**
 * The worker is next to the native binding: in the package root (when built locally), or in the
 * platform-specific package.
 */
function findWorker(binding: Binding): string {
  const target = binding.target()
  const name = `blunt-image-optimization-worker.${target}${process.platform === 'win32' ? '.exe' : ''}`
  const local = join(__dirname, '..', name)
  if (existsSync(local)) {
    return local
  }
  try {
    return join(dirname(require.resolve(`blunt-image-optimization-${target}/package.json`)), name)
  } catch {
    // Spawning fails with a clear error.
    return local
  }
}

export class NativeBackend implements Backend {
  readonly name = 'native'
  #pool: WorkerPool

  constructor(binding: Binding, options: NativeOptions) {
    this.#pool = new binding.WorkerPool({
      workerPath: options.workerPath ?? findWorker(binding),
      maxProcesses: options.maxProcesses,
      idleTimeoutMs: options.idleTimeoutMs,
    })
  }

  run(input: Uint8Array, options: string, runOptions: RunOptions): Promise<RunResult> {
    return this.#pool.run(input, options, runOptions)
  }
}
