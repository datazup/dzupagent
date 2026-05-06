import { describe, it, expect, vi } from 'vitest'
import { createEventBus, type AgentExecutionSpec, type DzupEvent } from '@dzupagent/core'
import {
  decomposeGoal,
  matchSubtasksToSpecialists,
  routeSubtasksViaPolicy,
  scoreMatch,
  toAgentSpecs,
} from '../orchestration/specialist-selection.js'
import type { AgentCircuitBreaker } from '../orchestration/circuit-breaker.js'
import type {
  RoutingPolicy,
  AgentSpec,
  RoutingDecision,
} from '../orchestration/routing-policy-types.js'

function spec(
  partial: Partial<AgentExecutionSpec> & { id?: string } = {},
): AgentExecutionSpec {
  return {
    id: partial.id ?? 'spec',
    name: partial.name ?? 'Spec',
    tools: partial.tools ?? [],
    metadata: partial.metadata ?? {},
  } as unknown as AgentExecutionSpec
}

describe('decomposeGoal', () => {
  it('splits on commas, semicolons, newlines, and "and"', () => {
    expect(decomposeGoal('build api, write tests; update docs\nand deploy')).toEqual([
      'build api',
      'write tests',
      'update docs',
      'deploy',
    ])
  })

  it('drops empty fragments and trims whitespace', () => {
    expect(decomposeGoal('  ,  build api  ,  ')).toEqual(['build api'])
  })
})

describe('scoreMatch', () => {
  it('boosts matches against metadata tags more than tool overlap', () => {
    const def = spec({
      id: 'db-agent',
      name: 'DB Agent',
      tools: ['migrate'],
      metadata: { tags: ['database'] },
    })
    expect(scoreMatch('write a database migration', 'db-agent', def)).toBeGreaterThan(0)
  })

  it('returns 0 when nothing matches', () => {
    const def = spec({ id: 'unrelated', name: 'Unrelated', tools: [], metadata: {} })
    expect(scoreMatch('paint the walls', 'unrelated', def)).toBe(0)
  })

  it('matches via the built-in keyword map when both subtask and specialist agree', () => {
    const def = spec({
      id: 'security-agent',
      name: 'Security',
      tools: [],
      metadata: { tags: ['security'] },
    })
    expect(scoreMatch('add rbac authorization', 'security-agent', def)).toBeGreaterThan(0)
  })
})

describe('matchSubtasksToSpecialists', () => {
  it('assigns each subtask to the highest-scoring specialist', () => {
    const specialists = new Map<string, AgentExecutionSpec>([
      ['db', spec({ id: 'db', name: 'DB', metadata: { tags: ['database'] } })],
      ['api', spec({ id: 'api', name: 'API', metadata: { tags: ['api'] } })],
    ])
    const result = matchSubtasksToSpecialists(
      ['add database migration', 'expose REST endpoint'],
      specialists,
    )
    expect(result).toEqual([
      { task: 'add database migration', specialistId: 'db', input: { subtask: 'add database migration' } },
      { task: 'expose REST endpoint', specialistId: 'api', input: { subtask: 'expose REST endpoint' } },
    ])
  })

  it('drops subtasks that do not match any specialist', () => {
    const specialists = new Map<string, AgentExecutionSpec>([
      ['db', spec({ id: 'db', metadata: { tags: ['database'] } })],
    ])
    const result = matchSubtasksToSpecialists(['paint walls'], specialists)
    expect(result).toEqual([])
  })
})

describe('toAgentSpecs', () => {
  it('projects specialists with metadata.tags into AgentSpec[]', () => {
    const specialists = new Map<string, AgentExecutionSpec>([
      ['db', spec({ id: 'db', name: 'DB', metadata: { tags: ['database', 'sql'] } })],
    ])
    const result = toAgentSpecs(specialists)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'db', tags: ['database', 'sql'] })
  })

  it('filters through the circuit breaker when supplied', () => {
    const specialists = new Map<string, AgentExecutionSpec>([
      ['db', spec({ id: 'db' })],
      ['api', spec({ id: 'api' })],
    ])
    const breaker = {
      filterAvailable: vi.fn((agents: AgentSpec[]) =>
        agents.filter((a) => a.id !== 'db'),
      ),
    } as unknown as AgentCircuitBreaker
    const result = toAgentSpecs(specialists, breaker)
    expect(result.map((a) => a.id)).toEqual(['api'])
    expect(breaker.filterAvailable).toHaveBeenCalled()
  })
})

describe('routeSubtasksViaPolicy', () => {
  it('emits supervisor:routing_decision for each selected agent and produces assignments', () => {
    const events: DzupEvent[] = []
    const bus = createEventBus()
    bus.onAny((e) => events.push(e))

    const candidates: AgentSpec[] = [
      { id: 'db', tags: ['database'] },
      { id: 'api', tags: ['api'] },
    ]

    const policy: RoutingPolicy = {
      select: vi.fn(
        (_task, available): RoutingDecision => ({
          selected: [available[0]!],
          strategy: 'rule',
          reason: 'first-match',
        }),
      ),
    }

    const assignments = routeSubtasksViaPolicy(
      ['migrate db'],
      policy,
      candidates,
      bus,
    )

    expect(assignments).toEqual([
      { task: 'migrate db', specialistId: 'db', input: { subtask: 'migrate db' } },
    ])
    expect(events.some((e) => e.type === 'supervisor:routing_decision')).toBe(true)
  })

  it('returns no assignments when no candidates are available', () => {
    const policy: RoutingPolicy = { select: vi.fn() }
    const result = routeSubtasksViaPolicy(['something'], policy, [], undefined)
    expect(result).toEqual([])
    expect(policy.select).not.toHaveBeenCalled()
  })
})
