import type {
  AgentEventJournal,
  AgentEventJournalAppendResult,
  AgentRunStore,
  AgentRunStoreCompareAndSwapResult,
  AgentRunStoreCreateResult,
  AgentRunnerInput,
  AgentRunnerModelResult,
  AgentRunnerPersistence,
  AgentRunnerPersistenceCommitResult,
  AgentRunnerPersistenceTransition,
  AgentRunnerSessionAbortResult,
  AgentRunnerSessionBeginInput,
  AgentRunnerSessionBeginResult,
  AgentRunnerSessionCommitInput,
  AgentRunnerSessionCommitResult,
  AgentRunnerSessionTransaction,
} from './runner-ports.js'
import {
  AGENT_RUN_STATE_SCHEMA,
  AGENT_SESSION_SCHEMA,
  type AgentRunEventEnvelope,
  type AgentRunStateV2,
  type AgentSessionBinding,
  type AgentSessionSnapshot,
  type AgentToolCallItem,
  type AgentToolInvocationState,
} from '@dzupagent/agent-types/run'

import { assertDurableJson, cloneDurableJson, digestRunnerJson } from './runner-values.js'
import { assertAgentRunnerStructuredOutputRequest } from './model-port-values.js'

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

/** @internal */
export interface InMemoryAgentRunnerPersistenceOptions {
  /** Deterministic fault injection for provider-free atomicity tests. */
  readonly failCommit?: (
    transition: AgentRunnerPersistenceTransition,
  ) => 'state' | 'journal' | undefined
  readonly failSession?: (operation: 'begin' | 'commit' | 'abort', transactionId: string) => boolean
}

// Keep the public instance contract declaration-visible when the concrete
// method implementations below are stripped from generated declarations.
export interface InMemoryAgentRunnerPersistence extends AgentRunnerPersistence {}

export class InMemoryAgentRunnerPersistence implements AgentRunnerPersistence {
  readonly #states = new Map<string, AgentRunStateV2>()
  readonly #eventsByRun = new Map<string, AgentRunEventEnvelope[]>()
  readonly #eventIds = new Map<string, AgentRunEventEnvelope>()
  readonly #sessions = new Map<string, AgentSessionSnapshot>()
  readonly #sessionTransactions = new Map<string, AgentRunnerSessionTransaction>()
  readonly #failCommit?: InMemoryAgentRunnerPersistenceOptions['failCommit']
  readonly #failSession?: InMemoryAgentRunnerPersistenceOptions['failSession']

  constructor()
  /** @internal */
  constructor(options: InMemoryAgentRunnerPersistenceOptions)
  constructor(options: InMemoryAgentRunnerPersistenceOptions = {}) {
    this.#failCommit = options.failCommit
    this.#failSession = options.failSession
  }

  /** @internal */
  async createRun(state: AgentRunStateV2): Promise<AgentRunStoreCreateResult> {
    const durableState = cloneDurableJson(state)
    const existing = this.#states.get(state.runId)
    if (existing !== undefined) {
      return {
        status: 'already-exists',
        runId: state.runId,
        actualRevision: existing.revision,
      }
    }
    if (state.revision !== 0 || state.nextEventSeq !== 0) {
      return {
        status: 'already-exists',
        runId: state.runId,
        actualRevision: state.revision,
      }
    }

    this.#states.set(state.runId, durableState)
    this.#eventsByRun.set(state.runId, [])
    return { status: 'created', state: cloneDurableJson(durableState) }
  }

  /** @internal */
  async loadRun(runId: string): Promise<AgentRunStateV2 | undefined> {
    const state = this.#states.get(runId)
    return state === undefined ? undefined : cloneDurableJson(state)
  }

  /** @internal */
  async readEvents(runId: string): Promise<readonly AgentRunEventEnvelope[]> {
    return cloneDurableJson(this.#eventsByRun.get(runId) ?? [])
  }

  /** @internal */
  async createSession(snapshot: AgentSessionSnapshot): Promise<'created' | 'already-exists'> {
    assertValidSessionSnapshot(snapshot)
    if (this.#sessions.has(snapshot.sessionId)) return 'already-exists'
    this.#sessions.set(snapshot.sessionId, cloneDurableJson(snapshot))
    return 'created'
  }

  /** @internal */
  async readSession(sessionId: string): Promise<AgentSessionSnapshot | undefined> {
    const snapshot = this.#sessions.get(sessionId)
    return snapshot === undefined ? undefined : cloneDurableJson(snapshot)
  }

  /** @internal */
  async beginSessionTransaction(
    input: AgentRunnerSessionBeginInput,
  ): Promise<AgentRunnerSessionBeginResult> {
    assertDurableJson(input)
    const snapshot = this.#sessions.get(input.sessionId)
    if (snapshot === undefined) return { status: 'rejected', code: 'session-not-found' }
    const existing = this.#sessionTransactions.get(input.transactionId)
    if (existing !== undefined) {
      const same =
        existing.sessionId === input.sessionId &&
        existing.finalDigest === undefined &&
        digestRunnerJson(existing.stagedInput) === digestRunnerJson(input.stagedInput)
      if (!same) return { status: 'rejected', code: 'transaction-id-conflict' }
      if (existing.status !== 'open') return { status: 'rejected', code: 'transaction-closed' }
      return {
        status: 'already-open',
        snapshot: cloneDurableJson(existing.baseSnapshot),
        transaction: cloneDurableJson(existing),
      }
    }
    if (this.#failSession?.('begin', input.transactionId) === true) {
      return { status: 'rejected', code: 'injected-failure' }
    }
    const transaction: AgentRunnerSessionTransaction = {
      sessionId: input.sessionId,
      transactionId: input.transactionId,
      baseRevision: snapshot.revision,
      stagedInput: cloneDurableJson(input.stagedInput),
      status: 'open',
      baseSnapshot: cloneDurableJson(snapshot),
    }
    this.#sessionTransactions.set(input.transactionId, transaction)
    return {
      status: 'opened',
      snapshot: cloneDurableJson(snapshot),
      transaction: cloneDurableJson(transaction),
    }
  }

  /** @internal */
  async loadSessionTransaction(
    transactionId: string,
  ): Promise<AgentRunnerSessionTransaction | undefined> {
    const transaction = this.#sessionTransactions.get(transactionId)
    return transaction === undefined ? undefined : cloneDurableJson(transaction)
  }

  /** @internal */
  async commitSessionTransaction(
    input: AgentRunnerSessionCommitInput,
  ): Promise<AgentRunnerSessionCommitResult> {
    assertDurableJson(input)
    const transaction = this.#sessionTransactions.get(input.transactionId)
    if (transaction === undefined) {
      return { status: 'rejected', code: 'transaction-not-found' }
    }
    if (
      transaction.sessionId !== input.sessionId ||
      transaction.baseRevision !== input.baseRevision
    ) {
      return { status: 'rejected', code: 'transaction-id-conflict' }
    }
    const finalDigest = digestRunnerJson([...transaction.stagedInput, ...input.items])
    if (transaction.status === 'committed') {
      if (transaction.finalDigest !== finalDigest || transaction.committedSnapshot === undefined) {
        return { status: 'rejected', code: 'transaction-content-conflict' }
      }
      return {
        status: 'already-committed',
        snapshot: cloneDurableJson(transaction.committedSnapshot),
      }
    }
    if (transaction.status === 'aborted') {
      return { status: 'rejected', code: 'transaction-closed' }
    }
    const current = this.#sessions.get(input.sessionId)
    if (current === undefined) return { status: 'rejected', code: 'session-not-found' }
    if (current.revision !== input.baseRevision) {
      return {
        status: 'rejected',
        code: 'revision-conflict',
        actualRevision: current.revision,
      }
    }
    if (this.#failSession?.('commit', input.transactionId) === true) {
      return { status: 'rejected', code: 'injected-failure' }
    }
    const snapshot: AgentSessionSnapshot = {
      ...current,
      revision: nextSessionRevision(current.revision),
      items: [...current.items, ...transaction.stagedInput, ...cloneDurableJson(input.items)],
    }
    const committed: AgentRunnerSessionTransaction = {
      ...transaction,
      status: 'committed',
      finalDigest,
      committedRevision: snapshot.revision,
      committedSnapshot: snapshot,
    }
    this.#sessions.set(input.sessionId, cloneDurableJson(snapshot))
    this.#sessionTransactions.set(input.transactionId, cloneDurableJson(committed))
    return { status: 'committed', snapshot: cloneDurableJson(snapshot) }
  }

  /** @internal */
  async abortSessionTransaction(
    transactionId: string,
  ): Promise<AgentRunnerSessionAbortResult> {
    const transaction = this.#sessionTransactions.get(transactionId)
    if (transaction === undefined) {
      return { status: 'rejected', code: 'transaction-not-found' }
    }
    if (transaction.status === 'committed') {
      return { status: 'rejected', code: 'transaction-closed' }
    }
    if (transaction.status === 'aborted') return { status: 'already-aborted' }
    if (this.#failSession?.('abort', transactionId) === true) {
      return { status: 'rejected', code: 'injected-failure' }
    }
    this.#sessionTransactions.set(transactionId, { ...transaction, status: 'aborted' })
    return { status: 'aborted' }
  }

  /** @internal */
  async commitTransition(
    transition: AgentRunnerPersistenceTransition,
  ): Promise<AgentRunnerPersistenceCommitResult> {
    const current = this.#states.get(transition.runId)
    if (current === undefined) return { status: 'run-not-found', runId: transition.runId }
    if (current.revision !== transition.expectedRevision) {
      return {
        status: 'revision-conflict',
        runId: transition.runId,
        expectedRevision: transition.expectedRevision,
        actualRevision: current.revision,
      }
    }

    const { event, nextState } = transition
    if (nextState.runId !== transition.runId || event.runId !== transition.runId) {
      return { status: 'invalid-transition', reason: 'run-id-mismatch' }
    }
    if (nextState.revision !== transition.expectedRevision + 1) {
      return { status: 'invalid-transition', reason: 'revision-not-successor' }
    }
    if (event.stateRevision !== nextState.revision) {
      return { status: 'invalid-transition', reason: 'state-event-revision-mismatch' }
    }
    if (
      event.sequence !== current.nextEventSeq ||
      nextState.nextEventSeq !== event.sequence + 1
    ) {
      return { status: 'invalid-transition', reason: 'state-event-sequence-mismatch' }
    }

    const existingEvent = this.#eventIds.get(event.eventId)
    if (existingEvent !== undefined) {
      return {
        status: 'event-id-conflict',
        eventId: event.eventId,
        existingRunId: existingEvent.runId,
        existingSequence: existingEvent.sequence,
      }
    }
    const runEvents = this.#eventsByRun.get(transition.runId) ?? []
    if (event.sequence !== runEvents.length) {
      return {
        status: 'event-sequence-conflict',
        attemptedSequence: event.sequence,
        expectedSequence: runEvents.length,
      }
    }

    const durableState = cloneDurableJson(nextState)
    const durableEvent = cloneDurableJson(event)
    const durableEvents = [...runEvents, durableEvent]
    const failure = this.#failCommit?.(cloneDurableJson(transition))
    if (failure !== undefined) return { status: 'injected-failure', phase: failure }

    this.#states.set(transition.runId, durableState)
    this.#eventsByRun.set(transition.runId, durableEvents)
    this.#eventIds.set(durableEvent.eventId, durableEvent)
    return {
      status: 'committed',
      state: cloneDurableJson(durableState),
      event: cloneDurableJson(durableEvent),
    }
  }
}

/** @internal */
export function assertValidSessionSnapshot(value: unknown): asserts value is AgentSessionSnapshot {
  assertDurableJson(value)
  const snapshot = value as Partial<AgentSessionSnapshot>
  const revision = Number(snapshot.revision)
  if (
    snapshot.schema !== AGENT_SESSION_SCHEMA ||
    typeof snapshot.sessionId !== 'string' ||
    snapshot.sessionId.length === 0 ||
    typeof snapshot.revision !== 'string' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    String(revision) !== snapshot.revision ||
    !Array.isArray(snapshot.items)
  ) {
    throw new TypeError('Invalid AgentSession snapshot')
  }
}

function nextSessionRevision(revision: string): string {
  const next = Number(revision) + 1
  if (!Number.isSafeInteger(next)) throw new RangeError('AgentSession revision exhausted')
  return String(next)
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
  sessionBinding?: AgentSessionBinding,
): AgentRunStateV2 {
  assertAgentRunnerStructuredOutputRequest(input.structuredOutput)
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
    interactionDecisions: [],
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
    ...(input.structuredOutput === undefined
      ? {}
      : { structuredOutput: input.structuredOutput }),
    ...(sessionBinding === undefined ? {} : { sessionBinding }),
    createdAt: now,
    updatedAt: now,
  }
  assertDurableJson(state)
  return state
}
