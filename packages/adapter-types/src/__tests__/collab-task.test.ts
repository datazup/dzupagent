import { describe, expect, it } from "vitest";
import type {
  CollabTask,
  CollabPart,
  EvidenceRef,
  ProviderResolution,
} from "../index.js";

const resolution: ProviderResolution = {
  resolverVersion: "r1",
  executionProviderId: "claude",
  originKey: "anthropic:claude",
  modelOriginFamily: "anthropic",
  resolutionSource: "origin-map",
  resolutionConfidence: 1,
  sourceEvidence: "test",
  resolvedAt: "2026-06-29T00:00:00.000Z",
  catalogVersion: "c1",
};

describe("CollabTask envelope (MPCO P3)", () => {
  it("T12: a rationale part references only sanitized evidence digests", () => {
    const ref: EvidenceRef = {
      uri: "mpco://runs/r1/sanitized/critique.json",
      digest: "sha256:abc",
      digestOf: "sanitized", // literal — the type permits no other value
      redactionStatus: "redacted",
      contentClass: "critique",
    };
    const part: CollabPart = {
      kind: "rationale",
      rationale: "looks good",
      evidence: [ref],
      quotedContextRefs: [],
    };
    const task: CollabTask = {
      schemaVersion: 1,
      id: "t1",
      contextId: "ctx1",
      runId: "r1",
      nodeId: "n1",
      attempt: 1,
      state: "working",
      role: "critic",
      executionProviderId: "claude",
      modelOriginFamily: "anthropic",
      resolution,
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z",
      parts: [part],
      risk: "medium",
    };
    const firstPart = task.parts[0];
    expect(firstPart?.kind).toBe("rationale");
    if (firstPart?.kind !== "rationale") {
      throw new Error("expected rationale part");
    }
    // every evidence ref digestOf is the sanitized literal
    const refs = firstPart.evidence;
    expect(refs.every((r) => r.digestOf === "sanitized")).toBe(true);
  });

  it("models the input_required human-gate state and gateDecision vocabulary", () => {
    const task: CollabTask = {
      schemaVersion: 1,
      id: "t2",
      contextId: "ctx1",
      runId: "r1",
      nodeId: "n2",
      attempt: 1,
      state: "input_required",
      role: "reconciler",
      executionProviderId: "codex",
      modelOriginFamily: "openai",
      resolution: {
        ...resolution,
        executionProviderId: "codex",
        modelOriginFamily: "openai",
        originKey: "openai:codex",
      },
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z",
      parts: [],
      risk: "high",
      gateDecision: "escalated",
    };
    expect(task.state).toBe("input_required");
    expect(task.gateDecision).toBe("escalated");
  });
});
