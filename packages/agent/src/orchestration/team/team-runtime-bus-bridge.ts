/**
 * Bridge from `TeamRuntimeEvent` (the runtime's per-instance `onEvent`
 * observer channel) onto `DzupEventBus` (the process-wide domain event bus).
 *
 * Why this exists: an otel `MetricMapFragment` keys off `DzupEvent['type']`,
 * so an event that never reaches the bus can never drive a metric. Team
 * lifecycle events were delivered ONLY to `onEvent`, which meant no team
 * signal — including the `skipped` verdict and consolidation signals that
 * exist specifically to be alerted on — was observable by metrics.
 *
 * The bridge deliberately forwards a SUBSET, and narrows what it forwards:
 *
 * - Per-participant and phase-transition events stay off the bus. They fire
 *   once per participant per run, so bridging them would multiply bus traffic
 *   by team size for signals that are a debugging concern, not a fleet metric.
 * - Free-form strings (error messages, memory namespaces) are dropped. They
 *   are unbounded, and anything forwarded here is a candidate metric label.
 * - `runId` IS forwarded, for joining a run's events together, but is
 *   documented as non-labellable for the same cardinality reason.
 *
 * Bridging is best-effort: a throwing bus must never change a run's outcome,
 * since these are reporting-only signals emitted from paths (including a
 * non-fatal catch block) that are contractually not allowed to fail the run.
 */

import type { DzupEventBus } from "@dzupagent/core/events";
import type {
  TeamRuntimeEvent,
  TeamRuntimeEventEmitter,
} from "./team-runtime-events.js";

/**
 * Wrap a `TeamRuntimeEvent` emitter so qualifying events are additionally
 * published to `bus` as domain events.
 *
 * Returns `emit` unchanged when no bus is wired, so the non-observed path
 * keeps its exact previous behaviour and cost.
 */
export function bridgeTeamEventsToBus(
  emit: TeamRuntimeEventEmitter,
  bus: DzupEventBus | undefined,
  coordinatorPattern: string
): TeamRuntimeEventEmitter {
  if (!bus) return emit;
  return (event: TeamRuntimeEvent): void => {
    emit(event);
    publish(bus, event, coordinatorPattern);
  };
}

function publish(
  bus: DzupEventBus,
  event: TeamRuntimeEvent,
  coordinatorPattern: string
): void {
  try {
    switch (event.type) {
      case "team_completed":
        bus.emit({
          type: "team:completed",
          teamId: event.teamId,
          runId: event.runId,
          coordinatorPattern,
          durationMs: event.durationMs,
        });
        return;
      case "team_failed":
        // `event.error` is deliberately NOT forwarded: it is a free-form
        // message and would be an unbounded metric label.
        bus.emit({
          type: "team:failed",
          teamId: event.teamId,
          runId: event.runId,
          coordinatorPattern,
        });
        return;
      case "context_handoff_budget_evaluated":
        bus.emit({
          type: "team:context_handoff_budget_evaluated",
          teamId: event.teamId,
          runId: event.runId,
          coordinatorPattern,
          contentTokenLimit: event.contentTokenLimit,
          reservedTokens: event.reservedTokens,
          measuredTokens: event.measuredTokens,
          measurementMethod: event.measurementMethod,
          satisfied: event.satisfied,
          adoptionSafe: event.adoptionSafe,
          truncated: event.truncated,
          markerIncluded: event.markerIncluded,
        });
        return;
      case "team_verdict_evaluated":
        bus.emit({
          type: "team:verdict_evaluated",
          teamId: event.teamId,
          runId: event.runId,
          gate: event.gate,
          outcome: event.outcome,
          // Preserve absence rather than defaulting: a skipped verdict has no
          // score, and a fabricated 0 or 1 would be averaged in by dashboards
          // as though a real gate had produced it.
          ...(event.score === undefined ? {} : { score: event.score }),
          // Same treatment for the skip cause: dropping it here would collapse
          // 'a judge is down' back into 'nobody wired a gate' at the bus
          // boundary, which is the distinction this field was added to carry.
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        });
        return;
      case "team_consolidation_skipped":
        bus.emit({
          type: "team:consolidation_skipped",
          teamId: event.teamId,
          runId: event.runId,
          reason: event.reason,
        });
        return;
      default:
        // phase_changed / participant_* / policy_applied /
        // team_consolidation_completed stay on `onEvent` only — see the module
        // docstring for why per-participant events are not bridged.
        return;
    }
  } catch {
    // A failing bus must not change the run's outcome.
  }
}
