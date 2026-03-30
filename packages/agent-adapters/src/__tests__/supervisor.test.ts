import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzipagent/core'
import type { DzipEvent, DzipEventBus } from '@dzipagent/core'

import {
  SupervisorOrchestrator,
  KeywordTaskDecomposer,
} from '../orchestration/supervisor.js'
import type {
  SubTask,
  TaskDecomposer,
  SupervisorConfig,
} from '../orchestration/supervisor.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  RoutingDecision,
  TaskDescriptor,
} from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  results: AgentEvent[],
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      for (const e of results) yield e
    },
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function createMockRegistry(
  adapter: AgentCLIAdapter,
  events?: AgentEvent[],
): AdapterRegistry {
  const decision: RoutingDecision = {
    provider: adapter.providerId,
    reason: 'mock',
    confidence: 1,
  }

  return {
    getForTask(_task: TaskDescriptor) {
      return { adapter, decision }
    },
    async *executeWithFallback(_input: AgentInput, _task: TaskDescriptor) {
      const evts = events ?? [
        {
          type: 'adapter:started' as const,
          providerId: adapter.providerId,
          sessionId: 'sess-1',
          timestamp: Date.now(),
        },
        {
          type: 'adapter:completed' as const,
          providerId: adapter.providerId,
          sessionId: 'sess-1',
          result: `Result for: ${_input.prompt}`,
          durationMs: 50,
          timestamp: Date.now(),
        },
      ]
      for (const e of evts) yield e
    },
  } as unknown as AdapterRegistry
}

function createFailingRegistry(
  providerId: AdapterProviderId,
  errorMessage: string,
): AdapterRegistry {
  const adapter = createMockAdapter(providerId, [])
  const decision: RoutingDecision = {
    provider: providerId,
    reason: 'mock',
    confidence: 1,
  }

  return {
    getForTask(_task: TaskDescriptor) {
      return { adapter, decision }
    },
    async *executeWithFallback(_input: AgentInput, _task: TaskDescriptor) {
      yield {
        type: 'adapter:failed' as const,
        providerId,
        error: errorMessage,
        timestamp: Date.now(),
      }
    },
  } as unknown as AdapterRegistry
}

function collectBusEvents(bus: DzipEventBus): DzipEvent[] {
  const events: DzipEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

// ---------------------------------------------------------------------------
// KeywordTaskDecomposer tests
// ---------------------------------------------------------------------------

describe('KeywordTaskDecomposer', () => {
  const decomposer = new KeywordTaskDecomposer()

  it('splits goal on sentence boundaries', async () => {
    const subtasks = await decomposer.decompose('Review the code. Implement the fix. Test the result')
    expect(subtasks).toHaveLength(3)
    expect(subtasks[0]!.description).toBe('Review the code')
    expect(subtasks[1]!.description).toBe('Implement the fix')
    expect(subtasks[2]!.description).toBe('Test the result')
  })

  it('classifies review/analyze as reasoning tasks', async () => {
    const subtasks = await decomposer.decompose('Analyze the performance')
    expect(subtasks).toHaveLength(1)
    expect(subtasks[0]!.tags).toContain('reasoning')
    expect(subtasks[0]!.requiresReasoning).toBe(true)
    expect(subtasks[0]!.requiresExecution).toBe(false)
  })

  it('classifies implement/build as execution tasks', async () => {
    const subtasks = await decomposer.decompose('Build a new feature')
    expect(subtasks).toHaveLength(1)
    expect(subtasks[0]!.tags).toContain('execution')
    expect(subtasks[0]!.requiresExecution).toBe(true)
  })

  it('classifies fix/debug as bugfix tasks', async () => {
    const subtasks = await decomposer.decompose('Fix the broken test')
    expect(subtasks).toHaveLength(1)
    expect(subtasks[0]!.tags).toContain('bugfix')
  })

  it('classifies test/verify as testing tasks', async () => {
    const subtasks = await decomposer.decompose('Verify the output')
    expect(subtasks).toHaveLength(1)
    expect(subtasks[0]!.tags).toContain('testing')
  })

  it('returns general tag for unmatched sentences', async () => {
    const subtasks = await decomposer.decompose('Do something vague')
    expect(subtasks).toHaveLength(1)
    expect(subtasks[0]!.tags).toEqual(['general'])
  })

  it('returns single subtask for single-sentence goal', async () => {
    const subtasks = await decomposer.decompose('Implement the API endpoint')
    expect(subtasks).toHaveLength(1)
  })

  it('splits on semicolons and newlines', async () => {
    const subtasks = await decomposer.decompose('Review code; Implement fix\nTest result')
    expect(subtasks).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// SupervisorOrchestrator tests
// ---------------------------------------------------------------------------

describe('SupervisorOrchestrator', () => {
  let bus: DzipEventBus
  let emitted: DzipEvent[]

  beforeEach(() => {
    bus = createEventBus()
    emitted = collectBusEvents(bus)
  })

  describe('execute()', () => {
    it('decomposes goal into subtasks and delegates', async () => {
      const adapter = createMockAdapter('claude', [])
      const registry = createMockRegistry(adapter)

      const supervisor = new SupervisorOrchestrator({
        registry,
        eventBus: bus,
      })

      const result = await supervisor.execute('Implement the feature. Test the result')

      expect(result.goal).toBe('Implement the feature. Test the result')
      expect(result.subtaskResults).toHaveLength(2)
      expect(result.subtaskResults[0]!.success).toBe(true)
      expect(result.subtaskResults[1]!.success).toBe(true)
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
    })

    it('emits supervisor events during execution', async () => {
      const adapter = createMockAdapter('claude', [])
      const registry = createMockRegistry(adapter)

      const supervisor = new SupervisorOrchestrator({
        registry,
        eventBus: bus,
      })

      await supervisor.execute('Implement the feature')

      const eventTypes = emitted.map((e) => e.type)
      expect(eventTypes).toContain('supervisor:plan_created')
      expect(eventTypes).toContain('supervisor:delegating')
      expect(eventTypes).toContain('supervisor:delegation_complete')
    })

    it('handles subtask failures gracefully', async () => {
      const registry = createFailingRegistry('codex', 'adapter error')

      const supervisor = new SupervisorOrchestrator({
        registry,
        eventBus: bus,
      })

      const result = await supervisor.execute('Fix the bug')

      expect(result.subtaskResults).toHaveLength(1)
      expect(result.subtaskResults[0]!.success).toBe(false)
      expect(result.subtaskResults[0]!.error).toBeDefined()
    })

    it('uses custom decomposer when provided', async () => {
      const adapter = createMockAdapter('claude', [])
      const registry = createMockRegistry(adapter)

      const customDecomposer: TaskDecomposer = {
        async decompose(_goal: string): Promise<SubTask[]> {
          return [
            { description: 'Custom task 1', tags: ['custom'] },
            { description: 'Custom task 2', tags: ['custom'] },
          ]
        },
      }

      const supervisor = new SupervisorOrchestrator({
        registry,
        eventBus: bus,
        decomposer: customDecomposer,
      })

      const result = await supervisor.execute('Any goal')
      expect(result.subtaskResults).toHaveLength(2)
    })

    it('returns empty results for empty decomposition', async () => {
      const adapter = createMockAdapter('claude', [])
      const registry = createMockRegistry(adapter)

      const emptyDecomposer: TaskDecomposer = {
        async decompose(): Promise<SubTask[]> {
          return []
        },
      }

      const supervisor = new SupervisorOrchestrator({
        registry,
        eventBus: bus,
        decomposer: emptyDecomposer,
      })

      const result = await supervisor.execute('Empty goal')
      expect(result.subtaskResults).toHaveLength(0)
    })

    it('marks dependency-skipped subtasks with null providerId', async () => {
      const adapter = createMockAdapter('claude', [])
      let callCount = 0
      const registry = {
        getForTask(_task: TaskDescriptor) {
          return {
            adapter,
            decision: { provider: 'claude' as AdapterProviderId, reason: 'mock', confidence: 1 },
          }
        },
        async *executeWithFallback(_input: AgentInput, _task: TaskDescriptor) {
          const current = callCount++
          if (current === 0) {
            yield {
              type: 'adapter:failed' as const,
              providerId: 'claude' as AdapterProviderId,
              error: 'first task failed',
              timestamp: Date.now(),
            }
            return
          }
          yield {
            type: 'adapter:completed' as const,
            providerId: 'claude' as AdapterProviderId,
            sessionId: 'sess-1',
            result: 'done',
            durationMs: 10,
            timestamp: Date.now(),
          }
        },
      } as unknown as AdapterRegistry

      const decomposer: TaskDecomposer = {
        async decompose(): Promise<SubTask[]> {
          return [
            { description: 'Task 1', tags: ['general'] },
            { description: 'Task 2', tags: ['general'], dependsOn: [0] },
          ]
        },
      }

      const supervisor = new SupervisorOrchestrator({
        registry,
        eventBus: bus,
        decomposer,
        maxConcurrentDelegations: 1,
      })

      const result = await supervisor.execute('Dependent tasks')
      expect(result.subtaskResults).toHaveLength(2)
      expect(result.subtaskResults[0]!.success).toBe(false)
      expect(result.subtaskResults[1]!.success).toBe(false)
      expect(result.subtaskResults[1]!.providerId).toBeNull()
      expect(result.subtaskResults[1]!.error).toContain('Skipped: dependency subtask 0 failed')
    })
  })

  describe('concurrency control', () => {
    it('respects maxConcurrentDelegations', async () => {
      let concurrentCount = 0
      let maxConcurrentObserved = 0

      const adapter = createMockAdapter('claude', [])
      const registry = {
        getForTask(_task: TaskDescriptor) {
          return {
            adapter,
            decision: { provider: 'claude' as AdapterProviderId, reason: 'mock', confidence: 1 },
          }
        },
        async *executeWithFallback(_input: AgentInput, _task: TaskDescriptor) {
          concurrentCount++
          maxConcurrentObserved = Math.max(maxConcurrentObserved, concurrentCount)
          // Simulate some async work
          await new Promise((r) => setTimeout(r, 20))
          yield {
            type: 'adapter:completed' as const,
            providerId: 'claude' as AdapterProviderId,
            sessionId: 'sess-1',
            result: 'done',
            durationMs: 20,
            timestamp: Date.now(),
          }
          concurrentCount--
        },
      } as unknown as AdapterRegistry

      const decomposer: TaskDecomposer = {
        async decompose(): Promise<SubTask[]> {
          return [
            { description: 'Task 1', tags: ['general'] },
            { description: 'Task 2', tags: ['general'] },
            { description: 'Task 3', tags: ['general'] },
            { description: 'Task 4', tags: ['general'] },
            { description: 'Task 5', tags: ['general'] },
          ]
        },
      }

      const supervisor = new SupervisorOrchestrator({
        registry,
        eventBus: bus,
        decomposer,
        maxConcurrentDelegations: 2,
      })

      await supervisor.execute('Five tasks')

      expect(maxConcurrentObserved).toBeLessThanOrEqual(2)
    })
  })

  describe('AbortSignal cancellation', () => {
    it('throws when signal is already aborted', async () => {
      const adapter = createMockAdapter('claude', [])
      const registry = createMockRegistry(adapter)
      const controller = new AbortController()
      controller.abort()

      const supervisor = new SupervisorOrchestrator({ registry, eventBus: bus })

      await expect(
        supervisor.execute('Do something', { signal: controller.signal }),
      ).rejects.toThrow('aborted')
    })

    it('marks subtask as failed when signal is aborted during execution', async () => {
      const adapter = createMockAdapter('claude', [])
      const controller = new AbortController()

      const registry = {
        getForTask(_task: TaskDescriptor) {
          return {
            adapter,
            decision: { provider: 'claude' as AdapterProviderId, reason: 'mock', confidence: 1 },
          }
        },
        async *executeWithFallback(_input: AgentInput, _task: TaskDescriptor) {
          // Abort during execution
          controller.abort()
          await new Promise((r) => setTimeout(r, 10))
          yield {
            type: 'adapter:completed' as const,
            providerId: 'claude' as AdapterProviderId,
            sessionId: 'sess-1',
            result: 'done',
            durationMs: 10,
            timestamp: Date.now(),
          }
        },
      } as unknown as AdapterRegistry

      const supervisor = new SupervisorOrchestrator({ registry, eventBus: bus })

      // The supervisor catches abort errors per-subtask and marks them as failed
      const result = await supervisor.execute('Do something', { signal: controller.signal })

      expect(result.subtaskResults).toHaveLength(1)
      expect(result.subtaskResults[0]!.success).toBe(false)
      expect(result.subtaskResults[0]!.error).toContain('aborted')
    })
  })

  describe('plan event metadata', () => {
    it('marks source as keyword when using KeywordTaskDecomposer', async () => {
      const adapter = createMockAdapter('claude', [])
      const registry = createMockRegistry(adapter)

      const supervisor = new SupervisorOrchestrator({
        registry,
        eventBus: bus,
      })

      await supervisor.execute('Implement the feature')

      const planEvent = emitted.find((e) => e.type === 'supervisor:plan_created') as
        | (DzipEvent & { source?: string })
        | undefined
      expect(planEvent).toBeDefined()
      expect(planEvent!['source']).toBe('keyword')
    })

    it('marks source as llm when using custom decomposer', async () => {
      const adapter = createMockAdapter('claude', [])
      const registry = createMockRegistry(adapter)

      const customDecomposer: TaskDecomposer = {
        async decompose(): Promise<SubTask[]> {
          return [{ description: 'Task', tags: ['general'] }]
        },
      }

      const supervisor = new SupervisorOrchestrator({
        registry,
        eventBus: bus,
        decomposer: customDecomposer,
      })

      await supervisor.execute('Any goal')

      const planEvent = emitted.find((e) => e.type === 'supervisor:plan_created') as
        | (DzipEvent & { source?: string })
        | undefined
      expect(planEvent).toBeDefined()
      expect(planEvent!['source']).toBe('llm')
    })
  })
})
