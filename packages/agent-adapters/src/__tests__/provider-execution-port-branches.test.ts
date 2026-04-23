import { describe, it, expect } from 'vitest'

import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import { RegistryExecutionPort } from '../integration/provider-execution-port.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'
import { collectEvents } from './test-helpers.js'

function createStreamingAdapter(
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
  }
}

describe('RegistryExecutionPort - branch coverage', () => {
  const task: TaskDescriptor = { prompt: 'test', tags: [] }
  const input: AgentInput = { prompt: 'test' }

  it('throws AGENT_ABORTED when signal is aborted mid-stream', async () => {
    const adapter = createStreamingAdapter('claude', [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: 1,
      },
      {
        type: 'adapter:message',
        providerId: 'claude',
        content: 'hi',
        role: 'assistant',
        timestamp: 2,
      },
      {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 's1',
        result: 'done',
        durationMs: 10,
        timestamp: 3,
      },
    ])
    const registry = new ProviderAdapterRegistry()
    registry.register(adapter)
    const port = new RegistryExecutionPort(registry)

    const controller = new AbortController()
    controller.abort()

    await expect(
      collectEvents(port.stream(input, task, { signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'AGENT_ABORTED' })
  })

  it('run() throws ALL_ADAPTERS_EXHAUSTED when no adapter completes', async () => {
    // Adapter that yields non-completion events only
    const adapter = createStreamingAdapter('claude', [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: 1,
      },
      {
        type: 'adapter:message',
        providerId: 'claude',
        content: 'hi',
        role: 'assistant',
        timestamp: 2,
      },
    ])
    const registry = new ProviderAdapterRegistry()
    registry.register(adapter)
    const port = new RegistryExecutionPort(registry)

    await expect(port.run(input, task)).rejects.toMatchObject({
      code: 'ALL_ADAPTERS_EXHAUSTED',
    })
  })

  it('run() returns completed content and provider', async () => {
    const adapter = createStreamingAdapter('codex', [
      {
        type: 'adapter:started',
        providerId: 'codex',
        sessionId: 's1',
        timestamp: 1,
      },
      {
        type: 'adapter:completed',
        providerId: 'codex',
        sessionId: 's1',
        result: 'output here',
        durationMs: 5,
        timestamp: 2,
      },
    ])
    const registry = new ProviderAdapterRegistry()
    registry.register(adapter)
    const port = new RegistryExecutionPort(registry)

    const result = await port.run(input, task)
    expect(result.content).toBe('output here')
    expect(result.providerId).toBe('codex')
    expect(result.attemptedProviders).toContain('codex')
    expect(result.fallbackAttempts).toBe(0)
  })

  it('stream() yields all events when signal not aborted', async () => {
    const adapter = createStreamingAdapter('claude', [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: 1,
      },
      {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 's1',
        result: 'done',
        durationMs: 10,
        timestamp: 2,
      },
    ])
    const registry = new ProviderAdapterRegistry()
    registry.register(adapter)
    const port = new RegistryExecutionPort(registry)

    const events = await collectEvents(port.stream(input, task))
    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  it('stream() works without bridge', async () => {
    const adapter = createStreamingAdapter('claude', [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: 1,
      },
      {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 's1',
        result: 'done',
        durationMs: 10,
        timestamp: 2,
      },
    ])
    const registry = new ProviderAdapterRegistry()
    registry.register(adapter)
    const port = new RegistryExecutionPort(registry)

    const events = await collectEvents(port.stream(input, task))
    expect(events).toBeDefined()
  })

  it('run() without options works', async () => {
    const adapter = createStreamingAdapter('claude', [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: 1,
      },
      {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 's1',
        result: 'r',
        durationMs: 1,
        timestamp: 2,
      },
    ])
    const registry = new ProviderAdapterRegistry()
    registry.register(adapter)
    const port = new RegistryExecutionPort(registry)

    const result = await port.run(input, task)
    expect(result.providerId).toBe('claude')
  })
})
