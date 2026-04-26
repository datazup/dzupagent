import type { AgentEvent } from '../contracts/events.js'

/**
 * Return a copy of `event` with `correlationId` set when one is provided.
 *
 * Every member of the {@link AgentEvent} union already declares an optional
 * `correlationId` property, so this helper preserves the discriminated-union
 * type of the input without resorting to unsafe casts. When `correlationId`
 * is `undefined` (or empty) the original event is returned unchanged so that
 * downstream consumers do not observe a spurious `correlationId: undefined`
 * field.
 *
 * Adapters should prefer this helper over mutating mapped events in place,
 * which bypasses the type system and risks silently breaking the event
 * contract if a future field is added.
 */
export function withCorrelationId<T extends AgentEvent>(
  event: T,
  correlationId?: string,
): T {
  if (!correlationId) return event
  return { ...event, correlationId }
}
