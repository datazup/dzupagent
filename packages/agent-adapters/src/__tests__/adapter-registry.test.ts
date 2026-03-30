import { describe, it, expect } from 'vitest'

import { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
  RoutingDecision,
} from '../types.js'
import { collectEvents } from './test-helpers.js'

function createMockAdapter(
  providerId: AdapterProviderId,
  events: AgentEvent[],
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      for (const event of events) {
        yield event
      }
    },
    async *resumeSession(_sessionId: string, _input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      for (const event of events) {
        yield event
      }
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

describe('AdapterRegistry', () => {
  const task: TaskDescriptor = {
    prompt: 'test task',
    tags: [],
  }
  const input: AgentInput = {
    prompt: 'test input',
  }

  const router = {
    name: 'test-router',
    route(_task: TaskDescriptor, _available: AdapterProviderId[]): RoutingDecision {
      return {
        provider: 'claude',
        reason: 'test',
        confidence: 1,
        fallbackProviders: ['codex'],
      }
    },
  }

  it('continues fallback when adapter emits failed event without throwing', async () => {
    const failedOnly = createMockAdapter('claude', [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: Date.now(),
      },
      {
        type: 'adapter:failed',
        providerId: 'claude',
        sessionId: 's1',
        error: 'provider failed',
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: Date.now(),
      },
    ])

    const succeeds = createMockAdapter('codex', [
      {
        type: 'adapter:started',
        providerId: 'codex',
        sessionId: 's2',
        timestamp: Date.now(),
      },
      {
        type: 'adapter:completed',
        providerId: 'codex',
        sessionId: 's2',
        result: 'ok',
        durationMs: 10,
        timestamp: Date.now(),
      },
    ])

    const registry = new AdapterRegistry().setRouter(router)
    registry.register(failedOnly).register(succeeds)

    const events = await collectEvents(registry.executeWithFallback(input, task))
    const failed = events.find((e) => e.type === 'adapter:failed' && e.providerId === 'claude')
    const completed = events.find((e) => e.type === 'adapter:completed' && e.providerId === 'codex')

    expect(failed).toBeDefined()
    expect(completed).toBeDefined()
  })

  it('synthesizes failure and falls back when stream ends without completion', async () => {
    const nonTerminal = createMockAdapter('claude', [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: Date.now(),
      },
      {
        type: 'adapter:message',
        providerId: 'claude',
        content: 'partial output',
        role: 'assistant',
        timestamp: Date.now(),
      },
    ])

    const succeeds = createMockAdapter('codex', [
      {
        type: 'adapter:completed',
        providerId: 'codex',
        sessionId: 's2',
        result: 'fallback ok',
        durationMs: 10,
        timestamp: Date.now(),
      },
    ])

    const registry = new AdapterRegistry().setRouter(router)
    registry.register(nonTerminal).register(succeeds)

    const events = await collectEvents(registry.executeWithFallback(input, task))
    const syntheticFailure = events.find(
      (e) =>
        e.type === 'adapter:failed'
        && e.providerId === 'claude'
        && e.code === 'MISSING_TERMINAL_COMPLETION',
    )
    const completed = events.find((e) => e.type === 'adapter:completed' && e.providerId === 'codex')

    expect(syntheticFailure).toBeDefined()
    expect(completed).toBeDefined()
  })

  it('throws when no adapter reaches terminal completion', async () => {
    const nonTerminalClaude = createMockAdapter('claude', [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: Date.now(),
      },
    ])
    const nonTerminalCodex = createMockAdapter('codex', [
      {
        type: 'adapter:started',
        providerId: 'codex',
        sessionId: 's2',
        timestamp: Date.now(),
      },
    ])

    const registry = new AdapterRegistry().setRouter(router)
    registry.register(nonTerminalClaude).register(nonTerminalCodex)

    await expect(collectEvents(registry.executeWithFallback(input, task))).rejects.toThrow(
      'All adapters failed',
    )
  })
})
