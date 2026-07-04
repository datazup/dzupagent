import type {
  FanoutRuntimeEvent,
  SubagentRuntimeEvent,
} from "@dzupagent/adapter-types";

/**
 * Lifecycle events emitted on the runtime event bus. The canonical definition
 * lives in `@dzupagent/adapter-types` (the contract home, alongside the
 * `MapReduceRuntimeEvent` precedent) so the runtime and bus subscribers share a
 * single type. Re-exported here for ergonomic local use.
 *
 * Governance decisions (approval requested/resolved, policy violations) are NOT
 * duplicated here — they flow on the existing `GovernanceEvent` side-channel to
 * keep the audit plane single-sourced.
 */
export type {
  FanoutRuntimeEvent,
  SubagentRuntimeEvent,
} from "@dzupagent/adapter-types";

export type SubagentEventType = SubagentRuntimeEvent["type"];
export type FanoutEventType = FanoutRuntimeEvent["type"];

/** Minimal event sink the runtime needs — satisfied by the core event bus. */
export interface SubagentEventSink {
  emit(event: SubagentRuntimeEvent | FanoutRuntimeEvent): void;
}
