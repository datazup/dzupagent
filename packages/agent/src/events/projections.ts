/**
 * Run-event projections (B-02, DZA-B02-RUN-EVENT-ENVELOPE-20261021-R1).
 *
 * The run-event envelope is the source; the legacy bus event and the stream
 * event are projections of it. {@link emitRunEvent} is the single seam the
 * shared emitters (tool lifecycle, `llm:invoked`) call: it allocates the
 * envelope from the run's sequencer and emits its bus projection.
 *
 * The bus projection is the legacy event object, unchanged, with the envelope
 * attached under the non-enumerable key {@link RUN_EVENT_ENVELOPE_KEY}. JSON
 * and object spreads of the legacy event are therefore byte-identical to
 * before; consumers that negotiate the envelope schema read the key.
 */

import type { DzupEvent, DzupEventBus } from '@dzupagent/core/events'
import {
  AGENT_RUN_EVENT_SCHEMA,
  type AgentRunEventEnvelope,
  type AgentRunJsonValue,
} from '@dzupagent/agent-types/run'
import type { StreamEvent } from '../streaming/streaming-types.js'
import { runEventSequencerFor } from './run-event-sequencer.js'

/** Global-registry symbol, so packages can read it without importing this module. */
export const RUN_EVENT_ENVELOPE_KEY: unique symbol = Symbol.for(AGENT_RUN_EVENT_SCHEMA) as never

/** Legacy bus event type → run-event kind, for the emitters routed through envelopes. */
export const BUS_EVENT_RUN_EVENT_TYPES = {
  'tool:called': 'tool.started',
  'tool:result': 'tool.completed',
  'tool:error': 'tool.failed',
  'tool:cancel_requested': 'tool.cancel_requested',
  'llm:invoked': 'model.completed',
} as const

export type EnvelopedBusEvent = Extract<
  DzupEvent,
  { type: keyof typeof BUS_EVENT_RUN_EVENT_TYPES }
>

/** Payload of an envelope built from a bus event: the legacy event itself (JSON-safe). */
export interface BusRunEventPayload {
  readonly bus: EnvelopedBusEvent
}

/**
 * Emit `event` on `bus` as the projection of a freshly sequenced envelope.
 * Without a `runId` there is no run to sequence, so the legacy event is
 * emitted as is.
 */
export function emitRunEvent(
  bus: DzupEventBus | undefined,
  runId: string | undefined,
  event: EnvelopedBusEvent,
): void {
  if (!bus) return
  if (runId === undefined) {
    bus.emit(event)
    return
  }
  const payload: BusRunEventPayload = { bus: event }
  const envelope = runEventSequencerFor(bus, runId).next(
    BUS_EVENT_RUN_EVENT_TYPES[event.type],
    payload as unknown as AgentRunJsonValue,
  )
  bus.emit(projectToBus(envelope))
}

/** The legacy bus event an envelope carries, with the envelope attached. */
export function projectToBus(envelope: AgentRunEventEnvelope): DzupEvent {
  const event = (envelope.payload as unknown as BusRunEventPayload).bus
  Object.defineProperty(event, RUN_EVENT_ENVELOPE_KEY, {
    value: envelope,
    enumerable: false,
    configurable: true,
  })
  return event
}

/** The envelope a bus event was projected from, if any. */
export function envelopeOfBusEvent(event: DzupEvent): AgentRunEventEnvelope | undefined {
  return (event as { [RUN_EVENT_ENVELOPE_KEY]?: AgentRunEventEnvelope })[RUN_EVENT_ENVELOPE_KEY]
}

/**
 * Stream projection of an envelope, for the kinds this packet sequences.
 * Returns `null` for kinds with no stream equivalent.
 */
export function projectToStreamEvent(envelope: AgentRunEventEnvelope): StreamEvent | null {
  const event = (envelope.payload as unknown as Partial<BusRunEventPayload>).bus
  if (envelope.type === 'tool.started' && event?.type === 'tool:called') {
    return { type: 'tool_call_start', toolName: event.toolName, callId: event.toolCallId ?? '' }
  }
  if (envelope.type === 'tool.completed' && event?.type === 'tool:result') {
    return { type: 'tool_call_end', callId: event.toolCallId ?? '', result: undefined }
  }
  return null
}
