import { describe, it, expect, vi } from 'vitest'
import { createEventBus, ForgeError } from '@dzupagent/core'

import { AdapterRegistry } from '../registry/adapter-registry.js'
import { EventBusBridge } from '../registry/event-bus-bridge.js'
import { RegistryExecutionPort } from '../integration/provider-execution-port.js'
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

function createAbortingAdapter(providerId: AdapterProviderId): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: 'sess-abort',
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:failed',
        providerId,
        error: 'cancelled',
        code: 'AGENT_ABORTED',
        timestamp: Date.now(),
      }
      throw new ForgeError({
        code: 'AGENT_ABORTED',
        message: 'cancelled',
        recoverable: true,
      })
    },
    async *resumeSession(_sessionId: string, _input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      return
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

  it('stops fallback and propagates AGENT_ABORTED without classifying it as generic failure', async () => {
    const aborted = createAbortingAdapter('claude')
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
    registry.register(aborted).register(succeeds)

    const yielded: AgentEvent[] = []
    await expect((async () => {
      for await (const event of registry.executeWithFallback(input, task)) {
        yielded.push(event)
      }
    })()).rejects.toMatchObject({ code: 'AGENT_ABORTED' })

    expect(yielded.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:failed',
    ])
    expect(yielded.some((e) => e.type === 'adapter:completed' && e.providerId === 'codex')).toBe(false)
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

describe('RegistryExecutionPort', () => {
  const task: TaskDescriptor = {
    prompt: 'test task',
    tags: [],
  }
  const input: AgentInput = {
    prompt: 'test input',
  }

  const router = {
    name: 'test-router',
    route(_task: TaskDescriptor, available: AdapterProviderId[]): RoutingDecision {
      return {
        provider: available[0] ?? 'claude',
        reason: 'test',
        confidence: 1,
        fallbackProviders: available.slice(1),
      }
    },
  }

  function makeMockAdapter(
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

  it('runs task and returns ProviderExecutionResult on success', async () => {
    const adapter = makeMockAdapter('claude', [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: Date.now(),
      },
      {
        type: 'adapter:message',
        providerId: 'claude',
        content: 'partial',
        role: 'assistant',
        timestamp: Date.now(),
      },
      {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 's1',
        result: 'final result',
        durationMs: 100,
        timestamp: Date.now(),
      },
    ])

    const registry = new AdapterRegistry().setRouter(router)
    registry.register(adapter)

    const port = new RegistryExecutionPort(registry)
    const result = await port.run(input, task)

    expect(result.content).toBe('final result')
    expect(result.providerId).toBe('claude')
    expect(result.attemptedProviders).toContain('claude')
    expect(result.fallbackAttempts).toBe(0)
  })

  it('throws ALL_ADAPTERS_EXHAUSTED when no adapter completes', async () => {
    const failAdapter = makeMockAdapter('claude', [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: Date.now(),
      },
      {
        type: 'adapter:failed',
        providerId: 'claude',
        error: 'model error',
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: Date.now(),
      },
    ])

    const registry = new AdapterRegistry().setRouter(router)
    registry.register(failAdapter)

    const port = new RegistryExecutionPort(registry)

    await expect(port.run(input, task)).rejects.toThrow('All adapters failed')
  })

  it('streams events through EventBusBridge when bridge is provided', async () => {
    const adapter = makeMockAdapter('claude', [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: Date.now(),
      },
      {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 's1',
        result: 'done',
        durationMs: 50,
        timestamp: Date.now(),
      },
    ])

    const registry = new AdapterRegistry().setRouter(router)
    registry.register(adapter)

    const eventBus = createEventBus()
    const emitted: unknown[] = []
    eventBus.onAny((event) => emitted.push(event))

    const bridge = new EventBusBridge(eventBus)
    const port = new RegistryExecutionPort(registry, bridge)

    const events = await collectEvents(port.stream(input, task, { runId: 'run-1' }))

    // Original events still yielded
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.some((e) => e.type === 'adapter:completed')).toBe(true)

    // Bridge emitted DzupEvents on the bus
    expect(emitted.some((e: any) => e.type === 'agent:started')).toBe(true)
    expect(emitted.some((e: any) => e.type === 'agent:completed')).toBe(true)
  })

  it('collects attempted providers across fallback chain', async () => {
    const failClaude = makeMockAdapter('claude', [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: Date.now(),
      },
      {
        type: 'adapter:failed',
        providerId: 'claude',
        error: 'timeout',
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: Date.now(),
      },
    ])

    const successCodex = makeMockAdapter('codex', [
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
        result: 'codex result',
        durationMs: 200,
        timestamp: Date.now(),
      },
    ])

    const registry = new AdapterRegistry().setRouter(router)
    registry.register(failClaude).register(successCodex)

    const port = new RegistryExecutionPort(registry)
    const result = await port.run(input, task)

    expect(result.providerId).toBe('codex')
    expect(result.content).toBe('codex result')
    expect(result.attemptedProviders).toContain('claude')
    expect(result.attemptedProviders).toContain('codex')
    expect(result.fallbackAttempts).toBe(1)
  })
})
