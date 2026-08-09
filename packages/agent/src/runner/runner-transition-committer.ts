import type { AgentEventJournal, AgentRunStore } from './runner-ports.js'
import {
  AGENT_RUN_EVENT_SCHEMA,
  type AgentRunEventEnvelope,
  type AgentRunEventType,
  type AgentRunJsonValue,
  type AgentRunStateV2,
} from '@dzupagent/agent-types/run'

import { assertDurableJson } from './durable-json.js'

export class AgentRunnerPersistenceError extends Error {
  readonly code: 'run-create-conflict' | 'state-write-conflict' | 'journal-append-conflict'

  constructor(code: AgentRunnerPersistenceError['code']) {
    super(`AgentRunner persistence failed: ${code}`)
    this.name = 'AgentRunnerPersistenceError'
    this.code = code
  }
}

/** @internal */
export interface AgentRunnerCommitResult {
  readonly state: AgentRunStateV2
  readonly event: AgentRunEventEnvelope
}

/** @internal */
export class AgentRunnerTransitionCommitter {
  readonly #store: AgentRunStore
  readonly #journal: AgentEventJournal
  readonly #createEventId: () => string
  readonly #now: () => string

  constructor(options: {
    readonly store: AgentRunStore
    readonly journal: AgentEventJournal
    readonly createEventId: () => string
    readonly now: () => string
  }) {
    this.#store = options.store
    this.#journal = options.journal
    this.#createEventId = options.createEventId
    this.#now = options.now
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

    const write = await this.#store.compareAndSwap(state.runId, state.revision, nextState)
    if (write.status !== 'updated') {
      throw new AgentRunnerPersistenceError('state-write-conflict')
    }
    const append = await this.#journal.append(event)
    if (append.status !== 'appended') {
      throw new AgentRunnerPersistenceError('journal-append-conflict')
    }
    return { state: write.state, event: append.event }
  }
}
