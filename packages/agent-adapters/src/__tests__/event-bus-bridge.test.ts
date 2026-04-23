import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import { EventBusBridge } from '../registry/event-bus-bridge.js'
import type {
  AgentEvent,
  AgentStartedEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentRecoveryCancelledEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentStreamDeltaEvent,
  AgentMessageEvent,
  AgentProgressEvent,
  AgentSkillsCompiledEvent,
  AgentMemoryRecalledEvent,
} from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* yieldEvents(events: AgentEvent[]): AsyncGenerator<AgentEvent, void, undefined> {
  for (const e of events) yield e
}

async function collectAll<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of gen) items.push(item)
  return items
}

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventBusBridge', () => {
  const RUN_ID = 'test-run-123'

  describe('bridge()', () => {
    it('bridges adapter:started to agent:started', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const startedEvent: AgentStartedEvent = {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 'sess-1',
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([startedEvent]), RUN_ID))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toEqual({
        type: 'agent:started',
        agentId: 'claude',
        runId: RUN_ID,
      })
    })

    it('bridges adapter:completed to agent:completed', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const completedEvent: AgentCompletedEvent = {
        type: 'adapter:completed',
        providerId: 'gemini',
        sessionId: 'sess-2',
        result: 'done',
        durationMs: 500,
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([completedEvent]), RUN_ID))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toEqual({
        type: 'agent:completed',
        agentId: 'gemini',
        runId: RUN_ID,
        durationMs: 500,
      })
    })

    it('forwards adapter:completed usage onto agent:completed when present', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const completedEvent: AgentCompletedEvent = {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 'sess-usage',
        result: 'ok',
        usage: { inputTokens: 120, outputTokens: 42, cachedInputTokens: 8, costCents: 3 },
        durationMs: 700,
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([completedEvent]), RUN_ID))

      expect(emitted).toHaveLength(1)
      const event = emitted[0] as unknown as {
        type: string
        agentId: string
        runId: string
        durationMs: number
        usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; costCents?: number }
      }
      expect(event.type).toBe('agent:completed')
      expect(event.agentId).toBe('claude')
      expect(event.runId).toBe(RUN_ID)
      expect(event.durationMs).toBe(700)
      expect(event.usage).toEqual({
        inputTokens: 120,
        outputTokens: 42,
        cachedInputTokens: 8,
        costCents: 3,
      })
    })

    it('omits usage on agent:completed when adapter does not report token counts', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const completedEvent: AgentCompletedEvent = {
        type: 'adapter:completed',
        providerId: 'codex',
        sessionId: 'sess-no-usage',
        result: 'ok',
        durationMs: 250,
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([completedEvent]), RUN_ID))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).not.toHaveProperty('usage')
    })

    it('bridges adapter:failed to agent:failed', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const failedEvent: AgentFailedEvent = {
        type: 'adapter:failed',
        providerId: 'codex',
        error: 'timeout',
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([failedEvent]), RUN_ID))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toEqual({
        type: 'agent:failed',
        agentId: 'codex',
        runId: RUN_ID,
        errorCode: 'ADAPTER_EXECUTION_FAILED',
        message: 'timeout',
      })
    })

    it('preserves AGENT_ABORTED when bridging adapter:failed', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const failedEvent: AgentFailedEvent = {
        type: 'adapter:failed',
        providerId: 'codex',
        error: 'cancelled',
        code: 'AGENT_ABORTED',
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([failedEvent]), RUN_ID))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toEqual({
        type: 'agent:failed',
        agentId: 'codex',
        runId: RUN_ID,
        errorCode: 'AGENT_ABORTED',
        message: 'cancelled',
      })
    })

    it('bridges recovery:cancelled to a typed recovery event', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const cancelledEvent: AgentRecoveryCancelledEvent = {
        type: 'recovery:cancelled',
        providerId: 'claude',
        strategy: 'abort',
        error: 'cancelled',
        totalAttempts: 1,
        totalDurationMs: 42,
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([cancelledEvent]), RUN_ID))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({
        type: 'recovery:cancelled',
        agentId: 'claude',
        runId: RUN_ID,
        attempts: 1,
        durationMs: 42,
        reason: 'cancelled',
      })
    })

    it('bridges adapter:tool_call to tool:called', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const toolCallEvent: AgentToolCallEvent = {
        type: 'adapter:tool_call',
        providerId: 'claude',
        toolName: 'read_file',
        input: { path: '/tmp/test.ts' },
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([toolCallEvent]), RUN_ID))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toEqual({
        type: 'tool:called',
        toolName: 'read_file',
        input: { path: '/tmp/test.ts' },
        executionRunId: RUN_ID,
      })
    })

    it('bridges adapter:tool_result to tool:result', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const toolResultEvent: AgentToolResultEvent = {
        type: 'adapter:tool_result',
        providerId: 'claude',
        toolName: 'write_file',
        output: 'ok',
        durationMs: 42,
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([toolResultEvent]), RUN_ID))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toEqual({
        type: 'tool:result',
        toolName: 'write_file',
        durationMs: 42,
        executionRunId: RUN_ID,
      })
    })

    it('throws when adapter:tool_result is bridged with an empty run id', async () => {
      const bus = createEventBus()
      const bridge = new EventBusBridge(bus)

      const toolResultEvent: AgentToolResultEvent = {
        type: 'adapter:tool_result',
        providerId: 'claude',
        toolName: 'write_file',
        output: 'ok',
        durationMs: 42,
        timestamp: Date.now(),
      }

      await expect(
        collectAll(bridge.bridge(yieldEvents([toolResultEvent]), '')),
      ).rejects.toThrow('Missing executionRunId for tool:result (write_file).')
    })

    it('emits tool:error when adapter fails during an active tool call', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const toolCallEvent: AgentToolCallEvent = {
        type: 'adapter:tool_call',
        providerId: 'claude',
        toolName: 'write_file',
        input: { path: '/tmp/test.ts' },
        timestamp: Date.now(),
      }
      const failedEvent: AgentFailedEvent = {
        type: 'adapter:failed',
        providerId: 'claude',
        error: 'write denied',
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([toolCallEvent, failedEvent]), RUN_ID))

      const toolError = emitted.find((event) => event.type === 'tool:error') as
        | Extract<DzupEvent, { type: 'tool:error' }>
        | undefined
      const agentFailed = emitted.find((event) => event.type === 'agent:failed') as
        | Extract<DzupEvent, { type: 'agent:failed' }>
        | undefined

      expect(toolError).toEqual({
        type: 'tool:error',
        toolName: 'write_file',
        errorCode: 'TOOL_EXECUTION_FAILED',
        message: 'write denied',
        executionRunId: RUN_ID,
      })
      expect(agentFailed?.message).toBe('write denied')
    })

    it('throws when tool:error is bridged with an empty run id', async () => {
      const bus = createEventBus()
      const bridge = new EventBusBridge(bus)

      const toolCallEvent: AgentToolCallEvent = {
        type: 'adapter:tool_call',
        providerId: 'claude',
        toolName: 'write_file',
        input: { path: '/tmp/test.ts' },
        timestamp: Date.now(),
      }
      const failedEvent: AgentFailedEvent = {
        type: 'adapter:failed',
        providerId: 'claude',
        error: 'write denied',
        timestamp: Date.now(),
      }

      await expect(
        collectAll(bridge.bridge(yieldEvents([toolCallEvent, failedEvent]), '')),
      ).rejects.toThrow('Missing executionRunId for tool:error (write_file).')
    })

    it('bridges adapter:stream_delta to agent:stream_delta', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const streamEvent: AgentStreamDeltaEvent = {
        type: 'adapter:stream_delta',
        providerId: 'qwen',
        content: 'hello ',
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([streamEvent]), RUN_ID))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toEqual({
        type: 'agent:stream_delta',
        agentId: 'qwen',
        runId: RUN_ID,
        content: 'hello ',
      })
    })

    it('bridges adapter:message to agent:stream_delta', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const msgEvent: AgentMessageEvent = {
        type: 'adapter:message',
        providerId: 'crush',
        content: 'thinking...',
        role: 'assistant',
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([msgEvent]), RUN_ID))

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toEqual({
        type: 'agent:stream_delta',
        agentId: 'crush',
        runId: RUN_ID,
        content: 'thinking...',
      })
    })

    it('yields original events unchanged (pass-through)', async () => {
      const bus = createEventBus()
      const bridge = new EventBusBridge(bus)

      const originalEvents: AgentEvent[] = [
        {
          type: 'adapter:started',
          providerId: 'claude',
          sessionId: 'sess-1',
          timestamp: 1000,
        },
        {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: 'sess-1',
          result: 'done',
          durationMs: 100,
          timestamp: 2000,
        },
      ]

      const yielded = await collectAll(bridge.bridge(yieldEvents(originalEvents), RUN_ID))

      expect(yielded).toHaveLength(2)
      expect(yielded[0]).toBe(originalEvents[0])
      expect(yielded[1]).toBe(originalEvents[1])
    })

    it('generates runId when not provided', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const startedEvent: AgentStartedEvent = {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 'sess-1',
        timestamp: Date.now(),
      }

      await collectAll(bridge.bridge(yieldEvents([startedEvent])))

      expect(emitted).toHaveLength(1)
      const event = emitted[0] as { type: string; runId: string }
      expect(event.runId).toBeDefined()
      expect(typeof event.runId).toBe('string')
      expect(event.runId.length).toBeGreaterThan(0)
    })

    it('bridges multiple events in sequence', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const events: AgentEvent[] = [
        { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 },
        { type: 'adapter:tool_call', providerId: 'claude', toolName: 'bash', input: 'ls', timestamp: 2 },
        { type: 'adapter:tool_result', providerId: 'claude', toolName: 'bash', output: 'ok', durationMs: 10, timestamp: 3 },
        { type: 'adapter:completed', providerId: 'claude', sessionId: 's1', result: 'done', durationMs: 50, timestamp: 4 },
      ]

      await collectAll(bridge.bridge(yieldEvents(events), RUN_ID))

      expect(emitted).toHaveLength(4)
      expect(emitted.map((e) => e.type)).toEqual([
        'agent:started',
        'tool:called',
        'tool:result',
        'agent:completed',
      ])
    })
  })

  describe('mapToDzupEvent()', () => {
    it('returns null for unknown event types', () => {
      // Use a type assertion to simulate an unknown event type
      const unknownEvent = { type: 'adapter:unknown', providerId: 'claude', timestamp: 1 } as unknown as AgentEvent
      const result = EventBusBridge.mapToDzupEvent(unknownEvent, RUN_ID)
      expect(result).toBeNull()
    })

    it('returns null for adapter:skills_compiled (explicit no-op)', () => {
      const event: AgentSkillsCompiledEvent = {
        type: 'adapter:skills_compiled',
        providerId: 'claude',
        timestamp: Date.now(),
        skills: [{ skillId: 'code-review', degraded: [], dropped: [] }],
        durationMs: 0,
      }
      const result = EventBusBridge.mapToDzupEvent(event, RUN_ID)
      expect(result).toBeNull()
    })

    it('returns null for adapter:memory_recalled (explicit no-op)', () => {
      const event: AgentMemoryRecalledEvent = {
        type: 'adapter:memory_recalled',
        providerId: 'claude',
        timestamp: Date.now(),
        entries: [{ level: 'project', name: 'tech-stack', tokenEstimate: 100 }],
        totalTokens: 100,
        durationMs: 0,
      }
      const result = EventBusBridge.mapToDzupEvent(event, RUN_ID)
      expect(result).toBeNull()
    })

    it('adapter:skills_compiled is yielded as pass-through but not emitted on bus', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const skillsEvent: AgentSkillsCompiledEvent = {
        type: 'adapter:skills_compiled',
        providerId: 'claude',
        timestamp: Date.now(),
        skills: [{ skillId: 'my-skill', degraded: [], dropped: [] }],
        durationMs: 0,
      }

      const yielded = await collectAll(bridge.bridge(yieldEvents([skillsEvent]), RUN_ID))

      // The original event is still yielded (pass-through)
      expect(yielded).toHaveLength(1)
      expect(yielded[0]).toBe(skillsEvent)
      // But no DzupEvent is emitted on the bus (mapToDzupEvent returns null)
      expect(emitted).toHaveLength(0)
    })

    it('maps adapter:progress to agent:progress on the core bus', () => {
      const progressEvent: AgentProgressEvent = {
        type: 'adapter:progress',
        providerId: 'claude',
        phase: 'tool_execution',
        percentage: 50,
        message: 'Running tool 3/6',
        timestamp: Date.now(),
      }
      const result = EventBusBridge.mapToDzupEvent(progressEvent, RUN_ID)
      expect(result).toEqual({
        type: 'agent:progress',
        agentId: 'claude',
        phase: 'tool_execution',
        percentage: 50,
        message: 'Running tool 3/6',
        timestamp: progressEvent.timestamp,
      })
    })

    it('emits agent:progress bus events for adapter:progress', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const bridge = new EventBusBridge(bus)

      const progressEvent: AgentProgressEvent = {
        type: 'adapter:progress',
        providerId: 'claude',
        phase: 'thinking',
        timestamp: Date.now(),
      }

      const yielded = await collectAll(bridge.bridge(yieldEvents([progressEvent]), RUN_ID))

      // The original event is still yielded (pass-through)
      expect(yielded).toHaveLength(1)
      expect(yielded[0]).toBe(progressEvent)
      // Progress is now bridged to the core bus
      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({
        type: 'agent:progress',
        agentId: 'claude',
        phase: 'thinking',
      })
    })
  })
})
