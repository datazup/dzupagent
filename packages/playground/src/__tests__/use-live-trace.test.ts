/**
 * Tests for the useLiveTrace composable.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useLiveTrace } from '../composables/useLiveTrace.js'
import type { ReplayEvent } from '../composables/useEventStream.js'

function makeEvent(overrides: Partial<ReplayEvent> = {}): ReplayEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type: 'tool:called',
    timestamp: new Date().toISOString(),
    runId: 'run-1',
    payload: {},
    ...overrides,
  }
}

describe('useLiveTrace', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // ── Timeline data ──────────────────────────────────

  describe('timelineData', () => {
    it('returns empty timeline for no events', () => {
      const events = ref<ReplayEvent[]>([])
      const { timelineData } = useLiveTrace(events)

      expect(timelineData.value.events).toEqual([])
      expect(timelineData.value.totalDurationMs).toBe(0)
      expect(timelineData.value.eventCount).toBe(0)
    })

    it('converts replay events to trace events', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({
          id: 'e1',
          type: 'tool:called',
          payload: { toolName: 'search', durationMs: 100 },
        }),
        makeEvent({
          id: 'e2',
          type: 'agent:stream_delta',
          payload: { content: 'Hello' },
        }),
      ])

      const { timelineData } = useLiveTrace(events)

      expect(timelineData.value.events.length).toBe(2)
      expect(timelineData.value.events[0]!.type).toBe('tool')
      expect(timelineData.value.events[0]!.name).toBe('search')
      expect(timelineData.value.events[1]!.type).toBe('llm')
      expect(timelineData.value.eventCount).toBe(2)
    })

    it('sums total duration from all events', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ payload: { durationMs: 100 } }),
        makeEvent({ payload: { durationMs: 200 } }),
        makeEvent({ payload: { durationMs: 300 } }),
      ])

      const { timelineData } = useLiveTrace(events)
      expect(timelineData.value.totalDurationMs).toBe(600)
    })

    it('maps event types correctly', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'tool:called' }),
        makeEvent({ type: 'tool:result' }),
        makeEvent({ type: 'memory:written' }),
        makeEvent({ type: 'memory:searched' }),
        makeEvent({ type: 'agent:stream_delta' }),
        makeEvent({ type: 'agent:stream_done' }),
        makeEvent({ type: 'pipeline:phase_changed' }),
      ])

      const { timelineData } = useLiveTrace(events)
      const types = timelineData.value.events.map((e) => e.type)

      expect(types[0]).toBe('tool')
      expect(types[1]).toBe('tool')
      expect(types[2]).toBe('memory')
      expect(types[3]).toBe('memory')
      expect(types[4]).toBe('llm')
      expect(types[5]).toBe('llm')
      expect(types[6]).toBe('system')
    })
  })

  // ── Node metrics ───────────────────────────────────

  describe('nodeMetrics', () => {
    it('returns empty map for no events', () => {
      const events = ref<ReplayEvent[]>([])
      const { nodeMetrics } = useLiveTrace(events)
      expect(nodeMetrics.value.size).toBe(0)
    })

    it('tracks tool call counts', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'tool:called', payload: { toolName: 'search' } }),
        makeEvent({ type: 'tool:result', payload: { toolName: 'search', durationMs: 50 } }),
        makeEvent({ type: 'tool:called', payload: { toolName: 'search' } }),
        makeEvent({ type: 'tool:result', payload: { toolName: 'search', durationMs: 70 } }),
        makeEvent({ type: 'tool:called', payload: { toolName: 'code_edit' } }),
      ])

      const { nodeMetrics } = useLiveTrace(events)

      expect(nodeMetrics.value.get('search')?.callCount).toBe(4)
      expect(nodeMetrics.value.get('code_edit')?.callCount).toBe(1)
    })

    it('computes average duration correctly', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'tool:result', payload: { toolName: 'search', durationMs: 40 } }),
        makeEvent({ type: 'tool:result', payload: { toolName: 'search', durationMs: 60 } }),
      ])

      const { nodeMetrics } = useLiveTrace(events)
      expect(nodeMetrics.value.get('search')?.avgDurationMs).toBe(50)
    })

    it('tracks success and failure counts', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'tool:result', payload: { toolName: 'search' } }),
        makeEvent({ type: 'tool:result', payload: { toolName: 'search' } }),
        makeEvent({ type: 'tool:error', payload: { toolName: 'search' } }),
      ])

      const { nodeMetrics } = useLiveTrace(events)
      const metrics = nodeMetrics.value.get('search')!

      expect(metrics.successCount).toBe(2)
      expect(metrics.failureCount).toBe(1)
      expect(metrics.successRate).toBeCloseTo(2 / 3)
    })

    it('tracks latency samples for sparklines', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'tool:result', payload: { toolName: 'search', durationMs: 30 } }),
        makeEvent({ type: 'tool:result', payload: { toolName: 'search', durationMs: 50 } }),
        makeEvent({ type: 'tool:result', payload: { toolName: 'search', durationMs: 40 } }),
      ])

      const { nodeMetrics } = useLiveTrace(events)
      expect(nodeMetrics.value.get('search')?.latencySamples).toEqual([30, 50, 40])
    })

    it('ignores non-tool non-memory events', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'agent:stream_delta', payload: { content: 'hello' } }),
        makeEvent({ type: 'pipeline:phase_changed', payload: { phase: 'planning' } }),
      ])

      const { nodeMetrics } = useLiveTrace(events)
      expect(nodeMetrics.value.size).toBe(0)
    })

    it('tracks memory operations in node metrics', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'memory:written', payload: { namespace: 'lessons', durationMs: 10 } }),
        makeEvent({ type: 'memory:searched', payload: { namespace: 'lessons', durationMs: 20 } }),
      ])

      const { nodeMetrics } = useLiveTrace(events)
      expect(nodeMetrics.value.get('lessons')?.callCount).toBe(2)
    })
  })

  // ── Token usage ────────────────────────────────────

  describe('tokenUsage', () => {
    it('returns zero for no events', () => {
      const events = ref<ReplayEvent[]>([])
      const { tokenUsage } = useLiveTrace(events)

      expect(tokenUsage.value.input).toBe(0)
      expect(tokenUsage.value.output).toBe(0)
      expect(tokenUsage.value.total).toBe(0)
    })

    it('sums promptTokens and completionTokens from payloads', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'llm:response', payload: { promptTokens: 100, completionTokens: 50 } }),
        makeEvent({ type: 'llm:response', payload: { promptTokens: 200, completionTokens: 80 } }),
      ])

      const { tokenUsage } = useLiveTrace(events)
      expect(tokenUsage.value.input).toBe(300)
      expect(tokenUsage.value.output).toBe(130)
      expect(tokenUsage.value.total).toBe(430)
    })

    it('sums inputTokens and outputTokens as alternative fields', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'llm:response', payload: { inputTokens: 150, outputTokens: 60 } }),
      ])

      const { tokenUsage } = useLiveTrace(events)
      expect(tokenUsage.value.input).toBe(150)
      expect(tokenUsage.value.output).toBe(60)
    })

    it('estimates output tokens from agent:stream_done finalContent', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({
          type: 'agent:stream_done',
          payload: { finalContent: 'A'.repeat(400) },
        }),
      ])

      const { tokenUsage } = useLiveTrace(events)
      // 400 chars / 4 = 100 tokens
      expect(tokenUsage.value.output).toBe(100)
    })
  })

  // ── Cost estimate ──────────────────────────────────

  describe('costEstimate', () => {
    it('returns 0 for no token usage', () => {
      const events = ref<ReplayEvent[]>([])
      const { costEstimate } = useLiveTrace(events)
      expect(costEstimate.value).toBe(0)
    })

    it('calculates cost from token usage', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({
          type: 'llm:response',
          payload: { promptTokens: 1000, completionTokens: 1000 },
        }),
      ])

      const { costEstimate } = useLiveTrace(events)
      // 1K input * $0.003 + 1K output * $0.015 = $0.018
      expect(costEstimate.value).toBeCloseTo(0.018)
    })
  })

  // ── Memory operations ──────────────────────────────

  describe('memoryOperations', () => {
    it('returns empty for no memory events', () => {
      const events = ref<ReplayEvent[]>([])
      const { memoryOperations } = useLiveTrace(events)
      expect(memoryOperations.value).toEqual([])
    })

    it('extracts write operations', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({
          type: 'memory:written',
          timestamp: '2026-01-01T00:00:00Z',
          payload: { namespace: 'lessons', durationMs: 15 },
        }),
      ])

      const { memoryOperations } = useLiveTrace(events)
      expect(memoryOperations.value.length).toBe(1)
      expect(memoryOperations.value[0]!.type).toBe('write')
      expect(memoryOperations.value[0]!.target).toBe('lessons')
      expect(memoryOperations.value[0]!.durationMs).toBe(15)
    })

    it('extracts search operations', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({
          type: 'memory:searched',
          payload: { namespace: 'conventions', resultCount: 3 },
        }),
      ])

      const { memoryOperations } = useLiveTrace(events)
      expect(memoryOperations.value.length).toBe(1)
      expect(memoryOperations.value[0]!.type).toBe('search')
      expect(memoryOperations.value[0]!.target).toBe('conventions')
    })

    it('extracts error operations', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({
          type: 'memory:error',
          payload: { namespace: 'broken', message: 'Connection refused' },
        }),
      ])

      const { memoryOperations } = useLiveTrace(events)
      expect(memoryOperations.value.length).toBe(1)
      expect(memoryOperations.value[0]!.type).toBe('error')
      expect(memoryOperations.value[0]!.target).toBe('broken')
    })

    it('ignores non-memory events', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'tool:called', payload: { toolName: 'search' } }),
        makeEvent({ type: 'agent:stream_delta', payload: { content: 'hi' } }),
      ])

      const { memoryOperations } = useLiveTrace(events)
      expect(memoryOperations.value.length).toBe(0)
    })
  })

  // ── currentNode ────────────────────────────────────

  describe('currentNode', () => {
    it('starts as null', () => {
      const events = ref<ReplayEvent[]>([])
      const { currentNode } = useLiveTrace(events)
      expect(currentNode.value).toBeNull()
    })

    it('can be set via setCurrentNode', () => {
      const events = ref<ReplayEvent[]>([])
      const { currentNode, setCurrentNode } = useLiveTrace(events)

      setCurrentNode('search')
      expect(currentNode.value).toBe('search')

      setCurrentNode(null)
      expect(currentNode.value).toBeNull()
    })
  })

  // ── Display name extraction ────────────────────────

  describe('event display names', () => {
    it('uses toolName from payload', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'tool:called', payload: { toolName: 'file_read' } }),
      ])

      const { timelineData } = useLiveTrace(events)
      expect(timelineData.value.events[0]!.name).toBe('file_read')
    })

    it('uses namespace for memory events', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'memory:written', payload: { namespace: 'lessons' } }),
      ])

      const { timelineData } = useLiveTrace(events)
      expect(timelineData.value.events[0]!.name).toContain('lessons')
    })

    it('truncates long content strings', () => {
      const longContent = 'A'.repeat(100)
      const events = ref<ReplayEvent[]>([
        makeEvent({
          type: 'agent:stream_delta',
          payload: { content: longContent },
        }),
      ])

      const { timelineData } = useLiveTrace(events)
      const name = timelineData.value.events[0]!.name
      expect(name.length).toBeLessThanOrEqual(53)
      expect(name.endsWith('...')).toBe(true)
    })

    it('uses phase from payload', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({
          type: 'pipeline:phase_changed',
          payload: { phase: 'planning' },
        }),
      ])

      const { timelineData } = useLiveTrace(events)
      expect(timelineData.value.events[0]!.name).toContain('planning')
    })

    it('falls back to event type for unknown events', () => {
      const events = ref<ReplayEvent[]>([
        makeEvent({ type: 'agent:started', payload: {} }),
      ])

      const { timelineData } = useLiveTrace(events)
      expect(timelineData.value.events[0]!.name).toBe('agent started')
    })
  })
})
