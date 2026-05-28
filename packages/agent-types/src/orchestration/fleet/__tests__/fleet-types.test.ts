import { describe, it, expect } from "vitest";
import { isKnowledgeEnvelope, isContractPayload } from "../fleet-types.js";

describe("fleet-types guards", () => {
  it("isKnowledgeEnvelope accepts a minimal valid envelope", () => {
    const env = {
      id: "01HXYZ",
      runId: "r1",
      repo: null,
      kind: "finding",
      key: "k",
      version: 1,
      authorWorkerId: null,
      parentId: null,
      createdAt: "2026-05-28T00:00:00Z",
      supersededAt: null,
      payload: {
        category: "hotspot",
        location: "a.ts:1",
        summary: "s",
        evidence: [],
        confidence: 1,
      },
      tags: [],
    };
    expect(isKnowledgeEnvelope(env)).toBe(true);
  });

  it("isKnowledgeEnvelope rejects when kind is missing", () => {
    expect(isKnowledgeEnvelope({ id: "x" })).toBe(false);
  });

  it("isContractPayload accepts a proposed contract", () => {
    expect(
      isContractPayload({
        surface: "shared-kit:foo",
        changeKind: "add",
        after: {},
        consumers: [],
        rationale: "",
        status: "proposed",
      })
    ).toBe(true);
  });
});
