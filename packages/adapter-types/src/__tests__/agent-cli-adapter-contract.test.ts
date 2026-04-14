import { describe, expect, it } from 'vitest'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
  SessionInfo,
} from '../index.js'

class MockAdapter implements AgentCLIAdapter {
  readonly providerId = 'claude' as const

  private config: AdapterConfig = {}
  private interrupted = false

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      maxContextTokens: 200_000,
    }
  }

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  interrupt(): void {
    this.interrupted = true
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: true,
      providerId: this.providerId,
      sdkInstalled: true,
      cliAvailable: true,
      lastSuccessTimestamp: Date.now(),
    }
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const now = Date.now()
    const sessionId = input.resumeSessionId ?? 'mock-session-1'

    yield {
      type: 'adapter:started',
      providerId: this.providerId,
      sessionId,
      timestamp: now,
      model: this.config.model,
      workingDirectory: input.workingDirectory ?? this.config.workingDirectory,
      isResume: Boolean(input.resumeSessionId),
      correlationId: input.correlationId,
    }

    yield {
      type: 'adapter:stream_delta',
      providerId: this.providerId,
      content: this.interrupted ? 'interrupted' : 'working',
      timestamp: now + 1,
      correlationId: input.correlationId,
    }

    yield {
      type: 'adapter:completed',
      providerId: this.providerId,
      sessionId,
      result: this.interrupted ? 'cancelled' : 'ok',
      durationMs: 10,
      timestamp: now + 2,
      correlationId: input.correlationId,
      usage: {
        inputTokens: 16,
        outputTokens: 8,
        costCents: 3,
      },
    }
  }

  resumeSession(sessionId: string, input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    return this.execute({ ...input, resumeSessionId: sessionId })
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [
      {
        sessionId: 'mock-session-1',
        providerId: this.providerId,
        createdAt: new Date('2026-04-03T09:00:00.000Z'),
        lastActiveAt: new Date('2026-04-03T09:01:00.000Z'),
      },
    ]
  }
}

async function collectEvents(stream: AsyncGenerator<AgentEvent, void, undefined>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

describe('AgentCLIAdapter contract fixture', () => {
  it('produces a typed event lifecycle from execute()', async () => {
    const adapter = new MockAdapter()
    adapter.configure({ model: 'claude-sonnet', workingDirectory: '/workspace' })

    const events = await collectEvents(
      adapter.execute({
        prompt: 'Run a quick analysis',
        correlationId: 'corr-100',
      }),
    )

    expect(events).toHaveLength(3)
    expect(events[0]?.type).toBe('adapter:started')
    expect(events[1]?.type).toBe('adapter:stream_delta')
    expect(events[2]?.type).toBe('adapter:completed')

    const started = events[0]
    if (started?.type === 'adapter:started') {
      expect(started.model).toBe('claude-sonnet')
      expect(started.correlationId).toBe('corr-100')
    }
  })

  it('supports resumeSession() and optional listSessions()', async () => {
    const adapter = new MockAdapter()
    const events = await collectEvents(
      adapter.resumeSession('existing-session', {
        prompt: 'Continue from context',
        correlationId: 'corr-200',
      }),
    )

    expect(events[0]).toMatchObject({
      type: 'adapter:started',
      sessionId: 'existing-session',
      isResume: true,
    })

    const sessions = await adapter.listSessions?.()
    expect(sessions).toHaveLength(1)
    expect(sessions?.[0]?.sessionId).toBe('mock-session-1')
  })

  it('exposes health and interrupt behavior through the interface contract', async () => {
    const adapter = new MockAdapter()
    const health = await adapter.healthCheck()
    expect(health.healthy).toBe(true)
    expect(adapter.getCapabilities().supportsResume).toBe(true)

    adapter.interrupt()
    const events = await collectEvents(
      adapter.execute({
        prompt: 'Check interrupt status',
      }),
    )

    expect(events[1]).toMatchObject({
      type: 'adapter:stream_delta',
      content: 'interrupted',
    })
  })
})

