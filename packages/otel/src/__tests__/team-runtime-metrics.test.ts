/**
 * TeamRuntime lifecycle metric mapping.
 *
 * The `team:*` variants landed in @dzupagent/core's `OrchestrationDomainEvent`
 * union so that team lifecycle signals — which previously reached only the
 * runtime's per-instance `onEvent` callback — can drive metrics at all. These
 * tests pin that observability contract: every variant maps to a metric, the
 * fragment is actually spread into the aggregate map, and label cardinality
 * stays bounded.
 */

import { describe, it, expect } from "vitest";
import { teamRuntimeMetricMap } from "../event-metric-map/team-runtime.js";
import { EVENT_METRIC_MAP } from "../event-metric-map.js";
import type { DzupEvent } from "@dzupagent/core";

const TEAM_EVENTS = [
  "team:completed",
  "team:failed",
  "team:verdict_evaluated",
  "team:consolidation_skipped",
] as const;

describe("team runtime: metric map coverage", () => {
  it("maps every team:* variant", () => {
    for (const type of TEAM_EVENTS) {
      const mappings = teamRuntimeMetricMap[type];
      expect(mappings, `${type} must map to at least one metric`).toBeDefined();
      expect(mappings!.length).toBeGreaterThan(0);
    }
  });

  it("is wired into the aggregate EVENT_METRIC_MAP", () => {
    // A fragment that exists but is never spread into the aggregate map records
    // nothing at runtime — the regression that leaves events typed but invisible.
    for (const type of TEAM_EVENTS) {
      expect(
        EVENT_METRIC_MAP[type],
        `${type} missing from EVENT_METRIC_MAP`
      ).toBeDefined();
    }
  });

  it("never labels a metric with the unbounded run_id", () => {
    // runId rides on the events for correlation, but as a label it would be
    // unbounded — one time series per run. This is the cardinality guard.
    for (const type of TEAM_EVENTS) {
      for (const mapping of teamRuntimeMetricMap[type]!) {
        expect(
          mapping.labelKeys,
          `${mapping.metricName} must not label by run_id`
        ).not.toContain("run_id");
      }
    }
  });
});

describe("team runtime: metric extraction", () => {
  it("extracts duration and a count from a completed run", () => {
    const event = {
      type: "team:completed",
      teamId: "team-a",
      runId: "run-1",
      coordinatorPattern: "council",
      durationMs: 1234,
    } as unknown as DzupEvent;

    const [count, duration] = teamRuntimeMetricMap["team:completed"];

    expect(count!.extract(event)).toEqual({
      value: 1,
      labels: { team_id: "team-a", coordinator_pattern: "council" },
    });
    expect(duration!.extract(event)).toEqual({
      value: 1234,
      labels: { team_id: "team-a", coordinator_pattern: "council" },
    });
  });

  it("keeps gate and outcome distinguishable on a verdict", () => {
    const skipped = {
      type: "team:verdict_evaluated",
      teamId: "team-a",
      runId: "run-1",
      gate: "governance",
      outcome: "skipped",
      reason: "unwired",
    } as unknown as DzupEvent;
    const scorerFailed = {
      type: "team:verdict_evaluated",
      teamId: "team-a",
      runId: "run-1",
      gate: "governance",
      outcome: "skipped",
      reason: "scorer_failed",
    } as unknown as DzupEvent;
    const passed = {
      type: "team:verdict_evaluated",
      teamId: "team-a",
      runId: "run-1",
      gate: "evaluation",
      outcome: "passed",
      score: 0.9,
    } as unknown as DzupEvent;

    const [verdict] = teamRuntimeMetricMap["team:verdict_evaluated"];

    // The whole point of the `skipped` outcome is that it must not be
    // aggregated together with a real pass.
    expect(verdict!.extract(skipped).labels).toEqual({
      team_id: "team-a",
      gate: "governance",
      outcome: "skipped",
      reason: "unwired",
    });
    // ...and the two skip causes must not be aggregated with each other: one is
    // a static wiring mistake, the other a live outage.
    expect(verdict!.extract(scorerFailed).labels).toEqual({
      team_id: "team-a",
      gate: "governance",
      outcome: "skipped",
      reason: "scorer_failed",
    });
    // A real verdict carries reason='none' rather than omitting the key, so the
    // series shape stays constant across samples.
    expect(verdict!.extract(passed).labels).toEqual({
      team_id: "team-a",
      gate: "evaluation",
      outcome: "passed",
      reason: "none",
    });
  });

  it("keeps unwired and failed consolidation distinguishable", () => {
    const [skipped] = teamRuntimeMetricMap["team:consolidation_skipped"];
    const base = {
      type: "team:consolidation_skipped",
      teamId: "team-a",
      runId: "run-1",
    };

    // `failed` (a wired store throwing) is an outage; `unwired` is a config
    // mistake. Collapsing them into one counter would hide the outage.
    expect(
      skipped!.extract({ ...base, reason: "unwired" } as unknown as DzupEvent)
        .labels.reason
    ).toBe("unwired");
    expect(
      skipped!.extract({ ...base, reason: "failed" } as unknown as DzupEvent)
        .labels.reason
    ).toBe("failed");
  });
});
