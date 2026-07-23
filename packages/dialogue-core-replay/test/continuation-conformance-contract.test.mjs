import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  classifyContinuationComparisonV1,
  CONTINUATION_CONFORMANCE_FIXTURE_SET_SCHEMA_V1,
  CONTINUATION_DIVERGENCE_LEDGER_SCHEMA_V1,
  loadContinuationConformanceFixtureSetV1,
  runContinuationConformanceV1,
} from "../src/index.ts";

describe("continuation conformance contract", () => {
  it("exports a fixture schema separate from scheduler golden traces", () => {
    expect(CONTINUATION_CONFORMANCE_FIXTURE_SET_SCHEMA_V1).toBe(
      "dzupagent/continuation-conformance-fixture-set/v1",
    );
    expect(CONTINUATION_DIVERGENCE_LEDGER_SCHEMA_V1).toBe(
      "dzupagent/continuation-divergence-ledger/v1",
    );
  });

  const fixtureUrl = new URL(
    "./fixtures/continuation/shared-agent-loop-continuation-conformance.v1.json",
    import.meta.url,
  );

  it("validates and replays the checked-in shared-loop fixture", () => {
    const fixture = loadContinuationConformanceFixtureSetV1(
      fs.readFileSync(fixtureUrl, "utf8"),
    );
    const report = runContinuationConformanceV1(fixture);

    expect(report.passed).toBe(true);
    expect(report.safetyGatePassed).toBe(true);
    expect(report.adoptionReady).toBe(false);
    expect(report.counts).toEqual({
      total: 47,
      passed: 47,
      scriptsHistorical: 21,
      codev: 10,
      adversarial: 16,
      unsafeKernel: 0,
      saferKernel: 4,
      reviewedDifference: 0,
      pendingDivergenceApprovals: 4,
    });
  });

  it("rejects unexpected fixture keys", () => {
    const fixture = JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
    fixture.cases[0].rawOutput = "must never be published";

    expect(() =>
      loadContinuationConformanceFixtureSetV1(JSON.stringify(fixture)),
    ).toThrow(/unknown=rawOutput/i);
  });

  it("classifies safety dominance independently from exact parity", () => {
    expect(
      classifyContinuationComparisonV1(
        { admittedTransition: "continue" },
        { action: "reject", reason: "invalid_proposal" },
      ),
    ).toBe("safer_kernel");
    expect(
      classifyContinuationComparisonV1(
        { admittedTransition: "blocked" },
        { action: "continue", reason: "accepted", nextTask: "next" },
      ),
    ).toBe("unsafe_kernel");
    expect(
      classifyContinuationComparisonV1(
        { admittedTransition: "complete" },
        { action: "stop", reason: "complete" },
      ),
    ).toBe("match");
  });
});
