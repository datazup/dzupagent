import { createEventBus, type AgentExecutionSpec, type DzupEvent } from '@dzupagent/core'
import { describe, expect, it, vi } from 'vitest'
import { DelegatingSupervisor } from '../orchestration/delegating-supervisor.js'
import type {
  AggregatedDelegationResult,
  TaskAssignment,
} from '../orchestration/delegating-supervisor-types.js'
import type {
  DelegationResult,
  DelegationTracker,
} from '../orchestration/delegation.js'
import type {
  MergedResult,
  OrchestrationMergeStrategy,
} from '../orchestration/orchestration-merge-strategy-types.js'
import { aggregateSettledResults } from '../orchestration/parallel-delegation-aggregator.js'

function fulfilled(value: DelegationResult): PromiseSettledResult<DelegationResult> {
  return { status: 'fulfilled', value }
}

const assignments: TaskAssignment[] = [
  { id: 'db-task', task: 'Create schema', specialistId: 'db', input: {} },
  { id: 'api-task', task: 'Build API', specialistId: 'api', input: {} },
]

const settled = [
  fulfilled({ success: true, output: 'schema', metadata: { durationMs: 3 } }),
  fulfilled({
    success: false,
    output: null,
    error: 'API failed',
    metadata: { durationMs: 5 },
  }),
]

function mergedResult(output: unknown = 'combined'): MergedResult {
  return {
    status: 'partial',
    output,
    agentResults: [
      { agentId: 'db-task', status: 'success', output: 'schema', durationMs: 3 },
      { agentId: 'api-task', status: 'error', output: null, error: 'API failed', durationMs: 5 },
    ],
    successCount: 1,
    timeoutCount: 0,
    errorCount: 1,
  }
}

function aggregateWith(merged: MergedResult) {
  const merge = vi.fn(() => merged)
  const result = aggregateSettledResults({
    startedAt: Date.now(),
    assignments,
    settled,
    mergeStrategy: { merge },
  })
  return { merge, result }
}

function specialist(id: string, tags: string[] = []): AgentExecutionSpec {
  return {
    id,
    name: id,
    instructions: `You are the ${id} specialist`,
    modelTier: 'codegen',
    metadata: { tags },
  }
}

function trackerReturning(output: unknown): DelegationTracker {
  return {
    delegate: vi.fn(async () => ({ success: true, output })),
    getActiveDelegations: vi.fn(() => []),
    cancel: vi.fn(() => false),
  }
}

function supervisorWith(
  mergeStrategy: OrchestrationMergeStrategy,
  specialists: Map<string, AgentExecutionSpec>,
): DelegatingSupervisor {
  return new DelegatingSupervisor({
    specialists,
    tracker: trackerReturning('specialist-output'),
    mergeStrategy,
  })
}

describe('parallel delegation merged-result output integrity', () => {
  it('returns the exact complete partial MergedResult object', () => {
    const merged = mergedResult()

    const { result } = aggregateWith(merged)

    expect(result.merged).toBe(merged)
    expect(result.merged).toMatchObject({
      status: 'partial',
      output: 'combined',
      agentResults: merged.agentResults,
      successCount: 1,
      timeoutCount: 0,
      errorCount: 1,
    })
    expect(result.results.size).toBe(2)
    expect(result.succeeded).toEqual(['db-task'])
    expect(result.failed).toEqual(['api-task'])
  })

  it.each([
    ['false', false],
    ['zero', 0],
    ['empty string', ''],
    ['null', null],
  ])('preserves a %s merged output', (_label, output) => {
    const merged = mergedResult(output)

    const { result } = aggregateWith(merged)

    expect(result.merged).toBe(merged)
    expect(result.merged?.output).toBe(output)
  })

  it('uses one merge result for both telemetry and the returned aggregate', () => {
    const events: DzupEvent[] = []
    const eventBus = createEventBus()
    eventBus.onAny((event) => {
      events.push(event)
    })
    const merged: MergedResult = {
      ...mergedResult(),
      status: 'all_failed',
      successCount: 7,
      timeoutCount: 13,
      errorCount: 11,
    }
    const merge = vi.fn(() => merged)

    const result = aggregateSettledResults({
      startedAt: Date.now(),
      assignments,
      settled,
      mergeStrategy: { merge },
      eventBus,
    })

    expect(merge).toHaveBeenCalledTimes(1)
    expect(result.merged).toBe(merged)
    expect(events.find((event) => event.type === 'supervisor:merge_complete')).toMatchObject({
      mergeStatus: 'all_failed',
      successCount: 7,
      errorCount: 11,
    })
  })

  it('keeps the legacy aggregate shape when no merge strategy is configured', () => {
    const result = aggregateSettledResults({
      startedAt: Date.now(),
      assignments,
      settled,
    })

    expect(result).not.toHaveProperty('merged')
  })

  it('does not merge an empty batch or add an undefined merged property', () => {
    const merge = vi.fn(() => mergedResult())

    const result = aggregateSettledResults({
      startedAt: Date.now(),
      assignments: [],
      settled: [],
      mergeStrategy: { merge },
    })

    expect(merge).not.toHaveBeenCalled()
    expect(result).not.toHaveProperty('merged')
  })

  it('surfaces the exact merge object through delegateAndCollect', async () => {
    const merged = mergedResult()
    const merge = vi.fn(() => merged)
    const supervisor = supervisorWith(
      { merge },
      new Map([
        ['db', specialist('db')],
        ['api', specialist('api')],
      ]),
    )

    const result = await supervisor.delegateAndCollect(assignments)

    expect(merge).toHaveBeenCalledTimes(1)
    expect(result.merged).toBe(merged)
  })

  it('surfaces the exact merge object through keyword planAndDelegate', async () => {
    const merged = mergedResult('keyword-merged')
    const merge = vi.fn(() => merged)
    const supervisor = supervisorWith(
      { merge },
      new Map([['db', specialist('db', ['database', 'schema'])]]),
    )

    const result = await supervisor.planAndDelegate('create the database schema')

    expect(merge).toHaveBeenCalledTimes(1)
    expect(result.merged).toBe(merged)
  })

  it('keeps existing aggregate literals type-compatible', () => {
    const legacy: AggregatedDelegationResult = {
      results: new Map(),
      succeeded: [],
      failed: [],
      totalDurationMs: 0,
    }

    expect(legacy).not.toHaveProperty('merged')
  })
})
