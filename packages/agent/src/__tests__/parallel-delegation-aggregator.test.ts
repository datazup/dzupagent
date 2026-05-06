import { describe, it, expect, vi } from 'vitest'
import { createEventBus, type DzupEvent } from '@dzupagent/core'
import { aggregateSettledResults } from '../orchestration/parallel-delegation-aggregator.js'
import { markCircuitBreakerRecorded } from '../orchestration/circuit-breaker-recorder.js'
import type { AgentCircuitBreaker } from '../orchestration/circuit-breaker.js'
import type { DelegationResult } from '../orchestration/delegation.js'
import type { TaskAssignment } from '../orchestration/delegating-supervisor-types.js'
import type {
  MergedResult,
  OrchestrationMergeStrategy,
} from '../orchestration/orchestration-merge-strategy-types.js'

function fulfilled(value: DelegationResult): PromiseSettledResult<DelegationResult> {
  return { status: 'fulfilled', value }
}

function rejected(reason: unknown): PromiseSettledResult<DelegationResult> {
  return { status: 'rejected', reason }
}

describe('aggregateSettledResults', () => {
  it('keys results by assignment.id when supplied, otherwise by specialistId', () => {
    const assignments: TaskAssignment[] = [
      { id: 'task-1', task: 't1', specialistId: 'db', input: {} },
      { task: 't2', specialistId: 'api', input: {} },
    ]
    const settled = [
      fulfilled({ success: true, output: 'ok-1', metadata: { durationMs: 5 } }),
      fulfilled({ success: true, output: 'ok-2', metadata: { durationMs: 7 } }),
    ]

    const result = aggregateSettledResults({
      startedAt: Date.now() - 1,
      assignments,
      settled,
    })

    expect(result.succeeded).toEqual(['task-1', 'api'])
    expect(result.failed).toEqual([])
    expect(result.results.get('task-1')?.metadata?.specialistId).toBe('db')
    expect(result.results.get('api')?.metadata?.assignmentId).toBe('api')
  })

  it('records breaker failures only for rejected outcomes that are not already tagged', () => {
    const breaker = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      recordTimeout: vi.fn(),
      filterAvailable: vi.fn(),
    } as unknown as AgentCircuitBreaker

    const tagged = new Error('already tagged')
    markCircuitBreakerRecorded(tagged)
    const fresh = new Error('connection refused')

    const assignments: TaskAssignment[] = [
      { task: 't1', specialistId: 'db', input: {} },
      { task: 't2', specialistId: 'api', input: {} },
    ]
    const settled = [rejected(tagged), rejected(fresh)]

    const result = aggregateSettledResults({
      startedAt: Date.now() - 1,
      assignments,
      settled,
      circuitBreaker: breaker,
    })

    expect(result.failed).toEqual(['db', 'api'])
    expect(breaker.recordFailure).toHaveBeenCalledTimes(1)
    expect(breaker.recordFailure).toHaveBeenCalledWith('api')
  })

  it('classifies rejected outcomes containing "timeout" via recordTimeout', () => {
    const breaker = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      recordTimeout: vi.fn(),
      filterAvailable: vi.fn(),
    } as unknown as AgentCircuitBreaker

    const result = aggregateSettledResults({
      startedAt: Date.now() - 1,
      assignments: [{ task: 't1', specialistId: 'slow', input: {} }],
      settled: [rejected(new Error('TIMEOUT after 30s'))],
      circuitBreaker: breaker,
    })

    expect(result.failed).toEqual(['slow'])
    expect(breaker.recordTimeout).toHaveBeenCalledWith('slow')
  })

  it('invokes the merge strategy and emits supervisor:merge_complete', () => {
    const events: DzupEvent[] = []
    const bus = createEventBus()
    bus.onAny((e) => events.push(e))

    const merged: MergedResult = {
      output: 'merged',
      status: 'success',
      agentResults: [],
      successCount: 2,
      timeoutCount: 0,
      errorCount: 0,
    }
    const merge = vi.fn(() => merged)
    const mergeStrategy: OrchestrationMergeStrategy = { merge }

    const assignments: TaskAssignment[] = [
      { task: 't1', specialistId: 'db', input: {} },
      { task: 't2', specialistId: 'api', input: {} },
    ]
    const settled = [
      fulfilled({ success: true, output: 'a', metadata: { durationMs: 1 } }),
      fulfilled({ success: true, output: 'b', metadata: { durationMs: 2 } }),
    ]

    aggregateSettledResults({
      startedAt: Date.now() - 1,
      assignments,
      settled,
      mergeStrategy,
      eventBus: bus,
    })

    expect(merge).toHaveBeenCalled()
    const mergeEvent = events.find((e) => e.type === 'supervisor:merge_complete')
    expect(mergeEvent).toMatchObject({ mergeStatus: 'success', successCount: 2 })
  })

  it('does not call merge strategy on an empty results map', () => {
    const merge = vi.fn()
    const mergeStrategy: OrchestrationMergeStrategy = { merge }

    const result = aggregateSettledResults({
      startedAt: Date.now(),
      assignments: [],
      settled: [],
      mergeStrategy,
    })

    expect(merge).not.toHaveBeenCalled()
    expect(result.results.size).toBe(0)
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
  })
})
