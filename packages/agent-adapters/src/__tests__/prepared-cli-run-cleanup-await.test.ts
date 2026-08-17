/**
 * Runtime lock for `PreparedCliRun.cleanup`.
 *
 * The declaration is `() => void` so adapters can supply an expression-bodied
 * arrow (see union-return-callback-contracts.test.ts for that type lock), but
 * the stream source still awaits whatever the action returned. A type-level
 * lock cannot catch a dropped `await`, so this drives the real stream source
 * with a stubbed spawn and proves the generator does not finish until an async
 * cleanup has settled.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { buildCliStreamSource } from '../base/base-cli-adapter-stream-source.js'
import type { StreamSourceAdapter } from '../base/base-cli-adapter-stream-source.js'
import { GovernanceEmitter } from '../base/governance-emitter.js'
import type { PreparedCliRun } from '../base/prepared-cli-run.js'
import type { AgentInput, RawAgentEvent } from '../types.js'
import { getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

const { mockSpawnAndStreamJsonl } = getProcessHelperMocks()

function streamSourceWithCleanup(cleanup: () => void) {
  const prepared: PreparedCliRun = { args: ['--print'], env: {}, cleanup }

  const adapter: StreamSourceAdapter = {
    providerId: 'gemini',
    governance: new GovernanceEmitter('gemini'),
    getBinaryName: () => 'test-bin',
    prepareCliRun: async () => prepared,
    mapProviderEvent: () => undefined,
    detectProviderThreadStart: () => null,
    normalizeError: (err: unknown) => ({
      message: err instanceof Error ? err.message : String(err),
      code: 'ADAPTER_EXECUTION_FAILED',
      original: err,
    }),
  }

  const input: AgentInput = { prompt: 'hello' }
  const rawQueue: RawAgentEvent[] = []

  return buildCliStreamSource({
    adapter,
    input,
    sessionId: 'session-1',
    policy: { mode: 'auto-approve' },
    resolver: null,
    pendingEvents: [],
    captured: { error: null },
    flags: { hasCompleted: false, hasFailed: false, rawOrdinal: 0 },
    emitRaw: false,
    store: null,
    rawQueue,
    rawPersistence: { pending: Promise.resolve() },
  })
}

/** Drains the source's `open()` generator to completion. */
async function drain(
  source: ReturnType<typeof streamSourceWithCleanup>,
): Promise<void> {
  const controller = new AbortController()
  for await (const _record of source.open({ prompt: 'hello' }, controller.signal)) {
    void _record
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('PreparedCliRun.cleanup — runtime await', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      // A run that produces no JSONL records still has to clean up.
    })
  })

  it('runs an expression-bodied cleanup exactly once', async () => {
    const removed: string[] = []
    await drain(streamSourceWithCleanup(() => removed.push('/tmp/scratch')))
    expect(removed).toEqual(['/tmp/scratch'])
  })

  it('does not finish the run until an async cleanup has settled', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let cleanupFinished = false

    const source = streamSourceWithCleanup(async () => {
      await gate
      cleanupFinished = true
    })

    let drained = false
    const pending = drain(source).then(() => {
      drained = true
    })

    await flush()
    // RUNTIME LOCK: drop `await prepared.cleanup?.()` in the stream source's
    // finally block and the generator completes here, before cleanup settles.
    expect(drained).toBe(false)
    expect(cleanupFinished).toBe(false)

    release()
    await pending
    expect(cleanupFinished).toBe(true)
  })

  it('awaits cleanup before the spawn failure propagates', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let cleanupFinished = false

    mockSpawnAndStreamJsonl.mockImplementation(
      async function* (): AsyncGenerator<Record<string, unknown>, void, undefined> {
        throw new Error('spawn exploded')
      },
    )

    const source = streamSourceWithCleanup(async () => {
      await gate
      cleanupFinished = true
    })

    let rejected = false
    const pending = drain(source).then(
      () => {
        throw new Error('expected drain() to reject')
      },
      (err: unknown) => {
        rejected = true
        return err
      },
    )

    await flush()
    // RUNTIME LOCK: the finally block must hold the rejection back until
    // cleanup settles. Drop the await and the error propagates here.
    expect(rejected).toBe(false)
    expect(cleanupFinished).toBe(false)

    release()
    const err = await pending
    expect(rejected).toBe(true)
    expect((err as Error).message).toBe('spawn exploded')
    expect(cleanupFinished).toBe(true)
  })
})
