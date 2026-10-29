import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Pool, defaultPool } from '../dist/index.js'
import { NativeBackend } from '../dist/native.js'
import type { RunResult } from '../dist/protocol.js'
import { assertRejectsWithCode, fromRaw, pattern } from './helpers.ts'

const backend = defaultPool().backend

/** `Pool.run` is internal, but lets tests use timeouts shorter than a second. */
interface InternalPool {
  run(input: Uint8Array, options: object, limitOutputBytes: number | undefined, timeoutMs?: number): Promise<unknown>
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
    for (const concurrency of [0, 1.5, Infinity]) {
      assert.throws(() => new Pool({ concurrency }), TypeError)
    }
    new Pool({ concurrency: 2 ** 40 })
    for (const idleTimeoutMs of [-1, NaN, '10']) {
      assert.throws(() => new Pool({ idleTimeoutMs: idleTimeoutMs as never }), TypeError)
    }
    for (const idleTimeoutMs of [0, 1.5, 3_000_000_000, Infinity]) {
      new Pool({ idleTimeoutMs })
    }
    assert.throws(() => new Pool({ forkServer: 'yes' as never }), TypeError)
    for (const ms of [-1, -0.5, NaN, undefined, '10']) {
      assert.throws(() => defaultPool().prepare(Buffer.alloc(1)).timeoutMs(ms as never), TypeError)
    }
  })

  test('the backend environment variable is validated', (t) => {
    const name = 'NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND'
    const previous = process.env[name]
    t.after(() => {
      if (previous === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = previous
      }
    })
    process.env[name] = 'other'
    assert.throws(() => new Pool(), TypeError)
    process.env[name] = backend
    assert.equal(new Pool().backend, backend)
  })

  test('very long timeouts never expire', async () => {
    const input = await fromRaw(pattern(8, 8)).png().toBuffer()
    // More than 2 ** 31 - 1 ms, which `setTimeout` would treat as 1ms, and more than a `Duration`.
    for (const ms of [3_000_000_000, Number.MAX_VALUE, Infinity]) {
      const { info } = await defaultPool().prepare(input).timeoutMs(ms).toBuffer({ resolveWithObject: true })
      assert.equal(info.width, 8)
    }
  })

  test('very long idle timeouts never expire', async () => {
    const input = await fromRaw(pattern(8, 8)).png().toBuffer()
    const warnings: Error[] = []
    const onWarning = (warning: Error) => warnings.push(warning)
    process.on('warning', onWarning)
    try {
      // `setTimeout` would treat these as 1ms, with a `TimeoutOverflowWarning`.
      for (const idleTimeoutMs of [3_000_000_000, Infinity]) {
        await new Pool({ idleTimeoutMs }).prepare(input).toBuffer()
      }
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('warning', onWarning)
    }
    assert.deepEqual(
      warnings.filter(({ name }) => name === 'TimeoutOverflowWarning'),
      [],
    )
  })

  test('requests queue for a free worker', async () => {
    const pool = new Pool({ concurrency: 1 })
    assert.equal(pool.backend, backend)
    const input = await fromRaw(pattern(64, 64)).png().toBuffer()
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => pool.prepare(input).resize(10 + i).toBuffer({ resolveWithObject: true })),
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
    const { info } = await pool.prepare(input).timeoutMs(60_000).resize(8).toBuffer({ resolveWithObject: true })
    assert.equal(info.width, 8)
  })

  test('idle workers keep neither themselves nor the process alive', () => {
    const script = `
      const { Pool } = require('./dist/index.js')
      // A 1x1 PNG.
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64')
      new Pool({ idleTimeoutMs: 60000 }).prepare(png).toBuffer().then(() => console.log('done'))
    `
    const start = performance.now()
    const child = spawnSync(process.execPath, ['-e', script], { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 30_000 })
    assert.equal(child.stdout.toString().trim(), 'done', child.stderr.toString())
    assert.equal(child.status, 0)
    assert.ok(performance.now() - start < 20_000)
  })

  // The OS enforces it on Linux, and wasm enforces it everywhere. QEMU's user mode emulation (CI's
  // riscv64 tests) ignores `RLIMIT_DATA`, which would also limit QEMU's own allocations.
  const enforcesProcessMemory = backend === 'wasm' || (process.platform === 'linux' && process.env.NSIO_TEST_QEMU !== '1')
  test('limitProcessMemoryBytes is enforced, and the worker is replaced', { skip: !enforcesProcessMemory }, async () => {
    const pool = new Pool({ concurrency: 1, limitProcessMemoryBytes: 48 * 1024 * 1024 })
    // 75 MB of pixels. `limitAllocatorMemoryBytes` allows it, so the allocator doesn't stop it first.
    const large = await fromRaw(pattern(5000, 5000)).png().toBuffer()
    await assertRejectsWithCode(pool.prepare(large, { limitAllocatorMemoryBytes: 2 ** 30 }).png().toBuffer(), 'ERR_OUT_OF_MEMORY')
    const small = await fromRaw(pattern(30, 30)).png().toBuffer()
    await pool.prepare(small).png().toBuffer()
  })

  test('limitProcessMemoryBytes is validated', () => {
    assert.throws(() => new Pool({ limitProcessMemoryBytes: -1 }), TypeError)
    assert.throws(() => new Pool({ limitProcessMemoryBytes: true as never }), TypeError)
    new Pool({ limitProcessMemoryBytes: false })
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
    await Promise.all([pool.prepare(input).png().toBuffer(), pool.prepare(input).png().toBuffer()])
    const all = processes()
    const added = servers().filter(({ pid }) => !before.has(pid))
    assert.equal(added.length, 1)
    assert.ok(all.some(({ ppid }) => ppid === added[0]!.pid))
    // Nothing else is spawned directly.
    assert.ok(!all.some(({ ppid, args }) => ppid === process.pid && args.includes('safe-image-optimization-worker') && !args.includes('--fork-server')))
  })

  test('the pool replaces a fork server that exits', async () => {
    const before = new Set(servers().map(({ pid }) => pid))
    const pool = new Pool({ concurrency: 1 })
    const input = await fromRaw(pattern(64, 64)).png().toBuffer()
    await pool.prepare(input).png().toBuffer()
    const [server] = servers().filter(({ pid }) => !before.has(pid))
    for (const { pid } of processes().filter(({ ppid }) => ppid === server!.pid)) {
      process.kill(pid, 'SIGKILL')
    }
    process.kill(server!.pid, 'SIGKILL')
    // The idle worker is gone too, which the pool may not have noticed yet.
    await pool.prepare(input)
      .png()
      .toBuffer()
      .catch((error: { code?: string }) => assert.equal(error.code, 'ERR_WORKER_CRASHED'))
    await pool.prepare(input).png().toBuffer()
    const replaced = servers().filter(({ pid }) => !before.has(pid) && pid !== server!.pid)
    assert.equal(replaced.length, 1)
  })

  // Last, because the first test checks that nothing is spawned directly.
  test('forkServer: false spawns each worker', async () => {
    const spawned = () =>
      processes().filter(({ ppid, args }) => ppid === process.pid && args.includes('safe-image-optimization-worker'))
    const before = new Set(spawned().map(({ pid }) => pid))
    const pool = new Pool({ concurrency: 2, forkServer: false })
    const input = await fromRaw(pattern(64, 64)).png().toBuffer()
    await Promise.all([pool.prepare(input).png().toBuffer(), pool.prepare(input).png().toBuffer()])
    const added = spawned().filter(({ pid }) => !before.has(pid))
    assert.equal(added.length, 2)
    assert.ok(added.every(({ args }) => !args.includes('--fork-server')))
  })
})

// The native backend's handling of misbehaving workers, with shell scripts standing in for the
// worker binary (or the fork server, which they fail to start).
describe('native worker failures', { skip: backend !== 'native' || process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsio-test-'))
  let count = 0
  function worker(script: string): string {
    const path = join(dir, `worker-${count++}.sh`)
    writeFileSync(path, `#!/bin/sh\n${script}\n`)
    chmodSync(path, 0o755)
    return path
  }
  function run(workerPath: string, timeoutMs?: number, forkServer = false): Promise<RunResult> {
    const pool = new NativeBackend({ workerPath, maxProcesses: 1, idleTimeoutMs: 1000, memoryLimit: 0, forkServer })
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
    // Close the IPC channel but keep running. Redirecting on `exec sleep` leaves a duplicate
    // of fd 3 open in macOS's shell, so close it in a separate command.
    await assertFails(fork('exec 3<&-; exec sleep 10'), 'ERR_WORKER_CRASHED')
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
    await assertFails(run(worker(String.raw`printf '\001\0\0\0\0\0\0\0ab'; exec sleep 10`)), 'ERR_WORKER_CRASHED')
  })

  test('the worker gets an empty environment', async () => {
    process.env.NSIO_TEST_SECRET = 'secret'
    try {
      const script = String.raw`env | grep -q NSIO_TEST_SECRET && printf '\001\0\0\0\0\0\0\0y' || printf '\001\0\0\0\0\0\0\0n'; exec sleep 10`
      const { response } = await run(worker(script))
      assert.equal(response?.toString(), 'n')
    } finally {
      delete process.env.NSIO_TEST_SECRET
    }
  })
})
