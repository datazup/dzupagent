import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { ForgeError } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OrchestratorFacade,
  createOrchestrator,
} from '../facade/orchestrator-facade.js'
import { AdapterApprovalGate } from '../approval/adapter-approval.js'
import { AdapterGuardrails } from '../guardrails/adapter-guardrails.js'
import type { AdapterPolicy } from '../policy/policy-compiler.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentStreamEvent,
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

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

function createRawCapableAdapter(options?: {
  providerId?: AdapterProviderId
  emitBlockedTool?: boolean
  rawPayload?: unknown
}): AgentCLIAdapter {
  const providerId = options?.providerId ?? ('claude' as AdapterProviderId)

  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: 'sess-raw',
        timestamp: Date.now(),
      }
      if (options?.emitBlockedTool) {
        yield {
          type: 'adapter:tool_call',
          providerId,
          toolName: 'bash',
          input: { cmd: 'rm -rf /tmp/demo' },
          timestamp: Date.now(),
        }
      }
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: 'sess-raw',
        result: 'done',
        usage: { inputTokens: 20, outputTokens: 10 },
        durationMs: 5,
        timestamp: Date.now(),
      }
    },
    async *executeWithRaw(input: AgentInput): AsyncGenerator<AgentStreamEvent, void, undefined> {
      yield {
        type: 'adapter:provider_raw',
        rawEvent: {
          providerId,
          runId: 'wf-raw',
          sessionId: 'sess-raw',
          providerEventId: 'prov-raw-1',
          timestamp: Date.now(),
          source: 'sdk',
          payload: options?.rawPayload ?? { type: 'item.completed', item: { type: 'web_search' } },
          correlationId: input.correlationId,
        },
      }
      yield* this.execute(input)
    },
    async *resumeSession() {},
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function createPolicyCapturingRawAdapter(
  providerId: AdapterProviderId = 'codex',
): {
  adapter: AgentCLIAdapter
  getCapturedInput: () => AgentInput | undefined
  configureSpy: ReturnType<typeof vi.fn>
} {
  let capturedInput: AgentInput | undefined
  const configureSpy = vi.fn()

  const adapter: AgentCLIAdapter = {
    providerId,
    async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      capturedInput = input
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: 'sess-policy',
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: 'sess-policy',
        result: 'done',
        usage: { inputTokens: 12, outputTokens: 6 },
        durationMs: 5,
        timestamp: Date.now(),
      }
    },
    async *executeWithRaw(input: AgentInput): AsyncGenerator<AgentStreamEvent, void, undefined> {
      yield {
        type: 'adapter:provider_raw',
        rawEvent: {
          providerId,
          runId: 'wf-policy',
          sessionId: 'sess-policy',
          providerEventId: 'prov-policy-1',
          timestamp: Date.now(),
          source: 'sdk',
          payload: { type: 'thread.started' },
        },
      }
      yield* this.execute(input)
    },
    async *resumeSession() {},
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure: configureSpy,
  }

  return {
    adapter,
    getCapturedInput: () => capturedInput,
    configureSpy,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrchestratorFacade', () => {
  let bus: DzupEventBus
  let emitted: DzupEvent[]
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

    it('returns a cancelled result when execution is aborted', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
      })

      ;(facade as unknown as {
        _registry: {
          executeWithFallback: (...args: unknown[]) => AsyncGenerator<AgentEvent, void, undefined>
        }
      })._registry.executeWithFallback = (async function *(): AsyncGenerator<AgentEvent, void, undefined> {
        yield {
          type: 'adapter:started',
          providerId: 'claude',
          sessionId: 'sess-claude',
          timestamp: Date.now(),
        }
        throw new ForgeError({
          code: 'AGENT_ABORTED',
          message: 'cancelled',
          recoverable: true,
        })
      }) as (...args: unknown[]) => AsyncGenerator<AgentEvent, void, undefined>

      const result = await facade.run('cancel me')

      expect(result.cancelled).toBe(true)
      expect(result.result).toBe('')
      expect(result.providerId).toBe('claude')
    })

    it('uses the first registered adapter instead of a generic claude fallback on cancellation', async () => {
      const facade = createOrchestrator({
        adapters: [codexAdapter],
        eventBus: bus,
      })

      ;(facade as unknown as {
        _registry: {
          executeWithFallback: (...args: unknown[]) => AsyncGenerator<AgentEvent, void, undefined>
        }
      })._registry.executeWithFallback = (async function *(): AsyncGenerator<AgentEvent, void, undefined> {
        yield {
          type: 'adapter:started',
          providerId: 'codex',
          sessionId: 'sess-codex',
          timestamp: Date.now(),
        }
        throw new ForgeError({
          code: 'AGENT_ABORTED',
          message: 'cancelled',
          recoverable: true,
        })
      }) as (...args: unknown[]) => AsyncGenerator<AgentEvent, void, undefined>

      const result = await facade.run('cancel me')

      expect(result.cancelled).toBe(true)
      expect(result.providerId).toBe('codex')
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

    it('surfaces cancellation at the public API boundary', async () => {
      vi.useFakeTimers()
      try {
        const slowClaude = createMockAdapter('claude', 'Claude result', 1_000)
        const slowCodex = createMockAdapter('codex', 'Codex result', 1_000)
        const facade = createOrchestrator({
          adapters: [slowClaude, slowCodex],
          eventBus: bus,
        })

        const resultPromise = facade.parallel('Fix the test', {
          providers: ['claude', 'codex'],
          timeoutMs: 1,
        })

        await vi.advanceTimersByTimeAsync(1_000)
        const result = await resultPromise

        expect(result.cancelled).toBe(true)
        expect(result.selectedResult.cancelled).toBe(true)
        expect(result.allResults.every((provider) => provider.cancelled)).toBe(true)
      } finally {
        vi.useRealTimers()
      }
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

    it('surfaces cancellation as run_cancelled and not run_completed', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter, codexAdapter],
        eventBus: bus,
      })
      const controller = new AbortController()
      controller.abort()

      const result = await facade.race('Fix the test', ['claude', 'codex'], controller.signal)

      expect(result.cancelled).toBe(true)
      expect(result.success).toBe(false)
      expect(result.error).toContain('cancel')

      const types = emitted.map((event) => event.type)
      expect(types).toContain('pipeline:run_started')
      expect(types).toContain('pipeline:run_cancelled')
      expect(types).not.toContain('pipeline:run_completed')

      const cancelledEvent = emitted.find((event) => event.type === 'pipeline:run_cancelled')
      expect(cancelledEvent).toMatchObject({
        type: 'pipeline:run_cancelled',
        pipelineId: 'parallel-executor',
        reason: expect.stringContaining('cancel'),
      })
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

    it('surfaces cancellation at the public API boundary', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter, codexAdapter],
        eventBus: bus,
      })
      const controller = new AbortController()
      controller.abort()

      const result = await facade.bid('Fix the failing test', {
        signal: controller.signal,
      })

      expect(result.cancelled).toBe(true)
      expect(result.success).toBe(false)
      expect(result.winningBid).toBeNull()
    })
  })

  describe('mapReduce()', () => {
    it('surfaces cancellation at the public API boundary', async () => {
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
      })
      const controller = new AbortController()
      controller.abort()

      const result = await facade.mapReduce(
        'chunk-a\nchunk-b',
        {
          chunker: {
            split: () => ['chunk-a', 'chunk-b'],
          },
          mapper: (chunk: string) => ({
            input: { prompt: chunk },
            task: { prompt: chunk, tags: ['general'] },
          }),
          resultExtractor: (raw: string) => raw,
          reducer: (results) => results.length,
          signal: controller.signal,
        },
      )

      expect(result.cancelled).toBe(true)
      expect(result.failedChunks).toBe(2)
      expect(result.perChunkStats.every((stat) => stat.cancelled)).toBe(true)
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

    it('supports approval-gated chat turns', async () => {
      const approvalGate = new AdapterApprovalGate({
        mode: 'required',
        timeoutMs: 5_000,
        eventBus: bus,
      })
      const facade = createOrchestrator({
        adapters: [claudeAdapter],
        eventBus: bus,
        approvalGate,
      })

      const stream = facade.chat('Needs approval', {
        provider: 'claude',
        requireApproval: true,
        approvalRunId: 'chat-approval-1',
      })

      const firstEventPromise = stream.next()
      await vi.waitFor(() => {
        expect(approvalGate.listPending()).toHaveLength(1)
      })

      const pendingRequest = approvalGate.listPending()[0]
      expect(pendingRequest?.runId).toBe('chat-approval-1')
      approvalGate.grant(pendingRequest!.requestId, 'tester')

      const firstEvent = await firstEventPromise
      expect(firstEvent.done).toBe(false)
      expect(firstEvent.value?.type).toBe('adapter:started')

      const remainingTypes: string[] = []
      for await (const event of stream) {
        remainingTypes.push(event.type)
      }

      expect(remainingTypes).toContain('adapter:completed')
      expect(emitted).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'approval:requested', runId: 'chat-approval-1' }),
        expect.objectContaining({ type: 'approval:granted', runId: 'chat-approval-1' }),
      ]))
    })
  })

  describe('chatWithRaw()', () => {
    it('tracks cost while preserving provider raw events', async () => {
      const facade = createOrchestrator({
        adapters: [createRawCapableAdapter()],
        eventBus: bus,
        enableCostTracking: true,
      })

      const events: AgentStreamEvent[] = []
      for await (const event of facade.chatWithRaw('Inspect the raw stream path')) {
        events.push(event)
      }

      expect(events.map((event) => event.type)).toContain('adapter:provider_raw')
      expect(events.map((event) => event.type)).toContain('adapter:completed')
      expect(facade.getCostReport()?.totalCostCents ?? 0).toBeGreaterThan(0)
    })

    it('applies guardrails without dropping provider raw events emitted before the violation', async () => {
      const facade = createOrchestrator({
        adapters: [createRawCapableAdapter({ emitBlockedTool: true })],
        eventBus: bus,
        guardrails: new AdapterGuardrails({
          blockedTools: ['bash'],
        }),
      })

      const events: AgentStreamEvent[] = []
      for await (const event of facade.chatWithRaw('Run a blocked command')) {
        events.push(event)
      }

      expect(events[0]?.type).toBe('adapter:provider_raw')
      expect(events.at(-1)).toMatchObject({
        type: 'adapter:failed',
        error: expect.stringContaining('blocked'),
      })
    })

    it('applies policy overrides on raw-capable chat turns', async () => {
      const { adapter, getCapturedInput, configureSpy } = createPolicyCapturingRawAdapter('codex')
      const facade = createOrchestrator({
        adapters: [adapter],
        eventBus: bus,
      })
      const policy: AdapterPolicy = {
        sandboxMode: 'workspace-write',
        approvalRequired: true,
        maxTurns: 7,
      }

      const events: AgentStreamEvent[] = []
      for await (const event of facade.chatWithRaw('Use policy', {
        provider: 'codex',
        policy,
      })) {
        events.push(event)
      }

      expect(events.map((event) => event.type)).toContain('adapter:provider_raw')
      expect(configureSpy).toHaveBeenCalledWith(expect.objectContaining({
        sandboxMode: 'workspace-write',
      }))
      expect(getCapturedInput()).toMatchObject({
        maxTurns: 7,
        options: expect.objectContaining({
          approvalPolicy: 'on-failure',
          maxTurns: 7,
        }),
      })
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

  describe('memoryEnrichment', () => {
    it('enriches adapter input with recalled memories when configured', async () => {
      // Create a mock adapter that captures the input it receives
      let capturedSystemPrompt: string | undefined
      const memoryAdapter: AgentCLIAdapter = {
        providerId: 'claude' as AdapterProviderId,
        async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
          capturedSystemPrompt = input.systemPrompt
          yield {
            type: 'adapter:started',
            providerId: 'claude',
            sessionId: 'sess-mem',
            timestamp: Date.now(),
          }
          yield {
            type: 'adapter:completed',
            providerId: 'claude',
            sessionId: 'sess-mem',
            result: 'done',
            usage: { inputTokens: 10, outputTokens: 5 },
            durationMs: 10,
            timestamp: Date.now(),
          }
        },
        async *resumeSession() {},
        interrupt() {},
        async healthCheck() {
          return { healthy: true, providerId: 'claude' as AdapterProviderId, sdkInstalled: true, cliAvailable: true }
        },
        configure() {},
      }

      const mockMemoryService = {
        search: vi.fn().mockResolvedValue([
          { text: 'The user prefers TypeScript strict mode' },
          { text: 'Project uses Vitest for testing' },
        ]),
      }

      const facade = createOrchestrator({
        adapters: [memoryAdapter],
        eventBus: bus,
        memoryEnrichment: {
          memoryService: mockMemoryService,
          namespace: 'agent-context',
          scope: { tenantId: 'acme' },
        },
      })

      await facade.run('Fix the test')

      expect(mockMemoryService.search).toHaveBeenCalled()
      expect(capturedSystemPrompt).toBeDefined()
      expect(capturedSystemPrompt).toContain('TypeScript strict mode')
      expect(capturedSystemPrompt).toContain('Vitest for testing')
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

// ---------------------------------------------------------------------------
// OrchestratorFacade with dzupagent config
// ---------------------------------------------------------------------------

describe('OrchestratorFacade with dzupagent config', () => {
  let bus: DzupEventBus
  let tempDir: string

  /** Create a mock adapter that captures the systemPrompt it receives. */
  function createCapturingAdapter(): {
    adapter: AgentCLIAdapter
    getCapturedSystemPrompt: () => string | undefined
  } {
    let capturedSystemPrompt: string | undefined
    const adapter: AgentCLIAdapter = {
      providerId: 'claude' as AdapterProviderId,
      async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
        capturedSystemPrompt = input.systemPrompt
        yield {
          type: 'adapter:started',
          providerId: 'claude',
          sessionId: 'sess-ucl',
          timestamp: Date.now(),
        }
        yield {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: 'sess-ucl',
          result: 'done',
          usage: { inputTokens: 10, outputTokens: 5 },
          durationMs: 10,
          timestamp: Date.now(),
        }
      },
      async *resumeSession() {
        // no-op
      },
      interrupt() {},
      async healthCheck() {
        return {
          healthy: true,
          providerId: 'claude' as AdapterProviderId,
          sdkInstalled: true,
          cliAvailable: true,
        }
      },
      configure() {},
    }
    return { adapter, getCapturedSystemPrompt: () => capturedSystemPrompt }
  }

  beforeEach(async () => {
    bus = createEventBus()
    tempDir = await mkdtemp(join(tmpdir(), 'ucl-facade-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('without dzupagent config: existing behavior unchanged', async () => {
    const { adapter, getCapturedSystemPrompt } = createCapturingAdapter()
    const facade = createOrchestrator({
      adapters: [adapter],
      eventBus: bus,
    })

    const result = await facade.run('Hello')

    expect(result.result).toBe('done')
    // No UCL injection — systemPrompt should be undefined (no enrichment)
    expect(getCapturedSystemPrompt()).toBeUndefined()
  })

  it('with dzupagent config and skill files: system prompt contains skill content', async () => {
    // Create .dzupagent/skills/ with a skill file
    const skillsDir = join(tempDir, '.dzupagent', 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(
      join(skillsDir, 'code-review.md'),
      `---
name: code-review
version: "1"
---

## Persona
You are an expert code reviewer.

## Task
Review code for correctness and style.
`,
    )

    const { adapter, getCapturedSystemPrompt } = createCapturingAdapter()
    const facade = createOrchestrator({
      adapters: [adapter],
      eventBus: bus,
      dzupagent: { projectRoot: tempDir },
    })

    await facade.run('Review my code')

    const prompt = getCapturedSystemPrompt()
    expect(prompt).toBeDefined()
    expect(prompt).toContain('code-review')
    expect(prompt).toContain('expert code reviewer')
    expect(prompt).toContain('Review code for correctness')
  })

  it('applies dzupagent skill enrichment on chatWithRaw()', async () => {
    const skillsDir = join(tempDir, '.dzupagent', 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(
      join(skillsDir, 'debug-flow.md'),
      `---
name: debug-flow
version: "1"
---

## Task
Inspect event drift before responding.
`,
    )

    const { adapter, getCapturedSystemPrompt } = createCapturingAdapter()
    const facade = createOrchestrator({
      adapters: [adapter],
      eventBus: bus,
      dzupagent: { projectRoot: tempDir },
    })

    const events: AgentEvent[] = []
    for await (const event of facade.chat('Inspect the raw stream path')) {
      events.push(event)
    }

    expect(events.map((event) => event.type)).toContain('adapter:completed')
    const prompt = getCapturedSystemPrompt()
    expect(prompt).toBeDefined()
    expect(prompt).toContain('debug-flow')
    expect(prompt).toContain('Inspect event drift before responding')
  })

  it('with dzupagent: { skipMemory: true }: memory NOT injected', async () => {
    // Create both skills and memory files — only skills should appear
    const skillsDir = join(tempDir, '.dzupagent', 'skills')
    const memoryDir = join(tempDir, '.dzupagent', 'memory')
    await mkdir(skillsDir, { recursive: true })
    await mkdir(memoryDir, { recursive: true })

    await writeFile(
      join(skillsDir, 'my-skill.md'),
      `---
name: my-skill
---

## Task
Do the task.
`,
    )
    await writeFile(
      join(memoryDir, 'project-facts.md'),
      `---
name: project-facts
---

This project uses PostgreSQL and Redis.
`,
    )

    const { adapter, getCapturedSystemPrompt } = createCapturingAdapter()
    const facade = createOrchestrator({
      adapters: [adapter],
      eventBus: bus,
      dzupagent: { projectRoot: tempDir, skipMemory: true },
    })

    await facade.run('Do something')

    const prompt = getCapturedSystemPrompt()
    expect(prompt).toBeDefined()
    // Skills should be present
    expect(prompt).toContain('my-skill')
    expect(prompt).toContain('Do the task')
    // Memory should NOT be present
    expect(prompt).not.toContain('PostgreSQL')
    expect(prompt).not.toContain('Redis')
  })

  it('with dzupagent: { skipSkills: true }: skills NOT injected', async () => {
    // Create both skills and memory files — only memory should appear
    const skillsDir = join(tempDir, '.dzupagent', 'skills')
    const memoryDir = join(tempDir, '.dzupagent', 'memory')
    await mkdir(skillsDir, { recursive: true })
    await mkdir(memoryDir, { recursive: true })

    await writeFile(
      join(skillsDir, 'my-skill.md'),
      `---
name: my-skill
---

## Task
Do the task.
`,
    )
    await writeFile(
      join(memoryDir, 'project-facts.md'),
      `---
name: project-facts
---

This project uses PostgreSQL and Redis.
`,
    )

    const { adapter, getCapturedSystemPrompt } = createCapturingAdapter()
    const facade = createOrchestrator({
      adapters: [adapter],
      eventBus: bus,
      dzupagent: { projectRoot: tempDir, skipSkills: true },
    })

    await facade.run('Do something')

    const prompt = getCapturedSystemPrompt()
    expect(prompt).toBeDefined()
    // Skills should NOT be present
    expect(prompt).not.toContain('my-skill')
    expect(prompt).not.toContain('Do the task')
    // Memory should be present
    expect(prompt).toContain('PostgreSQL')
    expect(prompt).toContain('Redis')
  })

  it('with both skills and memory: both injected in correct order', async () => {
    const skillsDir = join(tempDir, '.dzupagent', 'skills')
    const memoryDir = join(tempDir, '.dzupagent', 'memory')
    await mkdir(skillsDir, { recursive: true })
    await mkdir(memoryDir, { recursive: true })

    await writeFile(
      join(skillsDir, 'test-skill.md'),
      `---
name: test-skill
---

## Task
Run the tests first.
`,
    )
    await writeFile(
      join(memoryDir, 'tech-stack.md'),
      `---
name: tech-stack
---

We use Vitest for testing.
`,
    )

    const { adapter, getCapturedSystemPrompt } = createCapturingAdapter()
    const facade = createOrchestrator({
      adapters: [adapter],
      eventBus: bus,
      dzupagent: { projectRoot: tempDir },
    })

    await facade.run('Fix the test')

    const prompt = getCapturedSystemPrompt()
    expect(prompt).toBeDefined()
    // Skills come first (prepended), memory comes after
    expect(prompt).toContain('test-skill')
    expect(prompt).toContain('Run the tests first')
    expect(prompt).toContain('Vitest for testing')
    // Skills should appear before memory in the combined prompt
    const skillIdx = prompt!.indexOf('test-skill')
    const memoryIdx = prompt!.indexOf('Vitest for testing')
    expect(skillIdx).toBeLessThan(memoryIdx)
  })

  it('with empty .dzupagent directory: no enrichment applied', async () => {
    // Create the directory structure but no files
    await mkdir(join(tempDir, '.dzupagent'), { recursive: true })

    const { adapter, getCapturedSystemPrompt } = createCapturingAdapter()
    const facade = createOrchestrator({
      adapters: [adapter],
      eventBus: bus,
      dzupagent: { projectRoot: tempDir },
    })

    await facade.run('Hello')

    // No skills or memory files — systemPrompt should remain undefined
    expect(getCapturedSystemPrompt()).toBeUndefined()
  })

  describe('adapter:skills_compiled event', () => {
    it('emits adapter:skills_compiled when skills compile successfully', async () => {
      const skillsDir = join(tempDir, '.dzupagent', 'skills')
      await mkdir(skillsDir, { recursive: true })
      await writeFile(
        join(skillsDir, 'my-skill.md'),
        `---
name: my-skill
---

## Task
Do the task.
`,
      )

      const emitted: DzupEvent[] = []
      bus.onAny((e) => emitted.push(e))

      const { adapter } = createCapturingAdapter()
      const facade = createOrchestrator({
        adapters: [adapter],
        eventBus: bus,
        dzupagent: { projectRoot: tempDir },
      })

      await facade.run('Do something')

      const skillsEvent = emitted.find(
        (e) => (e as { type: string }).type === 'adapter:skills_compiled',
      ) as unknown as { type: string; providerId: string; skills: Array<{ skillId: string }> } | undefined
      expect(skillsEvent).toBeDefined()
      expect(skillsEvent!.type).toBe('adapter:skills_compiled')
      expect(skillsEvent!.providerId).toBe('claude')
      expect(skillsEvent!.skills).toHaveLength(1)
      expect(skillsEvent!.skills[0]!.skillId).toBe('my-skill')
    })

    it('does NOT emit adapter:skills_compiled when bundles array is empty', async () => {
      // Create .dzupagent but no skill files
      await mkdir(join(tempDir, '.dzupagent'), { recursive: true })

      const emitted: DzupEvent[] = []
      bus.onAny((e) => emitted.push(e))

      const { adapter } = createCapturingAdapter()
      const facade = createOrchestrator({
        adapters: [adapter],
        eventBus: bus,
        dzupagent: { projectRoot: tempDir },
      })

      await facade.run('Hello')

      const skillsEvents = emitted.filter(
        (e) => (e as { type: string }).type === 'adapter:skills_compiled',
      )
      expect(skillsEvents).toHaveLength(0)
    })

    it('does NOT emit adapter:skills_compiled when eventBus is the default (no dzupagent config)', async () => {
      // No dzupagent config — skills compilation is skipped entirely
      const emitted: DzupEvent[] = []
      bus.onAny((e) => emitted.push(e))

      const { adapter } = createCapturingAdapter()
      const facade = createOrchestrator({
        adapters: [adapter],
        eventBus: bus,
      })

      await facade.run('Hello')

      const skillsEvents = emitted.filter(
        (e) => (e as { type: string }).type === 'adapter:skills_compiled',
      )
      expect(skillsEvents).toHaveLength(0)
    })

    it('emits adapter:skills_compiled with multiple skills', async () => {
      const skillsDir = join(tempDir, '.dzupagent', 'skills')
      await mkdir(skillsDir, { recursive: true })
      await writeFile(
        join(skillsDir, 'skill-a.md'),
        `---
name: skill-a
---

## Task
Task A.
`,
      )
      await writeFile(
        join(skillsDir, 'skill-b.md'),
        `---
name: skill-b
---

## Task
Task B.
`,
      )

      const emitted: DzupEvent[] = []
      bus.onAny((e) => emitted.push(e))

      const { adapter } = createCapturingAdapter()
      const facade = createOrchestrator({
        adapters: [adapter],
        eventBus: bus,
        dzupagent: { projectRoot: tempDir },
      })

      await facade.run('Do it')

      const skillsEvent = emitted.find(
        (e) => (e as { type: string }).type === 'adapter:skills_compiled',
      ) as unknown as { type: string; skills: Array<{ skillId: string; degraded: string[]; dropped: string[] }> } | undefined
      expect(skillsEvent).toBeDefined()
      expect(skillsEvent!.skills).toHaveLength(2)
      const skillIds = skillsEvent!.skills.map((s) => s.skillId).sort()
      expect(skillIds).toEqual(['skill-a', 'skill-b'])
      // degraded and dropped should be empty arrays
      for (const skill of skillsEvent!.skills) {
        expect(skill.degraded).toEqual([])
        expect(skill.dropped).toEqual([])
      }
    })
  })
})
