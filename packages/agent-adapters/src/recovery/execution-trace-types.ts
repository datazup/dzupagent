/**
 * Shared trace-payload types for the recovery subsystem.
 *
 * Lives in its own module so `ExecutionTraceStore` (a generic TTL map) can
 * default its element type to `ExecutionTrace` without taking a dependency
 * on `adapter-recovery.ts` (which would create a cycle: adapter-recovery
 * imports the store, the store would import adapter-recovery).
 *
 * @module recovery/execution-trace-types
 */

import type { AdapterProviderId, AgentEvent, AgentInput } from '../types.js'

export interface TraceDecision {
  timestamp: Date
  type: 'route' | 'fallback' | 'recovery' | 'abort'
  providerId: AdapterProviderId
  reason: string
}

export interface TracedEvent {
  timestamp: Date
  event: AgentEvent
}

/** Trace capture for post-mortem analysis. */
export interface ExecutionTrace {
  traceId: string
  startedAt: Date
  completedAt?: Date | undefined
  input: AgentInput
  decisions: TraceDecision[]
  events: TracedEvent[]
}
