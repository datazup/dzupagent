/**
 * DZUPAGENT-ERR-L-48 — the fire-and-forget memory finalizers (decay, prune,
 * consolidate) stay non-fatal, but a failing sweep must surface exactly one
 * `memory:error` event naming the finalizer instead of being swallowed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsolidationEngine, MemoryPruner } from '@dzupagent/memory'
import { maybeWriteBackMemory } from '../agent-finalizers.js'
import type { DzupAgentConfig } from '../agent-types.js'

type Rec = Record<string, unknown>

/** Store satisfying the finalizers' structural pruner-store check. */
const prunerStore = {
  search: async (): Promise<Array<{ key: string; value: Rec }>> => [],
  put: async (): Promise<void> => undefined,
  delete: async (): Promise<boolean> => true,
}

function makeConfig(
  overrides: Rec,
  events: Rec[],
): DzupAgentConfig {
  return {
    id: 'agent-test',
    name: 'Test Agent',
    memoryNamespace: 'test-ns',
    memoryScope: { tenant: 'tenant-1' },
    memoryWriteBack: true,
    eventBus: { emit: (e: Rec) => events.push(e) },
    ...overrides,
  } as unknown as DzupAgentConfig
}

function finalizerErrors(events: Rec[], finalizer: string): Rec[] {
  return events.filter(
    (e) => e['type'] === 'memory:error' && e['key'] === `finalizer:${finalizer}`,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('memory finalizer failures', () => {
  it('reports a throwing decay sweep as one memory:error naming the finalizer', async () => {
    const events: Rec[] = []
    const config = makeConfig(
      {
        memoryDecayThreshold: 1,
        memoryPolicy: { pruneFinalizer: false },
        memory: {
          put: async () => undefined,
          getKeyed: async () => {
            throw new Error('postgres://user:secret@db/offline')
          },
          delete: async () => true,
        },
      },
      events,
    )

    await maybeWriteBackMemory({ agentId: 'agent-test', content: 'note', config })

    await vi.waitFor(() => expect(finalizerErrors(events, 'decay')).toHaveLength(1))
    const [event] = finalizerErrors(events, 'decay')
    expect(event).toMatchObject({ agentId: 'agent-test', namespace: 'test-ns' })
    expect(String(event?.['message'])).toContain('decay')
    expect(String(event?.['message'])).not.toContain('secret')
  })

  it('reports a throwing prune sweep as one memory:error naming the finalizer', async () => {
    vi.spyOn(MemoryPruner.prototype, 'prune').mockRejectedValue(new Error('prune exploded'))
    const events: Rec[] = []
    const config = makeConfig(
      {
        memoryDecayThreshold: 0,
        memoryPolicy: { pruneFinalizer: true, consolidateFinalizer: false },
        memory: { put: async () => undefined, getStore: () => prunerStore },
      },
      events,
    )

    await maybeWriteBackMemory({ agentId: 'agent-test', content: 'note', config })

    await vi.waitFor(() => expect(finalizerErrors(events, 'prune')).toHaveLength(1))
    expect(String(finalizerErrors(events, 'prune')[0]?.['message'])).toContain('prune')
  })

  it('reports a throwing consolidation sweep as one memory:error naming the finalizer', async () => {
    vi.spyOn(ConsolidationEngine.prototype, 'consolidate').mockRejectedValue(
      new Error('consolidate exploded'),
    )
    const events: Rec[] = []
    const config = makeConfig(
      {
        memoryDecayThreshold: 0,
        memoryPolicy: { pruneFinalizer: false, consolidateFinalizer: true },
        memory: { put: async () => undefined, getStore: () => prunerStore },
      },
      events,
    )

    await maybeWriteBackMemory({ agentId: 'agent-test', content: 'note', config })

    await vi.waitFor(() =>
      expect(finalizerErrors(events, 'consolidate')).toHaveLength(1),
    )
    expect(String(finalizerErrors(events, 'consolidate')[0]?.['message'])).toContain(
      'consolidate',
    )
  })

  it('does not let a throwing event listener escape a failed sweep', async () => {
    vi.spyOn(MemoryPruner.prototype, 'prune').mockRejectedValue(new Error('prune exploded'))
    let calls = 0
    const config = {
      ...makeConfig(
        {
          memoryDecayThreshold: 0,
          memoryPolicy: { pruneFinalizer: true, consolidateFinalizer: false },
          memory: { put: async () => undefined, getStore: () => prunerStore },
        },
        [],
      ),
      eventBus: {
        emit: (e: Rec) => {
          calls++
          if (e['type'] === 'memory:error') throw new Error('listener failed')
        },
      },
    } as unknown as DzupAgentConfig

    await expect(
      maybeWriteBackMemory({ agentId: 'agent-test', content: 'note', config }),
    ).resolves.toBeUndefined()
    // memory:written for the write itself, then the guarded finalizer error.
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2))
  })
})
