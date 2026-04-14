import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'

import {
  OrchestratorFacade,
  createOrchestrator,
} from '../facade/orchestrator-facade.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  result = `Result from ${providerId}`,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: `sess-${providerId}`,
        result,
        usage: { inputTokens: 100, outputTokens: 50 },
        durationMs: 10,
        timestamp: Date.now(),
      }
    },
    async *resumeSession(
      _id: string,
      _input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `resumed-sess-${providerId}`,
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: `resumed-sess-${providerId}`,
        result: `Resumed: ${result}`,
        usage: { inputTokens: 50, outputTokens: 25 },
        durationMs: 5,
        timestamp: Date.now(),
      }
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrchestratorFacade shutdown', () => {
  let bus: DzupEventBus
  let facade: OrchestratorFacade

  beforeEach(() => {
    bus = createEventBus()
    facade = createOrchestrator({
      adapters: [createMockAdapter('claude'), createMockAdapter('codex')],
      eventBus: bus,
    })
  })

  it('isReady() returns true before shutdown', () => {
    expect(facade.isReady()).toBe(true)
  })

  it('isReady() returns false after shutdown', async () => {
    await facade.shutdown()
    expect(facade.isReady()).toBe(false)
  })

  it('shutdown() can be called multiple times safely', async () => {
    await facade.shutdown()
    await facade.shutdown()
    await facade.shutdown()
    expect(facade.isReady()).toBe(false)
  })

  it('shutdown() prevents new requests via run()', async () => {
    await facade.shutdown()
    await expect(facade.run('test')).rejects.toThrow('Orchestrator has been shut down')
  })

  it('run() throws a ForgeError with AGENT_ABORTED code after shutdown', async () => {
    await facade.shutdown()
    try {
      await facade.run('test')
      expect.unreachable('should have thrown')
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe('AGENT_ABORTED')
    }
  })

  it('supervisor() throws after shutdown', async () => {
    await facade.shutdown()
    await expect(facade.supervisor('goal')).rejects.toThrow('Orchestrator has been shut down')
  })

  it('parallel() throws after shutdown', async () => {
    await facade.shutdown()
    await expect(facade.parallel('prompt')).rejects.toThrow('Orchestrator has been shut down')
  })

  it('race() throws after shutdown', async () => {
    await facade.shutdown()
    await expect(facade.race('prompt')).rejects.toThrow('Orchestrator has been shut down')
  })

  it('mapReduce() throws after shutdown', async () => {
    await facade.shutdown()
    await expect(
      facade.mapReduce('input', {
        chunker: { split: () => ['a'] },
        mapper: (chunk: string) => ({
          input: { prompt: chunk },
          task: { prompt: chunk, tags: [] },
        }),
        resultExtractor: (raw: string) => raw,
        reducer: (results) => results.length,
      }),
    ).rejects.toThrow('Orchestrator has been shut down')
  })

  it('bid() throws after shutdown', async () => {
    await facade.shutdown()
    await expect(facade.bid('prompt')).rejects.toThrow('Orchestrator has been shut down')
  })

  it('chat() throws after shutdown', async () => {
    await facade.shutdown()

    const gen = facade.chat('hello')
    await expect(gen.next()).rejects.toThrow('Orchestrator has been shut down')
  })

  it('shutdown() resets cost tracking', async () => {
    // Run something to accumulate cost
    await facade.run('generate cost data')

    const reportBefore = facade.getCostReport()
    expect(reportBefore).toBeDefined()

    await facade.shutdown()

    // Cost tracking should have been reset — but we cannot call getCostReport
    // after shutdown since the middleware object still exists. We verify that
    // the reset was called by checking the total is zeroed.
    const reportAfter = facade.costTracking?.getUsage()
    expect(reportAfter?.totalCostCents).toBe(0)
  })
})
