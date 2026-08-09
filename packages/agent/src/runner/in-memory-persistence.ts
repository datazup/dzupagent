import { createHash } from 'node:crypto'

import type {
  AgentEventJournal,
  AgentEventJournalAppendResult,
  AgentRunStore,
  AgentRunStoreCompareAndSwapResult,
  AgentRunStoreCreateResult,
  AgentRunnerInput,
  AgentRunnerModelResult,
} from './runner-ports.js'
import {
  AGENT_RUN_STATE_SCHEMA,
  type AgentRunEventEnvelope,
  type AgentRunJsonValue,
  type AgentRunStateV2,
  type AgentToolCallItem,
  type AgentToolInvocationState,
} from '@dzupagent/agent-types/run'

import { assertDurableJson, cloneDurableJson } from './durable-json.js'

export class InMemoryAgentRunStore implements AgentRunStore {
  readonly #states = new Map<string, AgentRunStateV2>()

  async load(runId: string): Promise<AgentRunStateV2 | undefined> {
    const state = this.#states.get(runId)
    return state === undefined ? undefined : cloneDurableJson(state)
  }

  async create(state: AgentRunStateV2): Promise<AgentRunStoreCreateResult> {
    const durableState = cloneDurableJson(state)
    const existing = this.#states.get(state.runId)
    if (existing !== undefined) {
      return {
        status: 'already-exists',
        runId: state.runId,
        actualRevision: existing.revision,
      }
    }

    this.#states.set(state.runId, durableState)
    return { status: 'created', state: cloneDurableJson(durableState) }
  }

  async compareAndSwap(
    runId: string,
    expectedRevision: number,
    nextState: AgentRunStateV2,
  ): Promise<AgentRunStoreCompareAndSwapResult> {
    const existing = this.#states.get(runId)
    if (existing === undefined) return { status: 'not-found', runId }

    if (existing.revision !== expectedRevision) {
      return {
        status: 'revision-conflict',
        runId,
        expectedRevision,
        actualRevision: existing.revision,
      }
    }

    if (nextState.runId !== runId) {
      return {
        status: 'invalid-transition',
        runId,
        reason: 'run-id-mismatch',
      }
    }
    if (nextState.revision !== expectedRevision + 1) {
      return {
        status: 'invalid-transition',
        runId,
        reason: 'revision-not-successor',
      }
    }

    const durableState = cloneDurableJson(nextState)
    this.#states.set(runId, durableState)
    return { status: 'updated', state: cloneDurableJson(durableState) }
  }
}

export class InMemoryAgentEventJournal implements AgentEventJournal {
  readonly #eventsByRun = new Map<string, AgentRunEventEnvelope[]>()
  readonly #eventIds = new Map<string, AgentRunEventEnvelope>()

  async append(event: AgentRunEventEnvelope): Promise<AgentEventJournalAppendResult> {
    const durableEvent = cloneDurableJson(event)
    const existingEvent = this.#eventIds.get(event.eventId)
    if (existingEvent !== undefined) {
      return {
        status: 'event-id-conflict',
        eventId: event.eventId,
        existingRunId: existingEvent.runId,
        existingSequence: existingEvent.sequence,
      }
    }

    const runEvents = this.#eventsByRun.get(event.runId) ?? []
    if (event.sequence !== runEvents.length) {
      return {
        status: 'sequence-conflict',
        runId: event.runId,
        attemptedSequence: event.sequence,
        expectedSequence: runEvents.length,
      }
    }

    runEvents.push(durableEvent)
    this.#eventsByRun.set(event.runId, runEvents)
    this.#eventIds.set(event.eventId, durableEvent)
    return { status: 'appended', event: cloneDurableJson(durableEvent) }
  }

  async read(runId: string): Promise<readonly AgentRunEventEnvelope[]> {
    return cloneDurableJson(this.#eventsByRun.get(runId) ?? [])
  }
}

function stableJson(value: AgentRunJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Readonly<Record<string, AgentRunJsonValue>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key] ?? null)}`)
    .join(',')}}`
}

/** @internal */
export function digestRunnerJson(value: AgentRunJsonValue): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

/** @internal */
export function replaceInvocation(
  state: AgentRunStateV2,
  invocation: AgentToolInvocationState,
): readonly AgentToolInvocationState[] {
  return state.invocations.map((entry) =>
    entry.invocationId === invocation.invocationId ? invocation : entry,
  )
}

/** @internal */
export function isToolCall(
  item: AgentRunnerModelResult['item'],
): item is AgentToolCallItem {
  return item.type === 'tool-call'
}

/** @internal */
export function createInitialAgentRunState(
  input: AgentRunnerInput,
  runId: string,
  now: string,
): AgentRunStateV2 {
  const state: AgentRunStateV2 = {
    schema: AGENT_RUN_STATE_SCHEMA,
    runId,
    revision: 0,
    status: 'created',
    agent: {
      initialAgentId: input.agentId,
      currentAgentId: input.agentId,
      behaviorDigest: input.behaviorDigest,
    },
    attempt: { number: 1, startedAt: now },
    input: input.items,
    committedItems: [],
    nextEventSeq: 0,
    invocations: [],
    interactions: [],
    handoffs: [],
    usage: { records: [] },
    budget: input.budget ?? {
      policyRef: 'runner/unbounded-local',
      policyRevision: '1',
      status: 'within-limit',
      limits: {},
      consumed: {},
    },
    context: input.context ?? { state: 'absent' },
    createdAt: now,
    updatedAt: now,
  }
  assertDurableJson(state)
  return state
}
