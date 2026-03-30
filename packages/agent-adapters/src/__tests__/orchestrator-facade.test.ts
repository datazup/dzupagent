import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzipagent/core'
import type { DzipEvent, DzipEventBus } from '@dzipagent/core'

import {
  OrchestratorFacade,
  createOrchestrator,
} from '../facade/orchestrator-facade.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
  RoutingDecision,
} from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  result = `Result from ${providerId}`,
  delayMs = 0,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
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
        durationMs: delayMs || 10,
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

function collectBusEvents(bus: DzipEventBus): DzipEvent[] {
  const events: DzipEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrchestratorFacade', () => {
  let bus: DzipEventBus
  let emitted: DzipEvent[]
  let claudeAdapter: AgentCLIAdapter
  let codexAdapter: AgentCLIAdapter

  beforeEach(() => {
    bus = createEventBus()
    emitted = collectBusEvents(bus)
    claudeAdapter = createMockAdapter('claude', 'Claude result')
    codexAdapter = createMockAdapter('codex', 'Codex result')
  })

  describe('createOrchestrator', () => {
    it('creates an OrchestratorFacade instance', () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
      })

      expect(facade).toBeInstanceOf(OrchestratorFacade)
    })
  })

  describe('run()', () => {
    it('executes and returns result', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
      })

      const result = await facade.run('Fix the test')

      expect(result.result).toBe('Claude result')
      expect(result.providerId).toBe('claude')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('routes correctly with tags', async () => {
      // Use a custom router that routes 'fast' tasks to codex
      const customRouter = {
        name: 'test-router',
        route(_task: TaskDescriptor, available: AdapterProviderId[]): RoutingDecision {
          const hasFastTag = _task.tags.includes('fast')
          const provider = hasFastTag ? 'codex' : 'claude'
          return {
            provider: available.includes(provider) ? provider : available[0]!,
            reason: 'test',
            confidence: 1,
            fallbackProviders: available.filter((p) => p !== provider),
          }
        },
      }

      const facade = createOrchestrator({
        adapters: [claudeAdapter, codexAdapter],
        eventBus: bus,
        router: customRouter,
      })

      const result = await facade.run('Quick task', { tags: ['fast'] })

      expect(result.providerId).toBe('codex')
      expect(result.result).toBe('Codex result')
    })

    it('returns usage info from completed events', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
      })

      const result = await facade.run('Test usage')

      expect(result.usage).toBeDefined()
      expect(result.usage!.inputTokens).toBe(100)
      expect(result.usage!.outputTokens).toBe(50)
    })

    it('throws when stream ends without adapter:completed event', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
      })

      ;(facade as unknown as { _registry: { executeWithFallback: (...args: unknown[]) => AsyncGenerator<AgentEvent, void, undefined> } })
        ._registry.executeWithFallback = (async function *(): AsyncGenerator<AgentEvent, void, undefined> {
          yield {
            type: 'adapter:started',
            providerId: 'claude',
            sessionId: 'sess-claude',
            timestamp: Date.now(),
          }
        }) as (...args: unknown[]) => AsyncGenerator<AgentEvent, void, undefined>

      await expect(facade.run('incomplete stream')).rejects.toThrow('No adapter:completed event observed')
    })
  })

  describe('supervisor()', () => {
    it('delegates goal and returns supervisor result', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
      })

      const result = await facade.supervisor('Implement feature. Test it.')

      expect(result.goal).toBe('Implement feature. Test it.')
      expect(result.subtaskResults.length).toBeGreaterThan(0)
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('parallel()', () => {
    it('runs on multiple providers', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter, codexAdapter],
        eventBus: bus,
      })

      const result = await facade.parallel('Fix the test')

      expect(result.allResults.length).toBeGreaterThanOrEqual(1)
      expect(result.selectedResult).toBeDefined()
    })

    it('runs on specific providers when specified', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter, codexAdapter],
        eventBus: bus,
      })

      const result = await facade.parallel('Fix test', {
        providers: ['codex'],
      })

      // Only codex should be in results
      const providerIds = result.allResults.map((r) => r.providerId)
      expect(providerIds).toContain('codex')
    })
  })

  describe('race()', () => {
    it('returns first result', async () => {
      const fastAdapter = createMockAdapter('codex', 'Fast result', 5)
      const slowAdapter = createMockAdapter('claude', 'Slow result', 50)

      const facade = createOrchestrator({
        adapters: [slowAdapter, fastAdapter],
        eventBus: bus,
      })

      const result = await facade.race('Fix the test', ['claude', 'codex'])

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })
  })

  describe('bid()', () => {
    it('runs contract-net bidding', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter, codexAdapter],
        eventBus: bus,
      })

      const result = await facade.bid('Fix the failing test')

      expect(result).toBeDefined()
      expect(result.winningBid).toBeDefined()
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('chat()', () => {
    it('yields events with session tracking', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
      })

      const events: AgentEvent[] = []
      for await (const event of facade.chat('Hello')) {
        events.push(event)
      }

      expect(events.length).toBeGreaterThan(0)
      const eventTypes = events.map((e) => e.type)
      expect(eventTypes).toContain('adapter:started')
      expect(eventTypes).toContain('adapter:completed')
    })

    it('resumes with workflowId', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
      })

      // First turn
      const events1: AgentEvent[] = []
      let workflowId: string | undefined
      for await (const event of facade.chat('Turn 1')) {
        events1.push(event)
      }

      // Get the workflow from sessions
      const workflows = facade.sessions.listWorkflows()
      expect(workflows.length).toBeGreaterThan(0)
      workflowId = workflows[0]!.workflowId

      // Second turn with same workflow
      const events2: AgentEvent[] = []
      for await (const event of facade.chat('Turn 2', { workflowId })) {
        events2.push(event)
      }

      expect(events2.length).toBeGreaterThan(0)
    })
  })

  describe('getCostReport()', () => {
    it('returns cost data when cost tracking is enabled', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
        enableCostTracking: true,
      })

      // Execute something to generate cost data
      await facade.run('Test')

      const report = facade.getCostReport()

      expect(report).toBeDefined()
      expect(report!.totalCostCents).toBeGreaterThanOrEqual(0)
    })

    it('returns undefined when cost tracking is disabled', () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
        enableCostTracking: false,
      })

      const report = facade.getCostReport()

      expect(report).toBeUndefined()
    })
  })

  describe('accessor properties', () => {
    it('registry accessor works', () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
      })

      const registry = facade.registry

      expect(registry).toBeDefined()
      expect(registry.listAdapters()).toContain('claude')
    })

    it('sessions accessor works', () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
      })

      const sessions = facade.sessions

      expect(sessions).toBeDefined()
      // Should be able to create a workflow
      const id = sessions.createWorkflow()
      expect(typeof id).toBe('string')
    })

    it('costTracking accessor works', () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
        enableCostTracking: true,
      })

      expect(facade.costTracking).toBeDefined()
    })
  })

  describe('event bus integration', () => {
    it('uses provided event bus', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
      })

      await facade.run('Test')

      // Should have emitted events on the bus
      expect(emitted.length).toBeGreaterThan(0)
    })

    it('creates its own event bus when none provided', () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
      })

      // Should not throw
      expect(facade.registry).toBeDefined()
    })
  })
})
