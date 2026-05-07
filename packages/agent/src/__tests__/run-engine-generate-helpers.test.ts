/**
 * Direct unit tests for the phase helpers extracted from executeGenerateRunInner
 * (RF-25 / CODE-17):
 *
 *  - resolveRunStateRunId
 *  - prepareGuardPrelude
 *  - persistRunStateSnapshot
 *  - createRunStateSnapshotWriter
 *
 * These helpers are all exported from run-engine-generate-helpers.ts and have
 * zero direct test coverage in the existing suite. The suite that exercises
 * executeGenerateRun via run-engine.test.ts covers them indirectly, but
 * side-effect ordering, edge-case inputs, and the snapshot-writer ordering
 * guarantee warrant first-class tests here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import type { DzupRunState, DzupRunStateStore } from '@dzupagent/core'
import {
  resolveRunStateRunId,
  prepareGuardPrelude,
  persistRunStateSnapshot,
  createRunStateSnapshotWriter,
} from '../agent/run-engine-generate-helpers.js'
import type { DzupAgentConfig } from '../agent/agent-types.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeMockStore(
  overrides: Partial<DzupRunStateStore> = {},
): DzupRunStateStore {
  return {
    save: vi.fn(async () => {}),
    load: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    listRunIds: vi.fn(async () => []),
    ...overrides,
  } as unknown as DzupRunStateStore
}

const testMessages = [new HumanMessage('hello'), new AIMessage('world')]

// ---------------------------------------------------------------------------
// resolveRunStateRunId
// ---------------------------------------------------------------------------

describe('resolveRunStateRunId', () => {
  it('returns options.runId when provided', () => {
    const result = resolveRunStateRunId('agent-1', { runId: 'run-from-options' }, 'run-from-exec')
    expect(result).toBe('run-from-options')
  })

  it('falls back to toolExecution.runId when options.runId is absent', () => {
    const result = resolveRunStateRunId('agent-1', undefined, 'run-from-exec')
    expect(result).toBe('run-from-exec')
  })

  it('falls back to options without runId to toolExecution.runId', () => {
    const result = resolveRunStateRunId('agent-1', {}, 'run-from-exec')
    expect(result).toBe('run-from-exec')
  })

  it('synthesises agent-keyed id when both runId sources are absent', () => {
    const result = resolveRunStateRunId('my-agent', undefined, undefined)
    expect(result).toBe('agent:my-agent')
  })

  it('synthesises agent-keyed id from options without runId and no toolExec runId', () => {
    const result = resolveRunStateRunId('my-agent', {}, undefined)
    expect(result).toBe('agent:my-agent')
  })

  it('options.runId takes priority over toolExecution.runId', () => {
    const result = resolveRunStateRunId('agent-1', { runId: 'opt-run' }, 'exec-run')
    expect(result).toBe('opt-run')
  })
})

// ---------------------------------------------------------------------------
// prepareGuardPrelude
// ---------------------------------------------------------------------------

describe('prepareGuardPrelude', () => {
  it('returns empty compressionLog accumulator', () => {
    const config = {
      id: 'a',
      instructions: '',
      model: 'gpt-4',
    } satisfies DzupAgentConfig as DzupAgentConfig

    const prelude = prepareGuardPrelude(config)

    expect(prelude.compressionLog).toEqual([])
    expect(Array.isArray(prelude.compressionLog)).toBe(true)
  })

  it('returns undefined toolExec when config.toolExecution is absent', () => {
    const config = {
      id: 'a',
      instructions: '',
      model: 'gpt-4',
    } satisfies DzupAgentConfig as DzupAgentConfig

    const prelude = prepareGuardPrelude(config)

    expect(prelude.toolExec).toBeUndefined()
  })

  it('returns toolExec from config.toolExecution', () => {
    const toolExec = { agentId: 'agent-1' }
    const config = {
      id: 'a',
      instructions: '',
      model: 'gpt-4',
      toolExecution: toolExec,
    } as unknown as DzupAgentConfig

    const prelude = prepareGuardPrelude(config)

    expect(prelude.toolExec).toBe(toolExec)
  })

  it('resolves safetyMonitor from toolExecution.safetyMonitor', () => {
    const safetyMonitor = { scanContent: vi.fn(() => []) }
    const config = {
      id: 'a',
      instructions: '',
      model: 'gpt-4',
      toolExecution: { safetyMonitor },
    } as unknown as DzupAgentConfig

    const prelude = prepareGuardPrelude(config)

    expect(prelude.resolvedSafetyMonitor).toBe(safetyMonitor)
  })

  it('resolves safetyMonitor from toolExecution.resultScanner as fallback', () => {
    const resultScanner = { scanContent: vi.fn(() => []) }
    const config = {
      id: 'a',
      instructions: '',
      model: 'gpt-4',
      toolExecution: { resultScanner },
    } as unknown as DzupAgentConfig

    const prelude = prepareGuardPrelude(config)

    expect(prelude.resolvedSafetyMonitor).toBe(resultScanner)
  })

  it('safetyMonitor takes precedence over resultScanner', () => {
    const safetyMonitor = { scanContent: vi.fn(() => []) }
    const resultScanner = { scanContent: vi.fn(() => []) }
    const config = {
      id: 'a',
      instructions: '',
      model: 'gpt-4',
      toolExecution: { safetyMonitor, resultScanner },
    } as unknown as DzupAgentConfig

    const prelude = prepareGuardPrelude(config)

    expect(prelude.resolvedSafetyMonitor).toBe(safetyMonitor)
  })

  it('compressionLog is a fresh mutable array on each call', () => {
    const config = {
      id: 'a',
      instructions: '',
      model: 'gpt-4',
    } satisfies DzupAgentConfig as DzupAgentConfig

    const p1 = prepareGuardPrelude(config)
    const p2 = prepareGuardPrelude(config)

    p1.compressionLog.push({ before: 10, after: 5, summary: 'test', ts: 0 })

    expect(p2.compressionLog).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// persistRunStateSnapshot
// ---------------------------------------------------------------------------

describe('persistRunStateSnapshot', () => {
  it('calls store.save with correctly shaped snapshot', async () => {
    const store = makeMockStore()
    const tsBefore = Date.now()

    await persistRunStateSnapshot({
      store,
      runId: 'run-1',
      agentId: 'agent-1',
      iteration: 2,
      messages: testMessages,
      cumulativeUsage: [{ model: 'gpt-4', inputTokens: 10, outputTokens: 5 }],
    })

    const tsAfter = Date.now()

    expect(store.save).toHaveBeenCalledOnce()
    const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DzupRunState
    expect(saved.version).toBe(1)
    expect(saved.runId).toBe('run-1')
    expect(saved.agentId).toBe('agent-1')
    expect(saved.iteration).toBe(2)
    expect(saved.messages).toBe(testMessages)
    expect(saved.snapshotAt).toBeGreaterThanOrEqual(tsBefore)
    expect(saved.snapshotAt).toBeLessThanOrEqual(tsAfter)
  })

  it('includes tenantId in snapshot when provided', async () => {
    const store = makeMockStore()

    await persistRunStateSnapshot({
      store,
      runId: 'run-1',
      agentId: 'agent-1',
      tenantId: 'tenant-abc',
      iteration: 0,
      messages: [],
      cumulativeUsage: [],
    })

    const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DzupRunState
    expect(saved.tenantId).toBe('tenant-abc')
  })

  it('omits tenantId when not provided', async () => {
    const store = makeMockStore()

    await persistRunStateSnapshot({
      store,
      runId: 'run-1',
      agentId: 'agent-1',
      iteration: 0,
      messages: [],
      cumulativeUsage: [],
    })

    const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DzupRunState
    expect('tenantId' in saved).toBe(false)
  })

  it('includes terminalReason when provided', async () => {
    const store = makeMockStore()

    await persistRunStateSnapshot({
      store,
      runId: 'run-1',
      agentId: 'agent-1',
      iteration: 3,
      messages: [],
      cumulativeUsage: [],
      terminalReason: 'complete',
    })

    const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DzupRunState
    expect(saved.terminalReason).toBe('complete')
  })

  it('omits terminalReason when not provided', async () => {
    const store = makeMockStore()

    await persistRunStateSnapshot({
      store,
      runId: 'run-1',
      agentId: 'agent-1',
      iteration: 0,
      messages: [],
      cumulativeUsage: [],
    })

    const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DzupRunState
    expect('terminalReason' in saved).toBe(false)
  })

  it('does not throw when store.save rejects (fire-and-forget)', async () => {
    const store = makeMockStore({
      save: vi.fn(async () => {
        throw new Error('backend unavailable')
      }),
    })

    await expect(
      persistRunStateSnapshot({
        store,
        runId: 'run-1',
        agentId: 'agent-1',
        iteration: 0,
        messages: [],
        cumulativeUsage: [],
      }),
    ).resolves.toBeUndefined()
  })

  it('stores cumulativeUsage array on snapshot', async () => {
    const store = makeMockStore()
    const usage = [
      { model: 'gpt-4', inputTokens: 10, outputTokens: 5 },
      { model: 'gpt-4', inputTokens: 20, outputTokens: 15 },
    ]

    await persistRunStateSnapshot({
      store,
      runId: 'run-1',
      agentId: 'agent-1',
      iteration: 2,
      messages: [],
      cumulativeUsage: usage,
    })

    const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DzupRunState
    expect(saved.cumulativeUsage).toEqual(usage)
  })
})

// ---------------------------------------------------------------------------
// createRunStateSnapshotWriter
// ---------------------------------------------------------------------------

describe('createRunStateSnapshotWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes a snapshot through persistRunStateSnapshot', async () => {
    const store = makeMockStore()
    const writer = createRunStateSnapshotWriter(store)

    writer({
      runId: 'run-1',
      agentId: 'agent-1',
      iteration: 1,
      messages: testMessages,
      cumulativeUsage: [],
    })

    // Allow microtasks to flush
    await new Promise((resolve) => setImmediate(resolve))

    expect(store.save).toHaveBeenCalledOnce()
  })

  it('writes snapshots in call order — terminal snapshot arrives after iteration snapshot', async () => {
    const savedReasons: Array<string> = []
    let releaseIteration!: () => void
    const iterationGate = new Promise<void>((resolve) => {
      releaseIteration = resolve
    })

    const store = makeMockStore({
      save: vi.fn(async (snapshot: DzupRunState) => {
        if (snapshot.terminalReason === undefined) {
          // Simulate a slow iteration save
          await iterationGate
        }
        savedReasons.push(snapshot.terminalReason ?? 'iteration')
      }),
    })

    const writer = createRunStateSnapshotWriter(store)

    // Write iteration snapshot first (will be held)
    writer({
      runId: 'run-1',
      agentId: 'agent-1',
      iteration: 1,
      messages: [],
      cumulativeUsage: [],
    })

    // Write terminal snapshot second (must queue behind iteration)
    writer({
      runId: 'run-1',
      agentId: 'agent-1',
      iteration: 2,
      messages: [],
      cumulativeUsage: [],
      terminalReason: 'complete',
    })

    // Verify nothing saved yet (iteration gate is still held)
    await new Promise((resolve) => setImmediate(resolve))
    expect(savedReasons).toEqual([])

    // Release iteration gate — both saves should now complete in order
    releaseIteration()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    expect(savedReasons).toEqual(['iteration', 'complete'])
  })

  it('does not throw when store.save rejects (fire-and-forget)', async () => {
    const store = makeMockStore({
      save: vi.fn(async () => {
        throw new Error('store failure')
      }),
    })

    const writer = createRunStateSnapshotWriter(store)

    // Should not throw — failures are swallowed
    expect(() => {
      writer({
        runId: 'run-1',
        agentId: 'agent-1',
        iteration: 0,
        messages: [],
        cumulativeUsage: [],
      })
    }).not.toThrow()

    // Allow the async chain to settle
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  })

  it('each call produces an independent write chain (different writers do not interfere)', async () => {
    const storeA = makeMockStore()
    const storeB = makeMockStore()
    const writerA = createRunStateSnapshotWriter(storeA)
    const writerB = createRunStateSnapshotWriter(storeB)

    writerA({ runId: 'a', agentId: 'agent', iteration: 1, messages: [], cumulativeUsage: [] })
    writerB({ runId: 'b', agentId: 'agent', iteration: 1, messages: [], cumulativeUsage: [] })

    await new Promise((resolve) => setImmediate(resolve))

    expect(storeA.save).toHaveBeenCalledOnce()
    expect(storeB.save).toHaveBeenCalledOnce()
    const savedA = (storeA.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DzupRunState
    const savedB = (storeB.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DzupRunState
    expect(savedA.runId).toBe('a')
    expect(savedB.runId).toBe('b')
  })
})
