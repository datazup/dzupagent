import { asEvent } from "./shared.js";
import type { MetricMapFragment } from "./types.js";

/**
 * TeamRuntime lifecycle metrics.
 *
 * Labels are restricted to bounded-cardinality fields: `team_id` (one per
 * declared team), `coordinator_pattern` (a closed union), and the closed
 * discriminants `gate` / `outcome` / `reason`. `run_id` is carried on the
 * events for correlation but is deliberately NOT a label — it is unbounded,
 * the same reason contract-net keeps its free-form `task` off its labels.
 *
 * The `skipped` verdict and `consolidation_skipped` metrics are the reason
 * this fragment exists. Both report a policy that was DECLARED but never
 * enforced — a team asking for `governance.minScore: 0.9` against a runtime
 * with no scorer wired accepts every run. Alert on a non-zero rate of either:
 * they are misconfiguration, not normal operation.
 */
export const teamRuntimeMetricMap = {
  // --- Team Runtime ---
  "team:completed": [
    {
      metricName: "dzip_team_completed_total",
      type: "counter",
      description: "Total team runs that completed successfully",
      labelKeys: ["team_id", "coordinator_pattern"],
      extract: (e) => {
        const ev = asEvent<"team:completed">(e);
        return {
          value: 1,
          labels: {
            team_id: ev.teamId,
            coordinator_pattern: ev.coordinatorPattern,
          },
        };
      },
    },
    {
      metricName: "dzip_team_duration_ms",
      type: "histogram",
      description: "Team run duration in milliseconds",
      labelKeys: ["team_id", "coordinator_pattern"],
      extract: (e) => {
        const ev = asEvent<"team:completed">(e);
        return {
          value: ev.durationMs,
          labels: {
            team_id: ev.teamId,
            coordinator_pattern: ev.coordinatorPattern,
          },
        };
      },
    },
  ],

  "team:failed": [
    {
      metricName: "dzip_team_failed_total",
      type: "counter",
      description: "Total team runs that terminated through the failure path",
      labelKeys: ["team_id", "coordinator_pattern"],
      extract: (e) => {
        const ev = asEvent<"team:failed">(e);
        return {
          value: 1,
          labels: {
            team_id: ev.teamId,
            coordinator_pattern: ev.coordinatorPattern,
          },
        };
      },
    },
  ],

  "team:verdict_evaluated": [
    {
      metricName: "dzip_team_verdict_total",
      type: "counter",
      description:
        "Total governance/evaluation acceptance verdicts, by gate and outcome " +
        "(outcome='skipped' means the threshold was declared but the gate could " +
        "not be applied; reason='unwired': no scorer injected, " +
        "reason='scorer_failed': a wired scorer could not produce a verdict)",
      labelKeys: ["team_id", "gate", "outcome", "reason"],
      extract: (e) => {
        const ev = asEvent<"team:verdict_evaluated">(e);
        return {
          value: 1,
          labels: {
            team_id: ev.teamId,
            gate: ev.gate,
            outcome: ev.outcome,
            // 'none' rather than omitted: a label key declared in labelKeys but
            // absent from a sample makes the series shape vary per-sample, which
            // several exporters treat as a different series. passed/rejected
            // genuinely have no reason — the gate ran.
            reason: ev.reason ?? "none",
          },
        };
      },
    },
  ],

  "team:consolidation_skipped": [
    {
      metricName: "dzip_team_consolidation_skipped_total",
      type: "counter",
      description:
        "Total declared memory consolidation passes that did not complete " +
        "(reason='unwired': no memory service injected; reason='failed': a wired service threw)",
      labelKeys: ["team_id", "reason"],
      extract: (e) => {
        const ev = asEvent<"team:consolidation_skipped">(e);
        return { value: 1, labels: { team_id: ev.teamId, reason: ev.reason } };
      },
    },
  ],
} satisfies MetricMapFragment;
