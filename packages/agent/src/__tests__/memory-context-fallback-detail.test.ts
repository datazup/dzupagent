/**
 * QF-AGENT-07: Diagnosable memory and context fallback events.
 *
 * Verifies that all four fallback paths emit structured telemetry
 * (provider, namespace, detail, before/after token estimates) without
 * leaking raw scope keys or memory content, and that the run remains
 * non-fatal in every case.
 */
import { describe, it, expect, vi } from 'vitest'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { createEventBus } from '@dzupagent/core'

import {
  AgentMemoryContextLoader,
  type ArrowMemoryRuntime,
} from '../agent/memory-context-loader.js'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { DzupAgentConfig } from '../agent/agent-types.js'

interface FallbackEvent {
  type: string
  agentId?: string
  reason: string
  before: number
  after: number
  provider?: string
  namespace?: string
  detail?: string
}

interface FallbackDetailEvent {
  reason: string
  detail: string
  namespace: string
  provider?: string
  tokensBefore?: number
  tokensAfter?: number
}

function createMockModel(response = 'response'): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage(response)),
    bindTools: vi.fn().mockReturnThis(),
  } as unknown as BaseChatModel
}

function createMemoryService() {
  return {
    get: vi.fn(async () => [{ text: 'fact' }]),
    formatForPrompt: vi.fn((records: Array<Record<string, unknown>>) =>
      records.length === 0 ? '' : '## Memory Context\n- fact'),
    put: vi.fn(async () => undefined),
  }
}

describe('QF-AGENT-07 — Arrow runtime failure fallback', () => {
  it('emits onFallbackDetail with provider, namespace, and token estimates when the Arrow runtime throws', async () => {
    const memory = createMemoryService()
    const onFallback = vi.fn()
    const onFallbackDetail = vi.fn<(event: FallbackDetailEvent) => void>()

    const loader = new AgentMemoryContextLoader({
      instructions: 'system instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo', secret: 'should-not-leak' },
      arrowMemory: { currentPhase: 'general' },
      estimateConversationTokens: () => 500,
      loadArrowRuntime: async () => {
        throw new Error('Arrow IPC bridge unavailable')
      },
      onFallback,
      onFallbackDetail,
    })

    // Run continues — memory load falls through to standard path.
    const result = await loader.load([new HumanMessage('hi')])
    expect(result.context).toBe('## Memory Context\n- fact')

    // Legacy callback fires with non-zero before count (now diagnosable).
    expect(onFallback).toHaveBeenCalledWith('arrow_fallback', expect.any(Number), 0)

    // Structured callback fires with full diagnostic context.
    expect(onFallbackDetail).toHaveBeenCalledTimes(1)
    const detailEvent = onFallbackDetail.mock.calls[0]![0]
    expect(detailEvent.reason).toBe('arrow_runtime_failure')
    expect(detailEvent.detail).toBe('Arrow IPC bridge unavailable')
    expect(detailEvent.namespace).toBe('facts')
    expect(detailEvent.provider).toBe('arrow')
    expect(detailEvent.tokensBefore).toBeGreaterThan(0)
    expect(detailEvent.tokensAfter).toBe(0)

    // Scope keys/values are never present in the structured event.
    const serialised = JSON.stringify(detailEvent)
    expect(serialised).not.toContain('should-not-leak')
    expect(serialised).not.toContain('project')
  })

  it('truncates long namespaces to avoid unbounded telemetry', async () => {
    const memory = createMemoryService()
    const onFallbackDetail = vi.fn<(event: FallbackDetailEvent) => void>()
    const longNamespace = 'a'.repeat(200)

    const loader = new AgentMemoryContextLoader({
      instructions: 'i',
      memory,
      memoryNamespace: longNamespace,
      memoryScope: { p: 'demo' },
      arrowMemory: { currentPhase: 'general' },
      estimateConversationTokens: () => 10,
      loadArrowRuntime: async () => {
        throw new Error('boom')
      },
      onFallbackDetail,
    })

    await loader.load([new HumanMessage('hi')])
    const detailEvent = onFallbackDetail.mock.calls[0]![0]
    expect(detailEvent.namespace.length).toBeLessThanOrEqual(67) // 64 chars + "..."
    expect(detailEvent.namespace.endsWith('...')).toBe(true)
  })
})

describe('QF-AGENT-07 — Zero memory budget fallback', () => {
  it('emits onFallbackDetail with budget context, provider, and token estimates', async () => {
    const memory = createMemoryService()
    const onFallback = vi.fn()
    const onFallbackDetail = vi.fn<(event: FallbackDetailEvent) => void>()

    class FakeFrameReader {
      constructor(_f: unknown) {}
      toRecords() {
        return [{ meta: { namespace: 'facts' }, value: { text: 'never selected' } }]
      }
    }

    const loadArrowRuntime = async (): Promise<ArrowMemoryRuntime> => ({
      extendMemoryServiceWithArrow: () => ({
        exportFrame: async () => ({ numRows: 1 }),
      }),
      selectMemoriesByBudget: vi.fn(() => []),
      phaseWeightedSelection: vi.fn(() => []),
      FrameReader: FakeFrameReader,
    })

    const loader = new AgentMemoryContextLoader({
      instructions: 'system',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: {
        currentPhase: 'general',
        totalBudget: 100,
        maxMemoryFraction: 0.1,
        minResponseReserve: 1_000_000,
      },
      estimateConversationTokens: () => 50,
      loadArrowRuntime,
      onFallback,
      onFallbackDetail,
    })

    // Run remains non-fatal: returns null context but does not throw.
    const result = await loader.load([new HumanMessage('hi')])
    expect(result.context).toBeNull()

    // Legacy callback now reports tokensBefore (was previously always 0).
    expect(onFallback).toHaveBeenCalledWith('budget_zero', expect.any(Number), 0)
    const [, beforeArg, afterArg] = onFallback.mock.calls[0]!
    expect(beforeArg).toBeGreaterThan(0)
    expect(afterArg).toBe(0)

    // Structured callback carries full diagnostic context, no record content.
    const detailEvent = onFallbackDetail.mock.calls[0]![0]
    expect(detailEvent.reason).toBe('memory_budget_zero')
    expect(detailEvent.provider).toBe('arrow')
    expect(detailEvent.namespace).toBe('facts')
    expect(detailEvent.tokensBefore).toBeGreaterThan(0)
    expect(detailEvent.tokensAfter).toBe(0)
    expect(detailEvent.detail).toContain('totalBudget=100')
    expect(detailEvent.detail).toContain('minResponseReserve=1000000')
    // No record content
    expect(detailEvent.detail).not.toContain('never selected')
  })
})

describe('QF-AGENT-07 — Standard memory load failure fallback', () => {
  it('emits structured agent:context_fallback event when memory.get throws and run continues', async () => {
    const eventBus = createEventBus()
    const captured: FallbackEvent[] = []
    eventBus.on('agent:context_fallback', (e) => {
      captured.push(e as unknown as FallbackEvent)
    })

    const failingMemory = {
      get: vi.fn(async () => {
        throw new Error('redis connection refused')
      }),
      formatForPrompt: vi.fn(() => ''),
      put: vi.fn(async () => undefined),
    }

    const onFallbackDetail = vi.fn<(event: FallbackDetailEvent) => void>()

    const agent = new DzupAgent({
      id: 'mem-fail-agent',
      instructions: 'instructions',
      model: createMockModel(),
      memory: failingMemory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo', token: 'do-not-leak' },
      eventBus,
      onFallbackDetail,
    } as unknown as DzupAgentConfig)

    // The run completes (memory failure is non-fatal).
    const result = await agent.generate([new HumanMessage('hello')])
    expect(result.content).toBe('response')
    expect(result.stopReason).not.toBe('failed')

    // A structured fallback event was emitted with provider+namespace+detail.
    const memoryFailEvents = captured.filter(
      (e) => e.reason === 'memory_load_failure',
    )
    expect(memoryFailEvents.length).toBeGreaterThan(0)
    const ev = memoryFailEvents[0]!
    expect(ev.agentId).toBe('mem-fail-agent')
    expect(ev.namespace).toBe('facts')
    expect(ev.provider).toBeDefined()
    expect(ev.detail).toContain('redis connection refused')
    expect(ev.before).toBeGreaterThanOrEqual(0)

    // Scope keys/values must never appear in telemetry.
    const serialised = JSON.stringify(memoryFailEvents)
    expect(serialised).not.toContain('do-not-leak')
    expect(serialised).not.toContain('"token"')

    // onFallbackDetail also fires with the same diagnostic shape.
    expect(onFallbackDetail).toHaveBeenCalled()
    const detailEvent = onFallbackDetail.mock.calls.find(
      ([e]) => e.reason === 'memory_load_failure',
    )?.[0]
    expect(detailEvent).toBeDefined()
    expect(detailEvent!.namespace).toBe('facts')
    expect(detailEvent!.detail).toContain('redis connection refused')
  })
})

describe('QF-AGENT-07 — Summary failure fallback', () => {
  it('emits structured agent:context_fallback event when summarization throws and run continues', async () => {
    const eventBus = createEventBus()
    const captured: FallbackEvent[] = []
    eventBus.on('agent:context_fallback', (e) => {
      captured.push(e as unknown as FallbackEvent)
    })

    const onFallbackDetail = vi.fn<(event: FallbackDetailEvent) => void>()

    // Registry that throws when summarization tries to fetch the chat
    // model — simulates provider outage at the moment the summary
    // pass attempts to spin up.
    const failingRegistry = {
      getModel: vi.fn(() => {
        throw new Error('summary model 500')
      }),
      getModelByName: vi.fn(),
      getModelWithFallback: vi.fn(),
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
    }

    const agent = new DzupAgent({
      id: 'summary-fail-agent',
      instructions: 'i',
      model: createMockModel(),
      memoryNamespace: 'episodic',
      eventBus,
      onFallbackDetail,
      registry: failingRegistry as unknown as DzupAgentConfig['registry'],
      messageConfig: { maxMessages: 1 },
    } as unknown as DzupAgentConfig)

    const internal = agent as unknown as {
      maybeUpdateSummary: (msgs: unknown[], frame?: unknown) => Promise<void>
    }

    const messages = [
      new HumanMessage('q1'),
      new AIMessage('a1'),
      new HumanMessage('q2'),
      new AIMessage('a2'),
    ]

    // Must not throw — failures are non-fatal.
    await expect(internal.maybeUpdateSummary(messages)).resolves.toBeUndefined()

    const summaryFailEvents = captured.filter(
      (e) => e.reason === 'summary_failure',
    )
    expect(summaryFailEvents.length).toBeGreaterThan(0)
    const ev = summaryFailEvents[0]!
    expect(ev.agentId).toBe('summary-fail-agent')
    expect(ev.provider).toBe('summary')
    expect(ev.namespace).toBe('episodic')
    expect(ev.detail).toContain('summary model 500')

    // onFallbackDetail also fires.
    const detailEvent = onFallbackDetail.mock.calls.find(
      ([e]) => e.reason === 'summary_failure',
    )?.[0]
    expect(detailEvent).toBeDefined()
    expect(detailEvent!.provider).toBe('summary')
    expect(detailEvent!.namespace).toBe('episodic')
    expect(detailEvent!.detail).toContain('summary model 500')
    expect(detailEvent!.tokensBefore).toBeGreaterThanOrEqual(0)
    expect(detailEvent!.tokensAfter).toBe(detailEvent!.tokensBefore)
  })
})
