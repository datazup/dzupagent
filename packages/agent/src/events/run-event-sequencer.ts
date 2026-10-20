/**
 * Run-event sequencer (B-02, DZA-B02-RUN-EVENT-ENVELOPE-20261021-R1).
 *
 * Allocates the versioned {@link AgentRunEventEnvelope} for one run: a UUID
 * `eventId` and a 1-based, strictly increasing `sequence`. The envelope type
 * and schema id are the existing `@dzupagent/agent-types/run` contract; this
 * module only numbers events.
 *
 * `runEventSequencerFor(bus, runId)` returns the one sequencer for a run on a
 * given event bus, so every emitter seam that shares the bus and run id
 * (the generate and stream paths alike) draws from the same sequence.
 */

import { randomUUID } from 'node:crypto'
import type { DzupEventBus } from '@dzupagent/core/events'
import {
  AGENT_RUN_EVENT_SCHEMA,
  type AgentRunEventEnvelope,
  type AgentRunEventType,
  type AgentRunJsonValue,
} from '@dzupagent/agent-types/run'

export interface RunEventSequencer {
  readonly runId: string
  next<TType extends AgentRunEventType>(
    type: TType,
    payload: AgentRunJsonValue,
    stateRevision?: number,
  ): AgentRunEventEnvelope<TType>
}

export interface RunEventSequencerOptions {
  /** Attempt number stamped on every envelope. Defaults to 1. */
  attempt?: number
  /** Clock for `occurredAt`. Defaults to `() => new Date()`. */
  now?: () => Date
  /** Event id factory. Defaults to `randomUUID`. */
  newEventId?: () => string
}

export function createRunEventSequencer(
  runId: string,
  options: RunEventSequencerOptions = {},
): RunEventSequencer {
  const attempt = options.attempt ?? 1
  const now = options.now ?? (() => new Date())
  const newEventId = options.newEventId ?? randomUUID
  let sequence = 0
  return {
    runId,
    next(type, payload, stateRevision = 0) {
      sequence += 1
      return {
        schema: AGENT_RUN_EVENT_SCHEMA,
        runId,
        eventId: newEventId(),
        sequence,
        stateRevision,
        attempt,
        occurredAt: now().toISOString(),
        type,
        payload,
      }
    },
  }
}

/**
 * Upper bound on live run sequencers kept per bus. The least recently used
 * run is dropped first; a dropped run that emits again restarts at 1, so the
 * bound is set well above the number of runs one process drives at once.
 */
export const MAX_RUN_SEQUENCERS_PER_BUS = 1024

const sequencersByBus = new WeakMap<DzupEventBus, Map<string, RunEventSequencer>>()

/** The shared sequencer for `runId` on `bus`, created on first use. */
export function runEventSequencerFor(bus: DzupEventBus, runId: string): RunEventSequencer {
  let runs = sequencersByBus.get(bus)
  if (!runs) {
    runs = new Map()
    sequencersByBus.set(bus, runs)
  }
  let sequencer = runs.get(runId)
  if (sequencer) {
    runs.delete(runId)
  } else {
    sequencer = createRunEventSequencer(runId)
    if (runs.size >= MAX_RUN_SEQUENCERS_PER_BUS) {
      const oldest = runs.keys().next().value
      if (oldest !== undefined) runs.delete(oldest)
    }
  }
  runs.set(runId, sequencer)
  return sequencer
}
