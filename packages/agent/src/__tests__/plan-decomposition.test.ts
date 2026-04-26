/**
 * Tests for LLM-powered plan decomposition in PlanningAgent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  PlanningAgent,
  DecompositionSchema,
  PlanNodeSchema,
} from '../orchestration/planning-agent.js'
import type { ExecutionPlan } from '../orchestration/planning-agent.js'
import type {
  DelegatingSupervisor,
  TaskAssignment,
  AggregatedDelegationResult,
} from '../orchestration/delegating-supervisor.js'
import type { DelegationResult } from '../orchestration/delegation.js'
import type { StructuredLLM } from '../structured/structured-output-engine.js'
import type { AgentExecutionSpec, DzupEventBus } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Mock LLM factory
// ---------------------------------------------------------------------------

function createMockLLM(responseContent: string): StructuredLLM {
  return {
    invoke: vi.fn(async () => ({
      content: responseContent,
    })),
  }
}

// ---------------------------------------------------------------------------
// Mock DelegatingSupervisor factory
// ---------------------------------------------------------------------------

function createMockSupervisor(opts?: {
  specialists?: Map<string, AgentExecutionSpec>
  resultOverrides?: Map<string, DelegationResult>
}): DelegatingSupervisor {
  const specialists = opts?.specialists ?? new Map<string, AgentExecutionSpec>([
    ['db-agent', {
      id: 'db-agent',
      name: 'Database Agent',
      description: 'Handles database schemas and migrations',
      instructions: '',
      modelTier: 'standard',
      tools: ['sql-query'],
      metadata: { tags: ['database', 'sql', 'migration'] },
    }],
    ['api-agent', {
      id: 'api-agent',
      name: 'API Agent',
      description: 'Builds REST API endpoints',
      instructions: '',
      modelTier: 'standard',
      tools: ['http-client'],
      metadata: { tags: ['api', 'backend', 'rest'] },
    }],
    ['ui-agent', {
      id: 'ui-agent',
      name: 'UI Agent',
      description: 'Creates frontend components',
      instructions: '',
      modelTier: 'standard',
      tools: ['component-gen'],
      metadata: { tags: ['ui', 'frontend', 'component'] },
    }],
  ])

  const specialistIds = [...specialists.keys()]
  const resultOverrides = opts?.resultOverrides ?? new Map()

  const delegateAndCollect = vi.fn(
    async (tasks: TaskAssignment[]): Promise<AggregatedDelegationResult> => {
      const results = new Map<string, DelegationResult>()
      const succeeded: string[] = []
      const failed: string[] = []

      for (const task of tasks) {
        const override = resultOverrides.get(task.specialistId)
        if (override) {
          results.set(task.specialistId, override)
          if (override.success) {
            succeeded.push(task.specialistId)
          } else {
            failed.push(task.specialistId)
          }
        } else {
          results.set(task.specialistId, {
            success: true,
            output: { task: task.task, input: task.input },
          })
          succeeded.push(task.specialistId)
        }
      }

      return { results, succeeded, failed, totalDurationMs: 10 }
    },
  )

  const getSpecialist = vi.fn((id: string) => specialists.get(id))

  return {
    specialistIds,
    delegateAndCollect,
    delegateTask: vi.fn(),
    planAndDelegate: vi.fn(),
    getSpecialist,
  } as unknown as DelegatingSupervisor
}

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe('DecompositionSchema', () => {
  it('should validate a well-formed decomposition', () => {
    const input = {
      nodes: [
        { id: 'node-0', task: 'Create schema', specialistId: 'db-agent', dependsOn: [] },
        { id: 'node-1', task: 'Build API', specialistId: 'api-agent', dependsOn: ['node-0'] },
      ],
    }
    const result = DecompositionSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('should reject empty nodes array', () => {
    const result = DecompositionSchema.safeParse({ nodes: [] })
    expect(result.success).toBe(false)
  })

  it('should default dependsOn to empty array', () => {
    const result = PlanNodeSchema.safeParse({
      id: 'node-0',
      task: 'Test',
      specialistId: 'test',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.dependsOn).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// PlanningAgent.decompose
// ---------------------------------------------------------------------------

describe('PlanningAgent.decompose', () => {
  let supervisor: ReturnType<typeof createMockSupervisor>

  beforeEach(() => {
    supervisor = createMockSupervisor()
  })

  it('should decompose a goal using the mock LLM and return a valid plan', async () => {
    const llmResponse = JSON.stringify({
      nodes: [
        { id: 'node-0', task: 'Create database schema', specialistId: 'db-agent', dependsOn: [] },
        { id: 'node-1', task: 'Build REST endpoints', specialistId: 'api-agent', dependsOn: ['node-0'] },
        { id: 'node-2', task: 'Create UI components', specialistId: 'ui-agent', dependsOn: ['node-1'] },
      ],
    })
    const llm = createMockLLM(llmResponse)

    const agent = new PlanningAgent({ supervisor })
    const plan = await agent.decompose('Build a user management feature', llm)

    expect(plan.goal).toBe('Build a user management feature')
    expect(plan.nodes).toHaveLength(3)
    expect(plan.executionLevels).toHaveLength(3)
    expect(plan.executionLevels[0]).toEqual(['node-0'])
    expect(plan.executionLevels[1]).toEqual(['node-1'])
    expect(plan.executionLevels[2]).toEqual(['node-2'])

    // LLM should have been called with system + user messages
    expect(llm.invoke).toHaveBeenCalledTimes(1)
    const messages = (llm.invoke as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Array<{ role: string; content: string }>
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain('db-agent')
    expect(messages[0]!.content).toContain('api-agent')
    expect(messages[0]!.content).toContain('ui-agent')
    expect(messages[1]!.role).toBe('user')
    expect(messages[1]!.content).toContain('Build a user management feature')
  })

  it('should filter out nodes with invalid specialist IDs', async () => {
    const llmResponse = JSON.stringify({
      nodes: [
        { id: 'node-0', task: 'Create schema', specialistId: 'db-agent', dependsOn: [] },
        { id: 'node-1', task: 'Deploy infra', specialistId: 'nonexistent-agent', dependsOn: ['node-0'] },
        { id: 'node-2', task: 'Build UI', specialistId: 'ui-agent', dependsOn: ['node-0'] },
      ],
    })
    const llm = createMockLLM(llmResponse)

    const agent = new PlanningAgent({ supervisor })
    const plan = await agent.decompose('Build feature', llm)

    // node-1 should be filtered out, leaving 2 valid nodes
    expect(plan.nodes).toHaveLength(2)
    expect(plan.nodes.map((n) => n.id)).toEqual(['node-0', 'node-2'])
    // node-2 should still depend on node-0 but not node-1
    const node2 = plan.nodes.find((n) => n.id === 'node-2')
    expect(node2!.dependsOn).toEqual(['node-0'])
  })

  it('should remove dangling dependency references after filtering', async () => {
    const llmResponse = JSON.stringify({
      nodes: [
        { id: 'node-0', task: 'Invalid task', specialistId: 'bad-agent', dependsOn: [] },
        { id: 'node-1', task: 'Build API', specialistId: 'api-agent', dependsOn: ['node-0'] },
      ],
    })
    const llm = createMockLLM(llmResponse)

    const agent = new PlanningAgent({ supervisor })
    const plan = await agent.decompose('Build feature', llm)

    expect(plan.nodes).toHaveLength(1)
    // dependsOn should be cleaned (node-0 was removed)
    expect(plan.nodes[0]!.dependsOn).toEqual([])
  })

  it('should throw when all specialist IDs are invalid', async () => {
    const llmResponse = JSON.stringify({
      nodes: [
        { id: 'node-0', task: 'Task', specialistId: 'nonexistent-a', dependsOn: [] },
        { id: 'node-1', task: 'Task 2', specialistId: 'nonexistent-b', dependsOn: [] },
      ],
    })
    const llm = createMockLLM(llmResponse)

    const agent = new PlanningAgent({ supervisor })
    await expect(agent.decompose('Build feature', llm)).rejects.toThrow(
      /no valid nodes/i,
    )
  })

  it('should detect cycles produced by the LLM', async () => {
    const llmResponse = JSON.stringify({
      nodes: [
        { id: 'node-0', task: 'Task A', specialistId: 'db-agent', dependsOn: ['node-1'] },
        { id: 'node-1', task: 'Task B', specialistId: 'api-agent', dependsOn: ['node-0'] },
      ],
    })
    const llm = createMockLLM(llmResponse)

    const agent = new PlanningAgent({ supervisor })
    await expect(agent.decompose('Cyclic goal', llm)).rejects.toThrow(/Cycle detected/)
  })

  it('should handle parallel nodes (no deps)', async () => {
    const llmResponse = JSON.stringify({
      nodes: [
        { id: 'node-0', task: 'DB work', specialistId: 'db-agent', dependsOn: [] },
        { id: 'node-1', task: 'API work', specialistId: 'api-agent', dependsOn: [] },
        { id: 'node-2', task: 'UI work', specialistId: 'ui-agent', dependsOn: [] },
      ],
    })
    const llm = createMockLLM(llmResponse)

    const agent = new PlanningAgent({ supervisor })
    const plan = await agent.decompose('Do everything', llm)

    expect(plan.executionLevels).toHaveLength(1)
    expect(plan.executionLevels[0]).toHaveLength(3)
  })

  it('should respect maxNodes option', async () => {
    const nodes = Array.from({ length: 10 }, (_, i) => ({
      id: `node-${i}`,
      task: `Task ${i}`,
      specialistId: ['db-agent', 'api-agent', 'ui-agent'][i % 3],
      dependsOn: [] as string[],
    }))
    const llmResponse = JSON.stringify({ nodes })
    const llm = createMockLLM(llmResponse)

    const agent = new PlanningAgent({ supervisor })
    const plan = await agent.decompose('Many tasks', llm, { maxNodes: 3 })

    expect(plan.nodes.length).toBeLessThanOrEqual(3)
  })

  it('should include specialist descriptions in the system prompt', async () => {
    const llmResponse = JSON.stringify({
      nodes: [
        { id: 'node-0', task: 'Schema', specialistId: 'db-agent', dependsOn: [] },
      ],
    })
    const llm = createMockLLM(llmResponse)

    const agent = new PlanningAgent({ supervisor })
    await agent.decompose('Build feature', llm)

    const messages = (llm.invoke as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Array<{ role: string; content: string }>
    const systemContent = messages[0]!.content
    expect(systemContent).toContain('Handles database schemas and migrations')
    expect(systemContent).toContain('db-agent')
    expect(systemContent).toContain('database')
  })
})

// ---------------------------------------------------------------------------
// DelegatingSupervisor.planAndDelegate with LLM
// ---------------------------------------------------------------------------

describe('DelegatingSupervisor.planAndDelegate with LLM', () => {
  it('should use keyword fallback when no LLM is provided', async () => {
    const { DelegatingSupervisor: RealSupervisor } = await import(
      '../orchestration/delegating-supervisor.js'
    )
    const { InMemoryRunStore, createEventBus } = await import('@dzupagent/core')
    const { SimpleDelegationTracker } = await import('../orchestration/delegation.js')

    const store = new InMemoryRunStore()
    const eventBus = createEventBus()

    const executor = async (runId: string, _agentId: string, _input: unknown, signal: AbortSignal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      await new Promise((resolve) => setTimeout(resolve, 5))
      await store.update(runId, {
        status: 'completed',
        output: 'done',
        completedAt: new Date(),
      })
    }

    const specialists = new Map<string, AgentExecutionSpec>([
      ['db-agent', {
        id: 'db-agent',
        name: 'Database Agent',
        description: 'Database work',
        instructions: '',
        modelTier: 'standard',
        metadata: { tags: ['database', 'sql'] },
      }],
    ])

    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor,
    })

    const supervisor = new RealSupervisor({ specialists, tracker, eventBus })

    // Call without LLM — should use keyword fallback
    const result = await supervisor.planAndDelegate('set up the database schema')
    expect(result.succeeded.length).toBeGreaterThan(0)
  })

  it('should fall back to keywords when LLM fails', async () => {
    const { DelegatingSupervisor: RealSupervisor } = await import(
      '../orchestration/delegating-supervisor.js'
    )
    const { InMemoryRunStore } = await import('@dzupagent/core')
    const { SimpleDelegationTracker } = await import('../orchestration/delegation.js')

    const store = new InMemoryRunStore()

    const executor = async (runId: string, _agentId: string, _input: unknown, signal: AbortSignal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      await new Promise((resolve) => setTimeout(resolve, 5))
      await store.update(runId, {
        status: 'completed',
        output: 'done',
        completedAt: new Date(),
      })
    }

    const specialists = new Map<string, AgentExecutionSpec>([
      ['db-agent', {
        id: 'db-agent',
        name: 'Database Agent',
        description: 'Database work',
        instructions: '',
        modelTier: 'standard',
        metadata: { tags: ['database', 'sql'] },
      }],
    ])

    const emitSpy = vi.fn()
    const eventBus = {
      emit: emitSpy,
      on: vi.fn(() => vi.fn()),
      off: vi.fn(),
    } as unknown as DzupEventBus

    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor,
    })

    const supervisor = new RealSupervisor({ specialists, tracker, eventBus })

    // LLM that throws
    const failingLlm: StructuredLLM = {
      invoke: vi.fn(async () => { throw new Error('LLM unavailable') }),
    }

    const result = await supervisor.planAndDelegate('set up the database schema', {
      llm: failingLlm,
    })

    // Should succeed via keyword fallback
    expect(result.succeeded.length).toBeGreaterThan(0)

    // Should have emitted a fallback event
    const fallbackEvents = emitSpy.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>).type === 'supervisor:llm_decompose_fallback',
    )
    expect(fallbackEvents.length).toBe(1)
  })
})
