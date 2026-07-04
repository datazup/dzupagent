import { describe, it, expect } from "vitest";
import { createSpawnDecisionScorer } from "../spawn-decision-scorer.js";
import { runFanoutEvalSuite } from "../harness.js";
import {
  SPAWN_DECISION_SCENARIOS,
  SPAWN_DECISION_KNOWN_BAD_CASE,
} from "../scenarios/spawn-decision-scenarios.js";

describe("createSpawnDecisionScorer", () => {
  it("passes every known-good scenario with score 1", async () => {
    const scorer = createSpawnDecisionScorer();
    const report = await runFanoutEvalSuite(
      "spawn-decision-quality",
      SPAWN_DECISION_SCENARIOS,
      scorer
    );

    expect(report.allPassed).toBe(true);
    expect(report.aggregateScore).toBe(1);
    expect(report.totalCount).toBe(SPAWN_DECISION_SCENARIOS.length);
    for (const score of report.scores) {
      expect(score.result.pass).toBe(true);
    }
  });

  it("fails a known-bad case whose expected outcome contradicts the real gate", async () => {
    const scorer = createSpawnDecisionScorer();
    const result = await scorer.score(SPAWN_DECISION_KNOWN_BAD_CASE.input);

    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reasoning).toContain("Batch admission mismatch");
  });

  it("scores a mismatched per-item scope decision proportionally", async () => {
    const scorer = createSpawnDecisionScorer();
    const result = await scorer.score({
      policy: { check: () => ({ allow: true, requiresApproval: false }) },
      request: {
        batchId: "b-partial",
        parentRunId: "run-1",
        mode: "template",
        template: { agentId: "x", input: "batch", outboundScope: ["repo"] },
        itemKeys: ["a", "b"],
      },
      expectedBatchOutcome: "allowed",
      items: [
        {
          key: "a",
          spec: { agentId: "x", input: "alpha", outboundScope: ["repo"] },
          expectedOutcome: "allowed",
        },
        {
          key: "b",
          // Actually allowed (subset of ["repo"]) but the case WRONGLY expects denied.
          spec: { agentId: "x", input: "beta", outboundScope: ["repo"] },
          expectedOutcome: "denied",
        },
      ],
    });

    expect(result.pass).toBe(false);
    expect(result.score).toBeCloseTo(0.5, 5);
    expect(result.metadata).toMatchObject({
      mismatches: [{ key: "b", expected: "denied", actual: "allowed" }],
    });
  });

  it("catches a wrong expected denial reason even when allow/deny matches", async () => {
    const scorer = createSpawnDecisionScorer();
    const result = await scorer.score({
      policy: { check: () => ({ allow: true, requiresApproval: false }) },
      request: {
        batchId: "b-reason",
        parentRunId: "run-1",
        mode: "template",
        template: { agentId: "x", input: "batch", outboundScope: ["repo"] },
        itemKeys: ["a"],
      },
      expectedBatchOutcome: "allowed",
      items: [
        {
          key: "a",
          spec: { agentId: "different-agent", input: "alpha" },
          expectedOutcome: "denied",
          // Wrong: the real denial reason is agentId, not outboundScope.
          expectedDenialReason: "batch_scope_widened: outboundScope",
        },
      ],
    });

    expect(result.pass).toBe(false);
    expect(result.metadata).toMatchObject({
      mismatches: [
        {
          key: "a",
          expected: "denied:batch_scope_widened: outboundScope",
          actual: "denied:batch_scope_widened: agentId",
        },
      ],
    });
  });

  it("passes a denied batch even when no per-item cases are declared (zero spawns is correct)", async () => {
    const scorer = createSpawnDecisionScorer();
    const result = await scorer.score({
      policy: { check: () => ({ allow: false, reason: "not_allowed" }) },
      request: {
        batchId: "b-denied-no-items",
        parentRunId: "run-1",
        mode: "template",
        template: { agentId: "x", input: "batch" },
        itemKeys: ["a", "b"],
      },
      expectedBatchOutcome: "denied",
    });

    expect(result).toMatchObject({ pass: true, score: 1 });
  });
});
