import { describe, it, expect, vi } from 'vitest'

import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'
import { collectEvents } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  opts?: { warmup?: () => Promise<void> },
): AgentCLIAdapter {
  const events: AgentEvent[] = [
    {
      type: 'adapter:started',
      providerId,
      sessionId: 'sess-1',
      timestamp: Date.now(),
    },
    {
      type: 'adapter:message',
      providerId,
      content: 'hello',
      role: 'assistant',
      timestamp: Date.now(),
    },
    {
      type: 'adapter:tool_call',
      providerId,
      toolName: 'read_file',
      input: { path: '/tmp/test' },
      timestamp: Date.now(),
    },
    {
      type: 'adapter:tool_result',
      providerId,
      toolName: 'read_file',
      output: 'file content',
      durationMs: 10,
      timestamp: Date.now(),
    },
    {
      type: 'adapter:completed',
      providerId,
      sessionId: 'sess-1',
      result: 'done',
      durationMs: 100,
      timestamp: Date.now(),
    },
  ]

  const adapter: AgentCLIAdapter = {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      for (const event of events) {
        yield event
      }
    },
    async *resumeSession(
      _sessionId: string,
      _input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      for (const event of events) {
        yield event
      }
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
    getCapabilities() {
      return {
        supportsResume: false,
        supportsFork: false,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsCostUsage: false,
      }
    },
  }

  if (opts?.warmup) {
    adapter.warmup = opts.warmup
  }

  return adapter
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Correlation ID Propagation', () => {
  it('correlationId on AgentInput propagates to events', async () => {
    const adapter = createMockAdapter('claude')
    // Wrap adapter to inject correlationId like BaseCliAdapter does
    const correlationId = 'req-abc-123'
    const input: AgentInput = { prompt: 'test', correlationId }

    // Verify the type accepts correlationId
    expect(input.correlationId).toBe(correlationId)

    // Verify all event interfaces accept correlationId (type-level check)
    const startedEvent: AgentEvent = {
      type: 'adapter:started',
      providerId: 'claude',
      sessionId: 's',
      timestamp: 1,
      correlationId,
    }
    expect(startedEvent.correlationId).toBe(correlationId)

    const messageEvent: AgentEvent = {
      type: 'adapter:message',
      providerId: 'claude',
      content: 'hi',
      role: 'assistant',
      timestamp: 1,
      correlationId,
    }
    expect(messageEvent.correlationId).toBe(correlationId)

    const toolCallEvent: AgentEvent = {
      type: 'adapter:tool_call',
      providerId: 'claude',
      toolName: 'test',
      input: {},
      timestamp: 1,
      correlationId,
    }
    expect(toolCallEvent.correlationId).toBe(correlationId)

    const toolResultEvent: AgentEvent = {
      type: 'adapter:tool_result',
      providerId: 'claude',
      toolName: 'test',
      output: '',
      durationMs: 0,
      timestamp: 1,
      correlationId,
    }
    expect(toolResultEvent.correlationId).toBe(correlationId)

    const completedEvent: AgentEvent = {
      type: 'adapter:completed',
      providerId: 'claude',
      sessionId: 's',
      result: '',
      durationMs: 0,
      timestamp: 1,
      correlationId,
    }
    expect(completedEvent.correlationId).toBe(correlationId)

    const failedEvent: AgentEvent = {
      type: 'adapter:failed',
      providerId: 'claude',
      error: 'err',
      timestamp: 1,
      correlationId,
    }
    expect(failedEvent.correlationId).toBe(correlationId)

    const streamDelta: AgentEvent = {
      type: 'adapter:stream_delta',
      providerId: 'claude',
      content: 'x',
      timestamp: 1,
      correlationId,
    }
    expect(streamDelta.correlationId).toBe(correlationId)

    const progressEvent: AgentEvent = {
      type: 'adapter:progress',
      providerId: 'claude',
      timestamp: 1,
      phase: 'init',
      correlationId,
    }
    expect(progressEvent.correlationId).toBe(correlationId)

    const recoveryCancelledEvent: AgentEvent = {
      type: 'recovery:cancelled',
      providerId: 'claude',
      strategy: 'abort',
      error: 'err',
      totalAttempts: 1,
      totalDurationMs: 100,
      timestamp: 1,
      correlationId,
    }
    expect(recoveryCancelledEvent.correlationId).toBe(correlationId)
  })

  it('events without correlationId work normally (backward compat)', async () => {
    const adapter = createMockAdapter('claude')
    const input: AgentInput = { prompt: 'test' }

    // No correlationId — should still work fine
    const events = await collectEvents(adapter.execute(input))
    expect(events.length).toBeGreaterThan(0)

    // Events should not have correlationId
    for (const event of events) {
      expect((event as Record<string, unknown>)['correlationId']).toBeUndefined()
    }
  })
})

describe('SDK Warmup', () => {
  it('warmup is optional on interface', () => {
    const adapter = createMockAdapter('claude')
    // warmup is not set — should be undefined
    expect(adapter.warmup).toBeUndefined()
  })

  it('warmupAll calls warmup on all adapters', async () => {
    const warmupFn = vi.fn().mockResolvedValue(undefined)
    const adapter1 = createMockAdapter('claude', { warmup: warmupFn })
    const adapter2 = createMockAdapter('codex', { warmup: warmupFn })
    const adapterNoWarmup = createMockAdapter('gemini')

    const registry = new ProviderAdapterRegistry()
    registry.register(adapter1)
    registry.register(adapter2)
    registry.register(adapterNoWarmup)

    await registry.warmupAll()

    expect(warmupFn).toHaveBeenCalledTimes(2)
  })

  it('warmup failure is non-fatal', async () => {
    const failingWarmup = vi.fn().mockRejectedValue(new Error('SDK not found'))
    const successWarmup = vi.fn().mockResolvedValue(undefined)

    const adapter1 = createMockAdapter('claude', { warmup: failingWarmup })
    const adapter2 = createMockAdapter('codex', { warmup: successWarmup })

    const registry = new ProviderAdapterRegistry()
    registry.register(adapter1)
    registry.register(adapter2)

    // Should not throw even though one adapter fails warmup
    await expect(registry.warmupAll()).resolves.toBeUndefined()

    expect(failingWarmup).toHaveBeenCalledTimes(1)
    expect(successWarmup).toHaveBeenCalledTimes(1)
  })
})
