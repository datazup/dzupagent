import { describe, expect, it } from "vitest";
import { AI_QUOTA_SCHEMA } from "../ai-economics.js";
import type { AiUsageTruth } from "../ai-execution.js";
import {
  AI_EXECUTION_RECEIPT_SCHEMA,
  AI_RESOLVED_TARGET_SCHEMA,
  validateAiExecutionReceipt,
} from "../ai-execution.js";
import { materializeAiResolvedTargetSnapshot } from "../ai-execution-node.js";

const REQUEST_ID = "request-1";
const CORRELATION_ID = "correlation-1";
const CANDIDATE_ID = "model-default";

const target = materializeAiResolvedTargetSnapshot({
  schema: AI_RESOLVED_TARGET_SCHEMA,
  targetId: "docs.summary.default",
  targetRevision: "target-revision-1",
  policyRevision: "policy-revision-1",
  operation: "text.generate",
  placement: "server",
  executionStyle: "inline",
  routeCandidateId: CANDIDATE_ID,
  backend: "sdk",
  provider: "provider",
  model: "model",
  resolvedAt: "2026-08-01T00:00:00.000Z",
});

const result = {
  schema: "dzupagent.executionResult/v1",
  requestId: REQUEST_ID,
  correlationId: CORRELATION_ID,
  routeDecision: {
    id: "decision-1",
    policyId: "policy-1",
    requestId: REQUEST_ID,
    eligibleCandidateIds: [CANDIDATE_ID],
    rejected: [],
    selectedCandidateId: CANDIDATE_ID,
    fallbackCandidateIds: [],
    strategy: "fixed",
    decidedAt: "2026-08-01T00:00:00.000Z",
  },
  evidence: [],
  artifacts: [],
  status: "succeeded",
  output: "summary",
};

function receipt(usage: AiUsageTruth, attempts?: readonly unknown[]) {
  return {
    schema: AI_EXECUTION_RECEIPT_SCHEMA,
    requestId: REQUEST_ID,
    correlationId: CORRELATION_ID,
    operation: "text.generate",
    requestedTarget: {
      kind: "target-id",
      targetId: "docs.summary.default",
    },
    target,
    attempts: attempts ?? [
      {
        attempt: 1,
        target,
        dispatch: { status: "terminal" },
        usage,
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:01.000Z",
      },
    ],
    result,
    usage,
    terminalEventSequence: 3,
    completedAt: "2026-08-01T00:00:01.000Z",
  };
}

const usageCodes = (value: AiUsageTruth) =>
  validateAiExecutionReceipt(receipt(value))
    .diagnostics.filter((diagnostic) => diagnostic.path.includes("usage"))
    .map((diagnostic) => diagnostic.code);

describe("usage truth with economics", () => {
  // Required case: known tokens + reconciled API charge.
  it("accepts known tokens with a reconciled charge", () => {
    expect(
      usageCodes({
        measurement: "known",
        tokens: { input: 1_000, output: 200 },
        cost: {
          status: "reconciled",
          currency: "USD",
          amountMicros: 198_000,
          tariffRef: "anthropic/opus-5",
        },
      })
    ).toEqual([]);
  });

  // Required case: known tokens + estimated charge.
  it("accepts known tokens with an estimated charge carrying provenance", () => {
    expect(
      usageCodes({
        measurement: "known",
        tokens: { input: 1_000, output: 200, cachedInput: 800, cacheWrite: 50 },
        cost: {
          status: "estimated",
          currency: "USD",
          amountMicros: 110_000,
          provenance: {
            sourceKind: "hand-maintained",
            authorityId: "dzupagent.core/model-rates",
            revision: "ARCH-M-08",
            effectiveAt: "2026-08-01T00:00:00.000Z",
            digest: `sha256:${"a".repeat(64)}`,
          },
        },
      })
    ).toEqual([]);
  });

  // Required case: known tokens + unknown subscription charge + observed quota.
  // This is the shape the pre-C3 contract could not express at all.
  it("accepts a subscription call whose charge is unknown but quota is measured", () => {
    expect(
      usageCodes({
        measurement: "known",
        tokens: { input: 1_000, output: 200 },
        cost: { status: "unknown", reason: "subscription" },
        quota: {
          schema: AI_QUOTA_SCHEMA,
          unit: "requests",
          consumed: 1,
          observedAt: "2026-08-04T00:00:00.000Z",
        },
      })
    ).toEqual([]);
  });

  it("treats a measured quota as satisfying partial usage on its own", () => {
    expect(
      usageCodes({
        measurement: "partial",
        cost: { status: "unknown", reason: "subscription" },
        quota: {
          schema: AI_QUOTA_SCHEMA,
          unit: "credits",
          consumed: 3,
          observedAt: "2026-08-04T00:00:00.000Z",
        },
      })
    ).toEqual([]);
  });

  // Required case: partial / unknown usage.
  it("still rejects partial usage carrying no measurement of any kind", () => {
    expect(
      usageCodes({
        measurement: "partial",
        cost: { status: "unknown" },
      })
    ).toContain("AI_USAGE_TRUTH_INVALID");
  });

  it("accepts fully unknown usage and preserves its unknown reason", () => {
    expect(
      usageCodes({
        measurement: "unknown",
        cost: { status: "unknown", reason: "no-tariff" },
      })
    ).toEqual([]);
  });

  it("rejects an unrecognised unknown-cost reason", () => {
    expect(
      usageCodes({
        measurement: "unknown",
        cost: { status: "unknown", reason: "vibes" },
      } as unknown as AiUsageTruth)
    ).toContain("AI_USAGE_TRUTH_INVALID");
  });

  it("rejects an unknown-reason attached to a priced cost", () => {
    expect(
      usageCodes({
        measurement: "known",
        tokens: { input: 10, output: 5 },
        cost: {
          status: "reconciled",
          currency: "USD",
          amountMicros: 100,
          reason: "subscription",
        },
      } as unknown as AiUsageTruth)
    ).toContain("AI_USAGE_TRUTH_INVALID");
  });

  it("validates an embedded quota rather than accepting it unchecked", () => {
    expect(
      usageCodes({
        measurement: "known",
        tokens: { input: 10, output: 5 },
        cost: { status: "unknown", reason: "subscription" },
        quota: {
          schema: AI_QUOTA_SCHEMA,
          unit: "requests",
          consumed: -4,
          observedAt: "2026-08-04T00:00:00.000Z",
        },
      } as unknown as AiUsageTruth)
    ).toContain("AI_USAGE_TRUTH_INVALID");
  });

  it("counts cache-write tokens as a validated token field", () => {
    expect(
      usageCodes({
        measurement: "known",
        tokens: { input: 10, output: 5, cacheWrite: -1 },
        cost: { status: "unknown" },
      } as unknown as AiUsageTruth)
    ).toContain("AI_USAGE_TRUTH_INVALID");
  });

  // Required case: multi-attempt aggregate receipt without double charging.
  it("rejects an aggregate that does not equal the sum of its attempts", () => {
    const attemptUsage = {
      measurement: "known" as const,
      tokens: { input: 100, output: 50 },
      cost: {
        status: "reconciled" as const,
        currency: "USD",
        amountMicros: 20_000,
      },
    };
    const doubleCharged: AiUsageTruth = {
      measurement: "known",
      tokens: { input: 200, output: 100 },
      cost: { status: "reconciled", currency: "USD", amountMicros: 60_000 },
    };
    const { diagnostics } = validateAiExecutionReceipt(
      receipt(doubleCharged, [
        {
          attempt: 1,
          target,
          dispatch: { status: "terminal" },
          usage: attemptUsage,
        },
        {
          attempt: 2,
          target,
          dispatch: { status: "terminal" },
          usage: attemptUsage,
        },
      ])
    );
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("accepts an aggregate that equals the sum of its attempts", () => {
    const attemptUsage = {
      measurement: "known" as const,
      tokens: { input: 100, output: 50 },
      cost: {
        status: "reconciled" as const,
        currency: "USD",
        amountMicros: 20_000,
      },
    };
    const aggregate: AiUsageTruth = {
      measurement: "known",
      tokens: { input: 200, output: 100 },
      cost: { status: "reconciled", currency: "USD", amountMicros: 40_000 },
    };
    expect(
      validateAiExecutionReceipt(
        receipt(aggregate, [
          {
            attempt: 1,
            target,
            dispatch: { status: "terminal" },
            usage: attemptUsage,
          },
          {
            attempt: 2,
            target,
            dispatch: { status: "terminal" },
            usage: attemptUsage,
          },
        ])
      ).diagnostics
    ).toEqual([]);
  });
});
