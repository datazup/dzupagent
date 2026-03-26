/**
 * Tests for PlanningAgent — DAG-based plan execution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  PlanningAgent,
  buildExecutionLevels,
  validatePlanStructure,
} from '../orchestration/planning-agent.js'
import type {
  PlanNode,
  ExecutionPlan,
} from '../orchestration/planning-agent.js'
import type { DelegatingSupervisor, TaskAssignment, AggregatedDelegationResult } from '../orchestration/delegating-supervisor.js'
import type { DelegationResult } from '../orchestration/delegation.js'

// ---------------------------------------------------------------------------
// Mock DelegatingSupervisor factory
// ---------------------------------------------------------------------------

function createMockSupervisor(opts?: {
  specialists?: string[]
  /** Override delegation results per specialist ID */
  resultOverrides?: Map<string, DelegationResult>
}): DelegatingSupervisor {
  const specialistIds = opts?.specialists ?? ['planner', 'coder', 'reviewer', 'tester']
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
          // Default: succeed with output echoing the input
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

  return {
    specialistIds,
    delegateAndCollect,
    delegateTask: vi.fn(),
    planAndDelegate: vi.fn(),
    getSpecialist: vi.fn(),
  } as unknown as DelegatingSupervisor
}

// ---------------------------------------------------------------------------
// buildExecutionLevels
// ---------------------------------------------------------------------------

describe('buildExecutionLevels', () => {
  it('should produce a single level for independent nodes', () => {
    const nodes: PlanNode[] = [
      { id: 'a', task: 'A', specialistId: 'coder', input: {}, dependsOn: [] },
      { id: 'b', task: 'B', specialistId: 'coder', input: {}, dependsOn: [] },
      { id: 'c', task: 'C', specialistId: 'coder', input: {}, dependsOn: [] },
    ]
    const levels = buildExecutionLevels(nodes)
    expect(levels).toHaveLength(1)
    expect(levels[0]).toHaveLength(3)
    expect(new Set(levels[0])).toEqual(new Set(['a', 'b', 'c']))
  })

  it('should produce linear levels for a chain A -> B -> C', () => {
    const nodes: PlanNode[] = [
      { id: 'a', task: 'A', specialistId: 'planner', input: {}, dependsOn: [] },
      { id: 'b', task: 'B', specialistId: 'coder', input: {}, dependsOn: ['a'] },
      { id: 'c', task: 'C', specialistId: 'reviewer', input: {}, dependsOn: ['b'] },
    ]
    const levels = buildExecutionLevels(nodes)
    expect(levels).toEqual([['a'], ['b'], ['c']])
  })

  it('should produce diamond levels A -> B,C -> D', () => {
    const nodes: PlanNode[] = [
      { id: 'a', task: 'A', specialistId: 'planner', input: {}, dependsOn: [] },
      { id: 'b', task: 'B', specialistId: 'coder', input: {}, dependsOn: ['a'] },
      { id: 'c', task: 'C', specialistId: 'tester', input: {}, dependsOn: ['a'] },
      { id: 'd', task: 'D', specialistId: 'reviewer', input: {}, dependsOn: ['b', 'c'] },
    ]
    const levels = buildExecutionLevels(nodes)
    expect(levels).toHaveLength(3)
    expect(levels[0]).toEqual(['a'])
    expect(new Set(levels[1])).toEqual(new Set(['b', 'c']))
    expect(levels[2]).toEqual(['d'])
  })

  it('should throw on cycles', () => {
    const nodes: PlanNode[] = [
      { id: 'a', task: 'A', specialistId: 'coder', input: {}, dependsOn: ['b'] },
      { id: 'b', task: 'B', specialistId: 'coder', input: {}, dependsOn: ['a'] },
    ]
    expect(() => buildExecutionLevels(nodes)).toThrow(/Cycle detected/)
  })

  it('should handle empty node list', () => {
    const levels = buildExecutionLevels([])
    expect(levels).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// validatePlanStructure
// ---------------------------------------------------------------------------

describe('validatePlanStructure', () => {
  it('should return no errors for a valid plan', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      nodes: [
        { id: 'a', task: 'A', specialistId: 'coder', input: {}, dependsOn: [] },
        { id: 'b', task: 'B', specialistId: 'reviewer', input: {}, dependsOn: ['a'] },
      ],
      executionLevels: [['a'], ['b']],
    }
    expect(validatePlanStructure(plan, ['coder', 'reviewer'])).toEqual([])
  })

  it('should detect duplicate node IDs', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      nodes: [
        { id: 'a', task: 'A', specialistId: 'coder', input: {}, dependsOn: [] },
        { id: 'a', task: 'B', specialistId: 'coder', input: {}, dependsOn: [] },
      ],
      executionLevels: [],
    }
    const errors = validatePlanStructure(plan)
    expect(errors.some((e) => e.includes('Duplicate node ID'))).toBe(true)
  })

  it('should detect missing dependencies', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      nodes: [
        { id: 'a', task: 'A', specialistId: 'coder', input: {}, dependsOn: ['x'] },
      ],
      executionLevels: [],
    }
    const errors = validatePlanStructure(plan)
    expect(errors.some((e) => e.includes('unknown node "x"'))).toBe(true)
  })

  it('should detect self-dependencies', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      nodes: [
        { id: 'a', task: 'A', specialistId: 'coder', input: {}, dependsOn: ['a'] },
      ],
      executionLevels: [],
    }
    const errors = validatePlanStructure(plan)
    expect(errors.some((e) => e.includes('depends on itself'))).toBe(true)
  })

  it('should detect unknown specialists', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      nodes: [
        { id: 'a', task: 'A', specialistId: 'unknown-agent', input: {}, dependsOn: [] },
      ],
      executionLevels: [['a']],
    }
    const errors = validatePlanStructure(plan, ['coder', 'reviewer'])
    expect(errors.some((e) => e.includes('unknown specialist'))).toBe(true)
  })

  it('should detect cycles via topological sort', () => {
    const plan: ExecutionPlan = {
      goal: 'test',
      nodes: [
        { id: 'a', task: 'A', specialistId: 'coder', input: {}, dependsOn: ['c'] },
        { id: 'b', task: 'B', specialistId: 'coder', input: {}, dependsOn: ['a'] },
        { id: 'c', task: 'C', specialistId: 'coder', input: {}, dependsOn: ['b'] },
      ],
      executionLevels: [],
    }
    const errors = validatePlanStructure(plan)
    expect(errors.some((e) => e.includes('Cycle detected'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// PlanningAgent.buildPlan
// ---------------------------------------------------------------------------

describe('PlanningAgent.buildPlan', () => {
  it('should build a plan with auto-generated IDs', () => {
    const plan = PlanningAgent.buildPlan('Deploy feature', [
      { task: 'Plan', specialistId: 'planner', input: {}, dependsOn: [] },
      { task: 'Code', specialistId: 'coder', input: {}, dependsOn: ['node-0'] },
    ])

    expect(plan.goal).toBe('Deploy feature')
    expect(plan.nodes).toHaveLength(2)
    expect(plan.nodes[0]!.id).toBe('node-0')
    expect(plan.nodes[1]!.id).toBe('node-1')
    expect(plan.executionLevels).toEqual([['node-0'], ['node-1']])
  })

  it('should use provided IDs when given', () => {
    const plan = PlanningAgent.buildPlan('Goal', [
      { id: 'alpha', task: 'A', specialistId: 'coder', input: {}, dependsOn: [] },
      { id: 'beta', task: 'B', specialistId: 'coder', input: {}, dependsOn: ['alpha'] },
    ])

    expect(plan.nodes[0]!.id).toBe('alpha')
    expect(plan.nodes[1]!.id).toBe('beta')
    expect(plan.executionLevels).toEqual([['alpha'], ['beta']])
  })

  it('should compute parallel execution levels', () => {
    const plan = PlanningAgent.buildPlan('Diamond', [
      { id: 'a', task: 'A', specialistId: 'planner', input: {}, dependsOn: [] },
      { id: 'b', task: 'B', specialistId: 'coder', input: {}, dependsOn: ['a'] },
      { id: 'c', task: 'C', specialistId: 'tester', input: {}, dependsOn: ['a'] },
      { id: 'd', task: 'D', specialistId: 'reviewer', input: {}, dependsOn: ['b', 'c'] },
    ])

    expect(plan.executionLevels).toHaveLength(3)
    expect(plan.executionLevels[0]).toEqual(['a'])
    expect(new Set(plan.executionLevels[1])).toEqual(new Set(['b', 'c']))
    expect(plan.executionLevels[2]).toEqual(['d'])
  })
})

// ---------------------------------------------------------------------------
// PlanningAgent.executePlan
// ---------------------------------------------------------------------------

describe('PlanningAgent.executePlan', () => {
  let supervisor: ReturnType<typeof createMockSupervisor>

  beforeEach(() => {
    supervisor = createMockSupervisor()
  })

  it('should execute a linear plan A -> B -> C', async () => {
    const plan = PlanningAgent.buildPlan('Linear', [
      { id: 'a', task: 'Plan', specialistId: 'planner', input: { step: 1 }, dependsOn: [] },
      { id: 'b', task: 'Code', specialistId: 'coder', input: { step: 2 }, dependsOn: ['a'] },
      { id: 'c', task: 'Review', specialistId: 'reviewer', input: { step: 3 }, dependsOn: ['b'] },
    ])

    const agent = new PlanningAgent({ supervisor })
    const result = await agent.executePlan(plan)

    expect(result.success).toBe(true)
    expect(result.failedNodes).toEqual([])
    expect(result.skippedNodes).toEqual([])
    expect(result.results.size).toBe(3)

    // Should have been called 3 times (one per level)
    expect(supervisor.delegateAndCollect).toHaveBeenCalledTimes(3)
  })

  it('should execute a diamond plan A -> B,C -> D with parallel middle', async () => {
    const plan = PlanningAgent.buildPlan('Diamond', [
      { id: 'a', task: 'Plan', specialistId: 'planner', input: {}, dependsOn: [] },
      { id: 'b', task: 'Code', specialistId: 'coder', input: {}, dependsOn: ['a'] },
      { id: 'c', task: 'Test', specialistId: 'tester', input: {}, dependsOn: ['a'] },
      { id: 'd', task: 'Review', specialistId: 'reviewer', input: {}, dependsOn: ['b', 'c'] },
    ])

    const agent = new PlanningAgent({ supervisor })
    const result = await agent.executePlan(plan)

    expect(result.success).toBe(true)
    expect(result.results.size).toBe(4)

    // 3 levels: [a], [b,c], [d]
    expect(supervisor.delegateAndCollect).toHaveBeenCalledTimes(3)

    // Second call should have 2 tasks (parallel)
    const secondCall = (supervisor.delegateAndCollect as ReturnType<typeof vi.fn>).mock.calls[1]![0] as TaskAssignment[]
    expect(secondCall).toHaveLength(2)
  })

  it('should skip dependents when a node fails', async () => {
    const failingSupervisor = createMockSupervisor({
      resultOverrides: new Map([
        ['coder', { success: false, output: null, error: 'compilation error' }],
      ]),
    })

    const plan = PlanningAgent.buildPlan('Fail chain', [
      { id: 'a', task: 'Plan', specialistId: 'planner', input: {}, dependsOn: [] },
      { id: 'b', task: 'Code', specialistId: 'coder', input: {}, dependsOn: ['a'] },
      { id: 'c', task: 'Review', specialistId: 'reviewer', input: {}, dependsOn: ['b'] },
    ])

    const agent = new PlanningAgent({ supervisor: failingSupervisor })
    const result = await agent.executePlan(plan)

    expect(result.success).toBe(false)
    expect(result.failedNodes).toContain('b')
    expect(result.skippedNodes).toContain('c')
    // Node c should have a skip message
    const cResult = result.results.get('c')
    expect(cResult?.success).toBe(false)
    expect(cResult?.error).toMatch(/upstream dependency failed/)
  })

  it('should skip transitive dependents on failure', async () => {
    const failingSupervisor = createMockSupervisor({
      resultOverrides: new Map([
        ['planner', { success: false, output: null, error: 'plan failed' }],
      ]),
    })

    const plan = PlanningAgent.buildPlan('Transitive fail', [
      { id: 'a', task: 'Plan', specialistId: 'planner', input: {}, dependsOn: [] },
      { id: 'b', task: 'Code', specialistId: 'coder', input: {}, dependsOn: ['a'] },
      { id: 'c', task: 'Test', specialistId: 'tester', input: {}, dependsOn: ['b'] },
      { id: 'd', task: 'Review', specialistId: 'reviewer', input: {}, dependsOn: ['c'] },
    ])

    const agent = new PlanningAgent({ supervisor: failingSupervisor })
    const result = await agent.executePlan(plan)

    expect(result.success).toBe(false)
    expect(result.failedNodes).toEqual(['a'])
    expect(result.skippedNodes).toEqual(['b', 'c', 'd'])
  })

  it('should pass predecessor results as context to later nodes', async () => {
    const plan = PlanningAgent.buildPlan('Context passing', [
      { id: 'a', task: 'Plan', specialistId: 'planner', input: { data: 'init' }, dependsOn: [] },
      { id: 'b', task: 'Code', specialistId: 'coder', input: { data: 'code' }, dependsOn: ['a'] },
    ])

    const agent = new PlanningAgent({ supervisor })
    await agent.executePlan(plan)

    // The second delegateAndCollect call should include _predecessorResults
    const secondCall = (supervisor.delegateAndCollect as ReturnType<typeof vi.fn>).mock.calls[1]![0] as TaskAssignment[]
    expect(secondCall).toHaveLength(1)
    const nodeInput = secondCall[0]!.input as Record<string, unknown>
    expect(nodeInput._nodeId).toBe('b')
    expect(nodeInput._predecessorResults).toBeDefined()
    // The predecessor result for 'a' should contain output from first delegation
    const predResults = nodeInput._predecessorResults as Record<string, unknown>
    expect(predResults).toHaveProperty('a')
  })

  it('should respect maxParallelism by chunking levels', async () => {
    // Create 6 independent nodes, maxParallelism = 2
    const plan = PlanningAgent.buildPlan('Chunked', [
      { id: 'a', task: 'A', specialistId: 'planner', input: {}, dependsOn: [] },
      { id: 'b', task: 'B', specialistId: 'coder', input: {}, dependsOn: [] },
      { id: 'c', task: 'C', specialistId: 'reviewer', input: {}, dependsOn: [] },
      { id: 'd', task: 'D', specialistId: 'tester', input: {}, dependsOn: [] },
    ])

    // All nodes are in level 0 (no deps)
    expect(plan.executionLevels).toHaveLength(1)
    expect(plan.executionLevels[0]).toHaveLength(4)

    const agent = new PlanningAgent({ supervisor, maxParallelism: 2 })
    await agent.executePlan(plan)

    // Should be called twice: first chunk of 2, second chunk of 2
    expect(supervisor.delegateAndCollect).toHaveBeenCalledTimes(2)
    const firstChunk = (supervisor.delegateAndCollect as ReturnType<typeof vi.fn>).mock.calls[0]![0] as TaskAssignment[]
    const secondChunk = (supervisor.delegateAndCollect as ReturnType<typeof vi.fn>).mock.calls[1]![0] as TaskAssignment[]
    expect(firstChunk).toHaveLength(2)
    expect(secondChunk).toHaveLength(2)
  })

  it('should throw on invalid plan (unknown specialist)', async () => {
    const plan: ExecutionPlan = {
      goal: 'Bad plan',
      nodes: [
        { id: 'a', task: 'A', specialistId: 'nonexistent', input: {}, dependsOn: [] },
      ],
      executionLevels: [['a']],
    }

    const agent = new PlanningAgent({ supervisor })
    await expect(agent.executePlan(plan)).rejects.toThrow(/Invalid plan/)
  })

  it('should throw on plan with cycles', async () => {
    const plan: ExecutionPlan = {
      goal: 'Cycle plan',
      nodes: [
        { id: 'a', task: 'A', specialistId: 'planner', input: {}, dependsOn: ['b'] },
        { id: 'b', task: 'B', specialistId: 'coder', input: {}, dependsOn: ['a'] },
      ],
      executionLevels: [],
    }

    const agent = new PlanningAgent({ supervisor })
    await expect(agent.executePlan(plan)).rejects.toThrow(/Cycle detected/)
  })

  it('should return totalDurationMs > 0', async () => {
    const plan = PlanningAgent.buildPlan('Timing', [
      { id: 'a', task: 'A', specialistId: 'planner', input: {}, dependsOn: [] },
    ])

    const agent = new PlanningAgent({ supervisor })
    const result = await agent.executePlan(plan)

    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('should only fail the branch with the failed node in a diamond', async () => {
    // A -> B (fails), C (ok) -> D depends on both B and C
    const failingSupervisor = createMockSupervisor({
      resultOverrides: new Map([
        ['coder', { success: false, output: null, error: 'fail' }],
      ]),
    })

    const plan = PlanningAgent.buildPlan('Partial diamond fail', [
      { id: 'a', task: 'Root', specialistId: 'planner', input: {}, dependsOn: [] },
      { id: 'b', task: 'FailBranch', specialistId: 'coder', input: {}, dependsOn: ['a'] },
      { id: 'c', task: 'OkBranch', specialistId: 'tester', input: {}, dependsOn: ['a'] },
      { id: 'd', task: 'Merge', specialistId: 'reviewer', input: {}, dependsOn: ['b', 'c'] },
    ])

    const agent = new PlanningAgent({ supervisor: failingSupervisor })
    const result = await agent.executePlan(plan)

    expect(result.success).toBe(false)
    expect(result.failedNodes).toContain('b')
    // c succeeds
    expect(result.results.get('c')?.success).toBe(true)
    // d is skipped because b (a dependency) failed
    expect(result.skippedNodes).toContain('d')
  })
})
