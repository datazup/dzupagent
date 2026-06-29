import { describe, expect, it } from "vitest";
import {
  applyAllowFailure,
  aggregateGateImpact,
  type CommandGateResult,
} from "../index.js";

function gate(overrides: Partial<CommandGateResult> = {}): CommandGateResult {
  return {
    command: "yarn typecheck",
    cwd: ".",
    exitCode: 0,
    status: "passed",
    required: true,
    decisionImpact: "advisory",
    startedAt: "2026-06-29T00:00:00.000Z",
    completedAt: "2026-06-29T00:00:01.000Z",
    stdoutDigest: "sha256:0",
    stderrDigest: "sha256:0",
    redactionStatus: "redacted",
    ...overrides,
  };
}

describe("command gate projection/aggregation (MPCO P4)", () => {
  // T9: failed/timeout gate overrides agreement via aggregation
  it("T9a: a failed required gate aggregates to blocks_acceptance", () => {
    const results = [
      gate({ status: "passed", decisionImpact: "advisory" }),
      gate({
        command: "yarn test",
        exitCode: 1,
        status: "failed",
        decisionImpact: "blocks_acceptance",
      }),
    ];
    expect(aggregateGateImpact(results)).toBe("blocks_acceptance");
  });

  it("T9b: a timeout gate aggregates to at least blocks_auto_accept", () => {
    const results = [
      gate({ status: "passed", decisionImpact: "advisory" }),
      gate({
        command: "yarn test",
        status: "timeout",
        decisionImpact: "blocks_auto_accept",
      }),
    ];
    expect(aggregateGateImpact(results)).toBe("blocks_auto_accept");
  });

  it("aggregates empty results to advisory (safe floor)", () => {
    expect(aggregateGateImpact([])).toBe("advisory");
  });

  // T9: allowFailure downgrades decisionImpact, NEVER rewrites status
  it("T9c: applyAllowFailure downgrades impact to advisory but keeps status failed", () => {
    const failed = gate({
      exitCode: 1,
      status: "failed",
      decisionImpact: "blocks_acceptance",
    });
    const downgraded = applyAllowFailure(failed, true);
    expect(downgraded.decisionImpact).toBe("advisory");
    expect(downgraded.status).toBe("failed"); // status is NOT rewritten
    expect(downgraded.exitCode).toBe(1);
  });

  it("T9d: applyAllowFailure=false is a no-op", () => {
    const failed = gate({
      exitCode: 1,
      status: "failed",
      decisionImpact: "blocks_acceptance",
    });
    const same = applyAllowFailure(failed, false);
    expect(same.decisionImpact).toBe("blocks_acceptance");
    expect(same.status).toBe("failed");
  });
});
