import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { Pool, blunt, defaultPool } from '../dist/index.js'
import { assertRejectsWithCode, fromRaw, pattern } from './helpers.ts'

const backend = defaultPool().backend

/** `Pool.run` is internal, but lets tests use timeouts shorter than a second. */
interface InternalPool {
  run(input: Uint8Array, options: object, limitAllocatorMemory: number | undefined, timeoutMs?: number): Promise<unknown>
}

/** Noise compresses badly, so this takes a while to encode. */
function noise(width: number, height: number) {
  const raw = pattern(width, height)
  for (let i = 0; i < raw.data.length; i++) {
    raw.data[i] = (i * 2654435761) >>> 24
  }
  return raw
}

describe('pool', () => {
  test('options are validated', () => {
    assert.throws(() => new Pool({ concurrency: 0 }), TypeError)
    assert.throws(() => new Pool({ idleTimeout: -1 }), TypeError)
    assert.throws(() => new Pool({ backend: 'other' as never }), TypeError)
    assert.throws(() => blunt(Buffer.alloc(1), { pool: {} as never }), TypeError)
    for (const seconds of [-1, 1.5, NaN, undefined]) {
      assert.throws(() => blunt(Buffer.alloc(1)).timeout({ seconds } as never), TypeError)
    }
  })

  test('very long timeouts never expire', async () => {
    const input = await fromRaw(pattern(8, 8)).png().toBuffer()
    // More than 2 ** 31 - 1 ms, which `setTimeout` would treat as 1ms, and more than a `Duration`.
    for (const seconds of [3_000_000, Number.MAX_VALUE]) {
      const { info } = await blunt(input).timeout({ seconds }).toBuffer({ resolveWithObject: true })
      assert.equal(info.width, 8)
    }
  })

  test('requests queue for a free worker', async () => {
    const pool = new Pool({ concurrency: 1 })
    assert.equal(pool.backend, backend)
    const input = await fromRaw(pattern(64, 64)).png().toBuffer()
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => blunt(input, { pool }).resize(10 + i).toBuffer({ resolveWithObject: true })),
    )
    results.forEach(({ info }, i) => assert.equal(info.width, 10 + i))
  })

  test('timeouts kill the worker, and the pool replaces it', async () => {
    const pool = new Pool({ concurrency: 1 })
    const input = await fromRaw(noise(2000, 2000)).png({ compressionLevel: 0 }).toBuffer()
    const start = performance.now()
    await assertRejectsWithCode(
      (pool as unknown as InternalPool).run(input, { transform: { format: 'png' } }, undefined, 1),
      'ERR_TIMEOUT',
    )
    assert.ok(performance.now() - start < 2000)
    const { info } = await blunt(input, { pool }).timeout({ seconds: 60 }).resize(8).toBuffer({ resolveWithObject: true })
    assert.equal(info.width, 8)
  })

  test('idle workers keep neither themselves nor the process alive', () => {
    const script = `
      const { blunt, Pool } = require('./dist/index.js')
      // A 1x1 PNG.
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64')
      blunt(png, { pool: new Pool({ idleTimeout: 60000 }) }).toBuffer().then(() => console.log('done'))
    `
    const start = performance.now()
    const child = spawnSync(process.execPath, ['-e', script], { cwd: join(import.meta.dirname, '..'), timeout: 30_000 })
    assert.equal(child.stdout.toString().trim(), 'done', child.stderr.toString())
    assert.equal(child.status, 0)
    assert.ok(performance.now() - start < 20_000)
  })

  // The OS enforces it on Linux, and wasm enforces it everywhere.
  const enforcesProcessMemory = backend === 'wasm' || process.platform === 'linux'
  test('limitProcessMemory is enforced, and the worker is replaced', { skip: !enforcesProcessMemory }, async () => {
    const pool = new Pool({ concurrency: 1, limitProcessMemory: 48 * 1024 * 1024 })
    // 75 MB of pixels. `limitAllocatorMemory` allows it, so the allocator doesn't stop it first.
    const large = await fromRaw(pattern(5000, 5000)).png().toBuffer()
    await assertRejectsWithCode(blunt(large, { pool, limitAllocatorMemory: 2 ** 30 }).png().toBuffer(), 'ERR_OUT_OF_MEMORY')
    const small = await fromRaw(pattern(30, 30)).png().toBuffer()
    await blunt(small, { pool }).png().toBuffer()
  })

  test('limitProcessMemory is validated', () => {
    assert.throws(() => new Pool({ limitProcessMemory: -1 }), TypeError)
    assert.throws(() => new Pool({ limitProcessMemory: true as never }), TypeError)
    new Pool({ limitProcessMemory: false })
  })
})

// Workers are forked from a fork server, except on Windows.
describe('fork server', { skip: backend !== 'native' || process.platform === 'win32' }, () => {
  function processes() {
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='])
      .toString()
      .trim()
      .split('\n')
      .map((line) => {
        const [, pid, ppid, args] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)!
        return { pid: Number(pid), ppid: Number(ppid), args }
      })
  }
  function servers() {
    return processes().filter(({ ppid, args }) => ppid === process.pid && args.includes('--fork-server'))
  }

  test('workers are forked from a fork server', async () => {
    const before = new Set(servers().map(({ pid }) => pid))
    const pool = new Pool({ concurrency: 2 })
    const input = await fromRaw(pattern(64, 64)).png().toBuffer()
    await Promise.all([blunt(input, { pool }).png().toBuffer(), blunt(input, { pool }).png().toBuffer()])
    const all = processes()
    const added = servers().filter(({ pid }) => !before.has(pid))
    assert.equal(added.length, 1)
    assert.ok(all.some(({ ppid }) => ppid === added[0]!.pid))
    // Nothing else is spawned directly.
    assert.ok(!all.some(({ ppid, args }) => ppid === process.pid && args.includes('blunt-image-optimization-worker') && !args.includes('--fork-server')))
  })

  test('the pool replaces a fork server that exits', async () => {
    const before = new Set(servers().map(({ pid }) => pid))
    const pool = new Pool({ concurrency: 1 })
    const input = await fromRaw(pattern(64, 64)).png().toBuffer()
    await blunt(input, { pool }).png().toBuffer()
    const [server] = servers().filter(({ pid }) => !before.has(pid))
    for (const { pid } of processes().filter(({ ppid }) => ppid === server!.pid)) {
      process.kill(pid, 'SIGKILL')
    }
    process.kill(server!.pid, 'SIGKILL')
    // The idle worker is gone.
    await assertRejectsWithCode(blunt(input, { pool }).png().toBuffer(), 'ERR_WORKER_CRASHED')
    await blunt(input, { pool }).png().toBuffer()
  })
})

// The native binding's handling of misbehaving workers, with shell scripts standing in for the
// worker binary (or the fork server, which they fail to start).
describe('native worker failures', { skip: backend !== 'native' || process.platform === 'win32' }, () => {
  interface RunResult {
    response?: Buffer
    error?: { code: string; message: string }
  }
  const binding = createRequire(import.meta.url)('../binding.js') as {
    WorkerPool: new (options: object) => {
      run(input: Uint8Array, options: string, runOptions: object): Promise<RunResult>
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'blunt-test-'))
  let count = 0
  function worker(script: string): string {
    const path = join(dir, `worker-${count++}.sh`)
    writeFileSync(path, `#!/bin/sh\n${script}\n`)
    chmodSync(path, 0o755)
    return path
  }
  function run(workerPath: string, timeoutMs?: number, forkServer = false): Promise<RunResult> {
    const pool = new binding.WorkerPool({ workerPath, maxProcesses: 1, idleTimeoutMs: 1000, memoryLimit: 0, forkServer })
    return pool.run(Buffer.alloc(16), '{}', { timeoutMs, maxResponseBytes: 1024 })
  }
  async function assertFails(result: Promise<RunResult>, code: string) {
    const { response, error } = await result
    assert.equal(response, undefined)
    assert.equal(error?.code, code, JSON.stringify(error))
  }

  test('responses are passed through', async () => {
    const { response, error } = await run(worker(String.raw`printf '\003\0\0\0\0\0\0\0abc'; exec sleep 10`))
    assert.equal(error, undefined)
    assert.equal(response?.toString(), 'abc')
  })

  test('exit codes', async () => {
    await assertFails(run(worker('exit 86')), 'ERR_OUT_OF_MEMORY')
    await assertFails(run(worker('exit 87')), 'ERR_WORKER_SPAWN')
    await assertFails(run(worker('exit 88')), 'ERR_WORKER_SPAWN')
    await assertFails(run(worker('exit 1')), 'ERR_WORKER_CRASHED')
    await assertFails(run(worker('kill -9 $$')), 'ERR_WORKER_CRASHED')
  })

  test('a missing worker binary', async () => {
    await assertFails(run(join(dir, 'missing')), 'ERR_WORKER_SPAWN')
    await assertFails(run(join(dir, 'missing'), undefined, true), 'ERR_WORKER_SPAWN')
  })

  test('a fork server that fails to start', async () => {
    const fork = (script: string) => run(worker(script), undefined, true)
    await assertFails(fork('exit 86'), 'ERR_OUT_OF_MEMORY')
    await assertFails(fork('exit 87'), 'ERR_WORKER_SPAWN')
    await assertFails(fork('exit 88'), 'ERR_WORKER_SPAWN')
    await assertFails(fork('exit 0'), 'ERR_WORKER_CRASHED')
    await assertFails(fork('kill -9 $$'), 'ERR_WORKER_CRASHED')
    // Closes the socket, but keeps running.
    await assertFails(fork('exec sleep 10 <&-'), 'ERR_WORKER_CRASHED')
  })

  test('a worker that never responds is killed', async () => {
    const start = performance.now()
    await assertFails(run(worker('exec sleep 10'), 100), 'ERR_TIMEOUT')
    assert.ok(performance.now() - start < 5000)
  })

  test('oversized and truncated responses', async () => {
    const huge = String.raw`printf '\377\377\377\377\377\377\377\377'; exec sleep 10`
    await assertFails(run(worker(huge)), 'ERR_WORKER_CRASHED')
    await assertFails(run(worker(String.raw`printf '\003\0\0\0\0\0\0\0a'`)), 'ERR_WORKER_CRASHED')
  })

  test('the worker gets an empty environment', async () => {
    process.env.BLUNT_TEST_SECRET = 'secret'
    try {
      const script = String.raw`env | grep -q BLUNT_TEST_SECRET && printf '\001\0\0\0\0\0\0\0y' || printf '\001\0\0\0\0\0\0\0n'; exec sleep 10`
      const { response } = await run(worker(script))
      assert.equal(response?.toString(), 'n')
    } finally {
      delete process.env.BLUNT_TEST_SECRET
    }
  })
})
