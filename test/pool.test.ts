import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  run(input: Uint8Array, options: object, limits: object, timeoutMs?: number): Promise<unknown>
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
    for (const seconds of [-1, 1.5, 3601, undefined]) {
      assert.throws(() => blunt(Buffer.alloc(1)).timeout({ seconds } as never), TypeError)
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
      (pool as unknown as InternalPool).run(input, { transform: { format: 'png' } }, {}, 1),
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

  test('wasm workers that run out of memory are reported and replaced', { skip: backend !== 'wasm' }, async () => {
    const pool = new Pool({ backend: 'wasm', concurrency: 1, wasmMaxMemory: 48 * 1024 * 1024 })
    // 48 MB of pixels, which doesn't fit along with the module's stack and data.
    const large = await fromRaw(pattern(4000, 4000)).png().toBuffer()
    await assertRejectsWithCode(blunt(large, { pool }).png().toBuffer(), 'ERR_OUT_OF_MEMORY')
    const small = await fromRaw(pattern(30, 30)).png().toBuffer()
    await blunt(small, { pool }).png().toBuffer()
  })
})

// The native binding's handling of misbehaving workers, with shell scripts standing in for the
// worker binary.
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
  function run(workerPath: string, timeoutMs?: number): Promise<RunResult> {
    const pool = new binding.WorkerPool({ workerPath, maxProcesses: 1, idleTimeoutMs: 1000 })
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
