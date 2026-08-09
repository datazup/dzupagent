import type {
  AgentRunnerInput,
  AgentRunnerPersistence,
  AgentRunnerSessionErrorCode,
} from './runner-ports.js'
import {
  AGENT_RUN_EVENT_SCHEMA,
  AGENT_RUN_STATE_SCHEMA,
  type AgentInteractionDecisionInput,
  type AgentInteractionDecisionRecord,
  type AgentPendingInteraction,
  type AgentRunEventEnvelope,
  type AgentRunEventType,
  type AgentRunJsonValue,
  type AgentRunStateV2,
} from '@dzupagent/agent-types/run'

import { assertDurableJson } from './runner-values.js'
import {
  assertValidSessionSnapshot,
  createInitialAgentRunState,
} from './in-memory-persistence.js'

export class AgentRunnerPersistenceError extends Error {
  readonly code:
    | 'run-create-conflict'
    | 'state-write-conflict'
    | 'journal-append-conflict'
    | 'atomic-state-failure'
    | 'atomic-journal-failure'

  constructor(code: AgentRunnerPersistenceError['code']) {
    super(`AgentRunner persistence failed: ${code}`)
    this.name = 'AgentRunnerPersistenceError'
    this.code = code
  }
}

/** @internal */
export class AgentRunnerSessionError extends Error {
  readonly code: AgentRunnerSessionErrorCode

  constructor(code: AgentRunnerSessionErrorCode) {
    super(`AgentRunner session failed: ${code}`)
    this.name = 'AgentRunnerSessionError'
    this.code = code
  }
}

/** @internal */
export type AgentRunnerResumeErrorCode =
  | 'behavior-mismatch'
  | 'decision-already-applied'
  | 'decision-conflict'
  | 'decision-generation-mismatch'
  | 'decision-policy-mismatch'
  | 'decision-request-mismatch'
  | 'decision-state-revision-stale'
  | 'interaction-expired'
  | 'interaction-not-found'
  | 'malformed-decision'
  | 'malformed-state'
  | 'not-suspended'
  | 'persistence-inconsistent'
  | 'run-not-found'
  | 'tool-call-not-found'
  | 'tool-not-found'
  | 'tool-revision-mismatch'

/** @internal */
export class AgentRunnerResumeError extends Error {
  readonly code: string

  constructor(code: string) {
    super(`AgentRunner resume rejected: ${code}`)
    this.name = 'AgentRunnerResumeError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isPrincipal(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.principalId)) return false
  return ['user', 'service', 'agent', 'host'].includes(String(value.principalType))
}

function isInteraction(value: unknown): value is AgentPendingInteraction {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.interactionId) &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) > 0 &&
    isSafeNonNegativeInteger(value.stateRevision) &&
    'request' in value &&
    isNonEmptyString(value.requestDigest) &&
    isNonEmptyString(value.decisionPolicyRef) &&
    isNonEmptyString(value.decisionPolicyRevision) &&
    isPrincipal(value.requestedBy) &&
    (value.invocationId === undefined || isNonEmptyString(value.invocationId)) &&
    (value.expiresAt === undefined || isNonEmptyString(value.expiresAt))
  )
}

function isDecision(value: unknown): value is AgentInteractionDecisionRecord {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.interactionId) &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) > 0 &&
    isNonEmptyString(value.requestDigest) &&
    isSafeNonNegativeInteger(value.stateRevision) &&
    (value.decision === 'approved' || value.decision === 'rejected') &&
    isNonEmptyString(value.decisionPolicyRef) &&
    isNonEmptyString(value.decisionPolicyRevision) &&
    isPrincipal(value.actor) &&
    isNonEmptyString(value.invocationId) &&
    isNonEmptyString(value.decidedAt)
  )
}

/** @internal */
export function assertValidResumeState(value: unknown): asserts value is AgentRunStateV2 {
  try {
    assertDurableJson(value)
  } catch {
    throw new AgentRunnerResumeError('malformed-state')
  }
  if (!isRecord(value)) throw new AgentRunnerResumeError('malformed-state')
  if (
    value.schema !== AGENT_RUN_STATE_SCHEMA ||
    !isNonEmptyString(value.runId) ||
    !isSafeNonNegativeInteger(value.revision) ||
    !isSafeNonNegativeInteger(value.nextEventSeq) ||
    !isRecord(value.agent) ||
    !isNonEmptyString(value.agent.behaviorDigest) ||
    !isRecord(value.attempt) ||
    !Number.isSafeInteger(value.attempt.number) ||
    Number(value.attempt.number) < 1 ||
    !Array.isArray(value.input) ||
    !Array.isArray(value.committedItems) ||
    !Array.isArray(value.invocations) ||
    !Array.isArray(value.interactions) ||
    !value.interactions.every(isInteraction) ||
    !Array.isArray(value.interactionDecisions) ||
    !value.interactionDecisions.every(isDecision) ||
    (value.sessionBinding !== undefined &&
      (!isRecord(value.sessionBinding) ||
        !isNonEmptyString(value.sessionBinding.sessionId) ||
        !isNonEmptyString(value.sessionBinding.baseRevision) ||
        !isNonEmptyString(value.sessionBinding.transactionId)))
  ) {
    throw new AgentRunnerResumeError('malformed-state')
  }
}

/** @internal */
export function assertValidDecision(
  decision: AgentInteractionDecisionInput,
): asserts decision is AgentInteractionDecisionInput {
  try {
    assertDurableJson(decision)
  } catch {
    throw new AgentRunnerResumeError('malformed-decision')
  }
  if (!isDecision({ ...decision, invocationId: 'validation-only', decidedAt: 'validation-only' })) {
    throw new AgentRunnerResumeError('malformed-decision')
  }
}

/** @internal */
export function assertStateJournalConsistency(
  state: AgentRunStateV2,
  events: readonly AgentRunEventEnvelope[],
): void {
  try {
    assertDurableJson(events)
  } catch {
    throw new AgentRunnerResumeError('persistence-inconsistent')
  }
  if (state.revision !== state.nextEventSeq || events.length !== state.nextEventSeq) {
    throw new AgentRunnerResumeError('persistence-inconsistent')
  }
  for (const [sequence, event] of events.entries()) {
    if (
      event.schema !== AGENT_RUN_EVENT_SCHEMA ||
      event.runId !== state.runId ||
      event.sequence !== sequence ||
      event.stateRevision !== sequence + 1
    ) {
      throw new AgentRunnerResumeError('persistence-inconsistent')
    }
  }
}

/** @internal */
export function decisionsMatch(
  persisted: AgentInteractionDecisionRecord,
  candidate: AgentInteractionDecisionInput,
): boolean {
  return (
    persisted.interactionId === candidate.interactionId &&
    persisted.generation === candidate.generation &&
    persisted.requestDigest === candidate.requestDigest &&
    persisted.stateRevision === candidate.stateRevision &&
    persisted.decision === candidate.decision &&
    persisted.decisionPolicyRef === candidate.decisionPolicyRef &&
    persisted.decisionPolicyRevision === candidate.decisionPolicyRevision &&
    persisted.actor.principalId === candidate.actor.principalId &&
    persisted.actor.principalType === candidate.actor.principalType
  )
}

/** @internal */
export interface AgentRunnerCommitResult {
  readonly state: AgentRunStateV2
  readonly event: AgentRunEventEnvelope
}

/** @internal */
export class AgentRunnerTransitionCommitter {
  readonly #persistence: AgentRunnerPersistence
  readonly #createEventId: () => string
  readonly #now: () => string

  constructor(options: {
    readonly persistence: AgentRunnerPersistence
    readonly createEventId: () => string
    readonly now: () => string
  }) {
    this.#persistence = options.persistence
    this.#createEventId = options.createEventId
    this.#now = options.now
  }

  async assertResumableSession(state: AgentRunStateV2, allowAborted = false): Promise<void> {
    const binding = state.sessionBinding
    if (binding === undefined) return
    if (binding.transactionId === undefined) throw new AgentRunnerSessionError('invalid-session')
    const transaction = await this.#persistence.loadSessionTransaction(binding.transactionId)
    if (transaction === undefined) throw new AgentRunnerSessionError('transaction-not-found')
    try {
      assertValidSessionSnapshot(transaction.baseSnapshot)
    } catch {
      throw new AgentRunnerSessionError('invalid-session')
    }
    if (
      (transaction.status !== 'open' && !(allowAborted && transaction.status === 'aborted')) ||
      transaction.sessionId !== binding.sessionId ||
      transaction.baseRevision !== binding.baseRevision
    ) {
      throw new AgentRunnerSessionError('transaction-closed')
    }
  }

  async abortSession(state: AgentRunStateV2): Promise<void> {
    const transactionId = state.sessionBinding?.transactionId
    if (state.sessionBinding === undefined) return
    if (transactionId === undefined) throw new AgentRunnerSessionError('invalid-session')
    const result = await this.#persistence.abortSessionTransaction(transactionId)
    if (result.status === 'rejected') throw new AgentRunnerSessionError(result.code)
  }

  async commitSession(state: AgentRunStateV2): Promise<void> {
    const binding = state.sessionBinding
    if (binding === undefined) return
    if (binding.transactionId === undefined) throw new AgentRunnerSessionError('invalid-session')
    const result = await this.#persistence.commitSessionTransaction({
      sessionId: binding.sessionId,
      transactionId: binding.transactionId,
      baseRevision: binding.baseRevision,
      items: state.committedItems,
    })
    if (result.status === 'rejected') throw new AgentRunnerSessionError(result.code)
  }

  async complete(state: AgentRunStateV2, finalItemId: string): Promise<AgentRunnerCommitResult> {
    await this.commitSession(state)
    const commitCompletion = () =>
      this.commit(
        state,
        'run.completed',
        { status: 'completed', finalItemId },
        (current) => ({ ...current, status: 'completed' }),
      )
    try {
      return await commitCompletion()
    } catch (error) {
      if (
        !(error instanceof AgentRunnerPersistenceError) ||
        (error.code !== 'atomic-state-failure' && error.code !== 'atomic-journal-failure')
      ) {
        throw error
      }
      return commitCompletion()
    }
  }

  async commit(
    state: AgentRunStateV2,
    type: AgentRunEventType,
    payload: AgentRunJsonValue,
    mutate: (current: AgentRunStateV2) => AgentRunStateV2,
  ): Promise<AgentRunnerCommitResult> {
    const mutated = mutate(state)
    const nextState: AgentRunStateV2 = {
      ...mutated,
      revision: state.revision + 1,
      nextEventSeq: state.nextEventSeq + 1,
      updatedAt: this.#now(),
    }
    const event: AgentRunEventEnvelope = {
      schema: AGENT_RUN_EVENT_SCHEMA,
      runId: state.runId,
      eventId: this.#createEventId(),
      sequence: state.nextEventSeq,
      stateRevision: nextState.revision,
      attempt: state.attempt.number,
      occurredAt: nextState.updatedAt,
      type,
      payload,
    }
    assertDurableJson(nextState)
    assertDurableJson(event)

    const committed = await this.#persistence.commitTransition({
      runId: state.runId,
      expectedRevision: state.revision,
      nextState,
      event,
    })
    if (committed.status === 'committed') return committed
    if (committed.status === 'injected-failure') {
      throw new AgentRunnerPersistenceError(`atomic-${committed.phase}-failure`)
    }
    if (
      committed.status === 'event-id-conflict' ||
      committed.status === 'event-sequence-conflict'
    ) {
      throw new AgentRunnerPersistenceError('journal-append-conflict')
    }
    throw new AgentRunnerPersistenceError('state-write-conflict')
  }
}

/** @internal */
export async function* startAgentRun<TResult>(options: {
  readonly input: AgentRunnerInput
  readonly persistence: AgentRunnerPersistence
  readonly transitions: AgentRunnerTransitionCommitter
  readonly runId: string
  readonly now: string
  readonly continueRun: (
    state: AgentRunStateV2,
    events: AgentRunEventEnvelope[],
  ) => AsyncGenerator<AgentRunEventEnvelope, TResult>
}): AsyncGenerator<AgentRunEventEnvelope, TResult> {
  const events: AgentRunEventEnvelope[] = []
  let input = options.input
  let sessionBinding: AgentRunStateV2['sessionBinding']
  if (input.sessionId !== undefined) {
    if (input.sessionId.length === 0) throw new AgentRunnerSessionError('invalid-session')
    const opened = await options.persistence.beginSessionTransaction({
      sessionId: input.sessionId,
      transactionId: `${options.runId}:session`,
      stagedInput: input.items,
    })
    if (opened.status === 'rejected') throw new AgentRunnerSessionError(opened.code)
    try {
      assertValidSessionSnapshot(opened.snapshot)
    } catch {
      throw new AgentRunnerSessionError('invalid-session')
    }
    sessionBinding = {
      sessionId: opened.transaction.sessionId,
      baseRevision: opened.transaction.baseRevision,
      transactionId: opened.transaction.transactionId,
    }
    input = { ...input, items: [...opened.snapshot.items, ...input.items] }
  }

  let state = createInitialAgentRunState(input, options.runId, options.now, sessionBinding)
  let started: AgentRunnerCommitResult
  try {
    const created = await options.persistence.createRun(state)
    if (created.status !== 'created') throw new AgentRunnerPersistenceError('run-create-conflict')
    state = created.state
    started = await options.transitions.commit(
      state,
      'run.started',
      { status: 'running' },
      (current) => ({ ...current, status: 'running' }),
    )
  } catch (error) {
    await options.transitions.abortSession(state)
    throw error
  }
  events.push(started.event)
  yield started.event
  return yield* options.continueRun(started.state, events)
}
