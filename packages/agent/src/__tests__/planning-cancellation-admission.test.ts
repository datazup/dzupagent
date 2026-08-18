import { createEventBus } from '@dzupagent/core'
import type { AgentExecutionSpec } from '@dzupagent/core'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { DelegationTracker } from '../orchestration/delegation.js'
import {
  DelegatingSupervisor,
  type AggregatedDelegationResult,
  type TaskAssignment,
} from '../orchestration/delegating-supervisor.js'
import { PlanningAgent } from '../orchestration/planning-agent.js'
import type {
  ExecutionPlan,
  PlanningSupervisor,
} from '../orchestration/planning-types.js'
import type { RoutingPolicy } from '../orchestration/routing-policy-types.js'
import { generateStructured } from '../structured/structured-output-engine.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeSpecialist(id = 'db-specialist'): AgentExecutionSpec {
  return {
    id,
    name: id,
    instructions: `You are ${id}`,
    modelTier: 'codegen',
    metadata: { tags: ['database', 'schema'] },
  }
}

function makeTracker(): DelegationTracker {
  return {
    delegate: vi.fn(async () => ({ success: true, output: 'tracker result' })),
    getActiveDelegations: vi.fn(() => []),
    cancel: vi.fn(() => false),
  }
}

function aggregateFor(tasks: TaskAssignment[]): AggregatedDelegationResult {
  const results = new Map(
    tasks.map((task) => [
      task.id ?? task.specialistId,
      { success: true as const, output: `${task.task} complete` },
    ]),
  )
  return {
    results,
    succeeded: [...results.keys()],
    failed: [],
    totalDurationMs: 1,
  }
}

function makePlanningSupervisor(
  delegateAndCollect = vi.fn(async (tasks: TaskAssignment[]) => aggregateFor(tasks)),
): PlanningSupervisor {
  return {
    specialistIds: ['db-specialist'],
    getSpecialist: vi.fn(() => makeSpecialist()),
    delegateAndCollect,
  }
}

function makeTwoLevelPlan(): ExecutionPlan {
  return {
    goal: 'build the database',
    nodes: [
      {
        id: 'node-1',
        task: 'create schema',
        specialistId: 'db-specialist',
        input: {},
        dependsOn: [],
      },
      {
        id: 'node-2',
        task: 'review schema',
        specialistId: 'db-specialist',
        input: {},
        dependsOn: ['node-1'],
      },
    ],
    executionLevels: [['node-1'], ['node-2']],
  }
}

function makeConcreteSupervisor(options?: {
  eventBus?: ReturnType<typeof createEventBus>
  providerRun?: (...args: unknown[]) => Promise<{
    content: string
    providerId: 'codex'
    attemptedProviders: ['codex']
    fallbackAttempts: number
  }>
  routingPolicy?: RoutingPolicy
}): DelegatingSupervisor {
  return new DelegatingSupervisor({
    specialists: new Map([['db-specialist', makeSpecialist()]]),
    tracker: makeTracker(),
    ...(options?.eventBus ? { eventBus: options.eventBus } : {}),
    ...(options?.routingPolicy ? { routingPolicy: options.routingPolicy } : {}),
    ...(options?.providerRun
      ? { providerPort: {
          run: options.providerRun,
          stream: vi.fn(),
        } }
      : {}),
  })
}

const valueSchema = z.object({ value: z.string() })
const validStructuredResponse = { content: JSON.stringify({ value: 'ok' }) }
const validPlanResponse = {
  content: JSON.stringify({
    nodes: [
      {
        id: 'node-1',
        task: 'create schema',
        specialistId: 'db-specialist',
        dependsOn: [],
      },
    ],
  }),
}

describe('planning cancellation admission', () => {
  describe('structured decomposition boundary', () => {
    it('rejects a pre-aborted call with the exact reason before model invocation', async () => {
      const controller = new AbortController()
      const reason = new Error('cancel before structured invocation')
      controller.abort(reason)
      const invoke = vi.fn(async () => validStructuredResponse)

      await expect(
        generateStructured({ invoke }, [], {
          schema: valueSchema,
          strategy: 'generic-parse',
          signal: controller.signal,
        }),
      ).rejects.toBe(reason)
      expect(invoke).not.toHaveBeenCalled()
    })

    it('races an ignoring model on mid-flight abort and passes it the exact signal', async () => {
      const controller = new AbortController()
      const reason = new Error('cancel ignored model')
      const invocation = deferred<typeof validStructuredResponse>()
      let receivedSignal: AbortSignal | undefined
      const invoke = vi.fn(
        async (_messages: unknown[], options?: { signal?: AbortSignal }) => {
          receivedSignal = options?.signal
          return invocation.promise
        },
      )

      const result = generateStructured({ invoke }, [], {
        schema: valueSchema,
        strategy: 'generic-parse',
        signal: controller.signal,
      })
      await Promise.resolve()
      expect(invoke).toHaveBeenCalledTimes(1)

      controller.abort(reason)
      const rejection = expect(result).rejects.toBe(reason)
      invocation.resolve(validStructuredResponse)
      await rejection
      expect(receivedSignal).toBe(controller.signal)
    })

    it('does not enter another retry or fallback strategy after abort', async () => {
      const controller = new AbortController()
      const reason = new Error('stop structured strategy chain')
      const firstInvocation = deferred<typeof validStructuredResponse>()
      const invoke = vi.fn(async () => {
        if (controller.signal.aborted) {
          throw reason
        }
        return firstInvocation.promise
      })

      const result = generateStructured({ invoke }, [], {
        schema: valueSchema,
        maxRetries: 2,
        signal: controller.signal,
        capabilities: {
          preferredStrategy: 'generic-parse',
          schemaProvider: 'generic',
          fallbackStrategies: ['fallback-prompt'],
        },
      })
      await Promise.resolve()
      expect(invoke).toHaveBeenCalledTimes(1)

      controller.abort(reason)
      firstInvocation.reject(reason)

      await expect(result).rejects.toBe(reason)
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(reason).not.toHaveProperty('structuredOutput')
    })

    it('preserves legacy one-argument structured callers without a signal', async () => {
      const invoke = vi.fn(async (_messages: unknown[]) => validStructuredResponse)

      const result = await generateStructured({ invoke }, [], {
        schema: valueSchema,
        strategy: 'generic-parse',
      })

      expect(result.data).toEqual({ value: 'ok' })
      expect(invoke).toHaveBeenCalledTimes(1)
    })
  })

  describe('DAG execution boundary', () => {
    it('rejects pre-abort before validation and delegates nothing', async () => {
      const controller = new AbortController()
      const reason = new Error('cancel before DAG validation')
      controller.abort(reason)
      const delegateAndCollect = vi.fn(async (tasks: TaskAssignment[]) => aggregateFor(tasks))
      const planner = new PlanningAgent({
        supervisor: makePlanningSupervisor(delegateAndCollect),
      })
      const invalidPlan: ExecutionPlan = {
        goal: 'invalid but cancelled',
        nodes: [],
        executionLevels: [['missing-node']],
      }

      await expect(
        planner.executePlan(invalidPlan, { signal: controller.signal }),
      ).rejects.toBe(reason)
      expect(delegateAndCollect).not.toHaveBeenCalled()
    })

    it('forwards the signal and makes an all-settled abort terminal before later levels', async () => {
      const controller = new AbortController()
      const reason = new Error('cancel after first DAG level')
      const delegateAndCollect = vi.fn(
        async (
          tasks: TaskAssignment[],
          options?: { signal?: AbortSignal },
        ) => {
          expect(options?.signal).toBe(controller.signal)
          controller.abort(reason)
          return aggregateFor(tasks)
        },
      )
      const planner = new PlanningAgent({
        supervisor: makePlanningSupervisor(delegateAndCollect),
      })

      await expect(
        planner.executePlan(makeTwoLevelPlan(), { signal: controller.signal }),
      ).rejects.toBe(reason)
      expect(delegateAndCollect).toHaveBeenCalledTimes(1)
    })

    it('preserves no-signal planning and concrete delegation behavior', async () => {
      const planner = new PlanningAgent({ supervisor: makePlanningSupervisor() })
      const planResult = await planner.executePlan(makeTwoLevelPlan())
      expect(planResult.success).toBe(true)
      expect(planResult.results.size).toBe(2)

      const providerRun = vi.fn(async () => ({
        content: 'provider result',
        providerId: 'codex' as const,
        attemptedProviders: ['codex'] as ['codex'],
        fallbackAttempts: 0,
      }))
      const supervisor = makeConcreteSupervisor({ providerRun })
      const delegated = await supervisor.delegateAndCollect([
        {
          id: 'legacy-task',
          task: 'create schema',
          specialistId: 'db-specialist',
          input: {},
        },
      ])

      expect(delegated.succeeded).toEqual(['legacy-task'])
      expect(providerRun).toHaveBeenCalledTimes(1)
    })
  })

  describe('concrete and keyword supervisor boundaries', () => {
    it('threads signal through delegateAndCollect and delegateTask and rejects mid-flight abort', async () => {
      const controller = new AbortController()
      const reason = new Error('cancel concrete delegated work')
      const providerInvocation = deferred<{
        content: string
        providerId: 'codex'
        attemptedProviders: ['codex']
        fallbackAttempts: number
      }>()
      let receivedAgentSignal: AbortSignal | undefined
      let receivedRunSignal: AbortSignal | undefined
      const providerRun = vi.fn(async (...args: unknown[]) => {
        const agentInput = args[0] as { signal?: AbortSignal }
        const runOptions = args[2] as { signal?: AbortSignal }
        receivedAgentSignal = agentInput.signal
        receivedRunSignal = runOptions.signal
        return providerInvocation.promise
      })
      const supervisor = makeConcreteSupervisor({ providerRun })

      const result = supervisor.delegateAndCollect(
        [
          {
            id: 'task-1',
            task: 'create schema',
            specialistId: 'db-specialist',
            input: {},
          },
        ],
        { signal: controller.signal },
      )
      await Promise.resolve()
      expect(providerRun).toHaveBeenCalledTimes(1)

      controller.abort(reason)
      providerInvocation.reject(reason)

      await expect(result).rejects.toBe(reason)
      expect(receivedAgentSignal).toBe(controller.signal)
      expect(receivedRunSignal).toBe(controller.signal)
    })

    it('rejects pre-aborted keyword planning before routing, events, or delegation', async () => {
      const controller = new AbortController()
      const reason = new Error('cancel before keyword routing')
      controller.abort(reason)
      const eventBus = createEventBus()
      const events: Array<{ type: string }> = []
      eventBus.onAny((event) => events.push(event))
      const select = vi.fn<RoutingPolicy['select']>((_task, candidates) => ({
        selected: [candidates[0]!],
        reason: 'selected',
        strategy: 'test',
      }))
      const supervisor = makeConcreteSupervisor({
        eventBus,
        routingPolicy: { select },
      })
      const delegateAndCollect = vi.spyOn(supervisor, 'delegateAndCollect')

      await expect(
        supervisor.planAndDelegate('create the database schema', {
          signal: controller.signal,
        }),
      ).rejects.toBe(reason)
      expect(select).not.toHaveBeenCalled()
      expect(delegateAndCollect).not.toHaveBeenCalled()
      expect(events).toEqual([])
    })

    it('makes mid-flight keyword abort terminal instead of returning an aggregate', async () => {
      const controller = new AbortController()
      const reason = new Error('cancel keyword delegation')
      const providerInvocation = deferred<{
        content: string
        providerId: 'codex'
        attemptedProviders: ['codex']
        fallbackAttempts: number
      }>()
      let receivedSignal: AbortSignal | undefined
      const providerRun = vi.fn(async (...args: unknown[]) => {
        const agentInput = args[0] as { signal?: AbortSignal }
        receivedSignal = agentInput.signal
        return providerInvocation.promise
      })
      const supervisor = makeConcreteSupervisor({ providerRun })

      const result = supervisor.planAndDelegate('create the database schema', {
        signal: controller.signal,
      })
      await Promise.resolve()
      expect(providerRun).toHaveBeenCalledTimes(1)

      controller.abort(reason)
      providerInvocation.reject(reason)

      await expect(result).rejects.toBe(reason)
      expect(providerRun).toHaveBeenCalledTimes(1)
      expect(receivedSignal).toBe(controller.signal)
    })
  })

  describe('public LLM planning boundary', () => {
    it('terminates ignored mid-decomposition abort without fallback events or delegation', async () => {
      const controller = new AbortController()
      const reason = new Error('cancel public decomposition')
      const invocation = deferred<typeof validPlanResponse>()
      let receivedSignal: AbortSignal | undefined
      const invoke = vi.fn(
        async (_messages: unknown[], options?: { signal?: AbortSignal }) => {
          receivedSignal = options?.signal
          return invocation.promise
        },
      )
      const eventBus = createEventBus()
      const events: Array<{ type: string; source?: string }> = []
      eventBus.onAny((event) => events.push(event))
      const supervisor = makeConcreteSupervisor({ eventBus })
      const delegateAndCollect = vi
        .spyOn(supervisor, 'delegateAndCollect')
        .mockResolvedValue({
          results: new Map(),
          succeeded: [],
          failed: [],
          totalDurationMs: 0,
        })

      const result = supervisor.planAndDelegate('create the database schema', {
        llm: { invoke },
        signal: controller.signal,
      })
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))

      controller.abort(reason)
      const rejection = expect(result).rejects.toBe(reason)
      invocation.resolve(validPlanResponse)
      await rejection

      expect(receivedSignal).toBe(controller.signal)
      expect(delegateAndCollect).not.toHaveBeenCalled()
      expect(
        events.filter((event) => event.type === 'supervisor:llm_decompose_fallback'),
      ).toEqual([])
      expect(events.filter((event) => event.type === 'supervisor:plan_created')).toEqual([])
    })

    it('performs exactly one keyword fallback for genuine decomposition failure', async () => {
      const eventBus = createEventBus()
      const events: Array<{ type: string; source?: string }> = []
      eventBus.onAny((event) => events.push(event))
      const supervisor = makeConcreteSupervisor({ eventBus })
      const delegateAndCollect = vi
        .spyOn(supervisor, 'delegateAndCollect')
        .mockImplementation(async (tasks) => aggregateFor(tasks))
      const invoke = vi.fn(async () => {
        throw new Error('provider unavailable')
      })

      const result = await supervisor.planAndDelegate('create the database schema', {
        llm: { invoke },
      })

      expect(result.succeeded).toEqual(['db-specialist'])
      expect(delegateAndCollect).toHaveBeenCalledTimes(1)
      expect(
        events.filter((event) => event.type === 'supervisor:llm_decompose_fallback'),
      ).toHaveLength(1)
      expect(
        events.filter(
          (event) => event.type === 'supervisor:plan_created' && event.source === 'keyword',
        ),
      ).toHaveLength(1)
    })

    it('propagates an ordinary execution error without starting keyword fallback', async () => {
      const eventBus = createEventBus()
      const events: Array<{ type: string; source?: string }> = []
      eventBus.onAny((event) => events.push(event))
      const supervisor = makeConcreteSupervisor({ eventBus })
      const executionError = new Error('execution failed')
      const delegateAndCollect = vi
        .spyOn(supervisor, 'delegateAndCollect')
        .mockRejectedValue(executionError)

      await expect(
        supervisor.planAndDelegate('create the database schema', {
          llm: { invoke: vi.fn(async () => validPlanResponse) },
        }),
      ).rejects.toBe(executionError)

      expect(delegateAndCollect).toHaveBeenCalledTimes(1)
      expect(
        events.filter((event) => event.type === 'supervisor:llm_decompose_fallback'),
      ).toEqual([])
      expect(
        events.filter(
          (event) => event.type === 'supervisor:plan_created' && event.source === 'keyword',
        ),
      ).toEqual([])
    })

    it('keeps execution cancellation terminal after LLM plan creation', async () => {
      const controller = new AbortController()
      const reason = new Error('cancel accepted LLM plan')
      const eventBus = createEventBus()
      const events: Array<{ type: string; source?: string }> = []
      eventBus.onAny((event) => events.push(event))
      const supervisor = makeConcreteSupervisor({ eventBus })
      const twoLevelResponse = {
        content: JSON.stringify({
          nodes: makeTwoLevelPlan().nodes.map(({ input: _input, ...node }) => node),
        }),
      }
      const delegateAndCollect = vi
        .spyOn(supervisor, 'delegateAndCollect')
        .mockImplementation(async (tasks) => {
          if (delegateAndCollect.mock.calls.length === 1) {
            controller.abort(reason)
          }
          return aggregateFor(tasks)
        })

      await expect(
        supervisor.planAndDelegate('create the database schema', {
          llm: { invoke: vi.fn(async () => twoLevelResponse) },
          signal: controller.signal,
        }),
      ).rejects.toBe(reason)

      expect(delegateAndCollect).toHaveBeenCalledTimes(1)
      expect(
        events.filter((event) => event.type === 'supervisor:llm_decompose_fallback'),
      ).toEqual([])
      expect(
        events.filter(
          (event) => event.type === 'supervisor:plan_created' && event.source === 'keyword',
        ),
      ).toEqual([])
      expect(
        events.filter(
          (event) => event.type === 'supervisor:plan_created' && event.source === 'llm',
        ),
      ).toHaveLength(1)
    })
  })
})
