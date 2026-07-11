import { describe, expect, it } from "vitest";

import {
  validateExecutionRouteDecision,
  type ExecutionRouteDecision,
  type ExecutionRoutePolicy,
  type SanitizedEvidenceRef,
} from "../index.js";

const policy: ExecutionRoutePolicy = {
  id: "request-1:route",
  requestId: "request-1",
  strategy: "llm-rank",
  candidates: [
    { id: "claude", provider: "claude" },
    { id: "codex", provider: "codex" },
  ],
  hardConstraints: [{ kind: "capability", values: ["code"] }],
  preferenceOrder: ["quality"],
  fallback: "ordered-compatible",
  maxSelectionLatencyMs: 1_500,
};

describe("canonical execution contracts", () => {
  it("accepts route decisions bounded to the materialized candidate set", () => {
    const decision: ExecutionRouteDecision = {
      id: "decision-1",
      policyId: policy.id,
      requestId: policy.requestId,
      eligibleCandidateIds: ["claude", "codex"],
      rejected: [],
      selectedCandidateId: "codex",
      fallbackCandidateIds: ["claude"],
      strategy: "llm-rank",
      decidedAt: "2026-07-11T00:00:00.000Z",
    };

    expect(validateExecutionRouteDecision(policy, decision)).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("rejects invented and ineligible route candidates", () => {
    const decision: ExecutionRouteDecision = {
      id: "decision-2",
      policyId: policy.id,
      requestId: policy.requestId,
      eligibleCandidateIds: ["claude"],
      rejected: [{ candidateId: "invented", reasons: ["ranked higher"] }],
      selectedCandidateId: "codex",
      fallbackCandidateIds: ["invented"],
      strategy: "llm-rank",
      decidedAt: "2026-07-11T00:00:00.000Z",
    };

    expect(
      validateExecutionRouteDecision(policy, decision).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual([
      "UNKNOWN_ROUTE_CANDIDATE",
      "UNKNOWN_ROUTE_CANDIDATE",
      "SELECTED_CANDIDATE_NOT_ELIGIBLE",
    ]);
  });

  it("rejects a decision produced under a different routing strategy", () => {
    const decision: ExecutionRouteDecision = {
      id: "decision-strategy-drift",
      policyId: policy.id,
      requestId: policy.requestId,
      eligibleCandidateIds: ["codex"],
      rejected: [{ candidateId: "claude", reasons: ["lower priority"] }],
      selectedCandidateId: "codex",
      fallbackCandidateIds: [],
      strategy: "fixed",
      decidedAt: "2026-07-11T00:00:00.000Z",
    };

    expect(validateExecutionRouteDecision(policy, decision).diagnostics).toEqual([
      expect.objectContaining({ code: "ROUTE_STRATEGY_MISMATCH", path: "strategy" }),
    ]);
  });

  it("makes raw evidence references unrepresentable", () => {
    const evidence: SanitizedEvidenceRef = {
      uri: "artifact://run/evidence.json",
      digest: "sha256:abc",
      digestOf: "sanitized",
      redactionStatus: "redacted",
      contentClass: "execution-evidence",
    };

    expect(evidence.digestOf).toBe("sanitized");
  });
});
