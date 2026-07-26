/**
 * Orchestration telemetry helpers.
 *
 * Structured logging helpers for routing decisions, merge operations, and
 * circuit-breaker state changes. Each writes one `defaultLogger.debug` line
 * whose payload keys are OTel-style dotted attribute names, so a host that
 * ships these logs can map them onto spans without re-keying.
 *
 * ## These are OPT-IN, CONSUMER-FACING helpers — nothing in this package calls
 * them
 *
 * All three recorders below have ZERO internal call sites. They are exported
 * from the package barrel (`orchestration/index.ts`) for downstream hosts that
 * want a ready-made, consistently-keyed log shape. This package's own
 * observability goes through a DIFFERENT channel: the `DzupEventBus`
 * (`supervisor:routing_decision`, `contractnet:*`, ...), which carries richer,
 * typed payloads and is what the OTel metric mappings actually consume.
 *
 * So there are two parallel paths on purpose, not by accident:
 *   - event bus → typed events → host telemetry (the live path);
 *   - these recorders → plain debug logs (an opt-in convenience for hosts that
 *     do not wire an event bus).
 *
 * Note `supervisor-runner.ts` writes its own `defaultLogger.debug` calls in the
 * no-event-bus fallback branches rather than calling `recordRoutingDecision`.
 * DECIDED: leave them separate. This is not pending cleanup.
 *
 * They look like duplication but are not. Those branches are guarded by
 * `if (!eventBus)` — they fire only when no bus is wired, and they carry a
 * DIFFERENT payload than these recorders take. The circuit-breaker branch logs
 * the concrete `removedIds`; `RoutingSpanData` below models the same situation
 * as aggregate counts (`candidateCount`, `filteredByCircuitBreaker`). Rewriting
 * the fallbacks to call these helpers would therefore DISCARD the per-agent
 * identifiers, not merely re-key the output — a loss of information on the one
 * path that exists precisely because richer telemetry is unavailable.
 *
 * Consolidating would also change the emitted message strings for anyone already
 * grepping them, for no functional gain. Both objections point the same way, so
 * the split stands.
 *
 * Do NOT confuse this module with `circuit-breaker-recorder.ts`. That module
 * mutates breaker STATE (`recordFailure` / `recordTimeout`, deciding whether a
 * circuit trips); `recordCircuitBreakerEvent` here only writes a log line and
 * changes no behaviour. Same "record" verb, different concerns — they do not
 * duplicate or supersede each other.
 *
 * @see `__tests__/orchestration-telemetry-export-surface.test.ts` — pins this
 * module as public API so the zero-call-site property is not mistaken for dead
 * code and silently deleted.
 */

import { defaultLogger } from "@dzupagent/core/utils";

export interface RoutingSpanData {
  runId?: string;
  taskId: string;
  strategy: string;
  selectedAgents: string[];
  reason: string;
  candidateCount: number;
  filteredByCircuitBreaker?: number;
}

export interface MergeSpanData {
  runId?: string;
  strategy: string;
  totalAgents: number;
  successCount: number;
  timeoutCount: number;
  errorCount: number;
  mergedStatus: string;
}

/**
 * Log a routing decision as a structured span/log entry.
 * OTel-compatible attribute names used.
 */
export function recordRoutingDecision(data: RoutingSpanData): void {
  defaultLogger.debug("[orchestration:routing]", {
    "orchestration.task_id": data.taskId,
    "orchestration.routing.strategy": data.strategy,
    "orchestration.routing.selected_agents": data.selectedAgents.join(","),
    "orchestration.routing.reason": data.reason,
    "orchestration.routing.candidate_count": data.candidateCount,
    "orchestration.routing.filtered_count": data.filteredByCircuitBreaker ?? 0,
  });
}

/**
 * Log a merge operation result as a structured span/log entry.
 */
export function recordMergeOperation(data: MergeSpanData): void {
  defaultLogger.debug("[orchestration:merge]", {
    "orchestration.merge.strategy": data.strategy,
    "orchestration.merge.total_agents": data.totalAgents,
    "orchestration.merge.success_count": data.successCount,
    "orchestration.merge.timeout_count": data.timeoutCount,
    "orchestration.merge.error_count": data.errorCount,
    "orchestration.merge.status": data.mergedStatus,
  });
}

/**
 * Log a circuit breaker state change.
 */
export function recordCircuitBreakerEvent(
  agentId: string,
  event: "timeout" | "success" | "trip" | "reset",
  consecutiveTimeouts?: number
): void {
  defaultLogger.debug("[orchestration:circuit_breaker]", {
    "orchestration.circuit_breaker.agent_id": agentId,
    "orchestration.circuit_breaker.event": event,
    "orchestration.circuit_breaker.consecutive_timeouts":
      consecutiveTimeouts ?? 0,
  });
}
