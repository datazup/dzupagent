import { describe, expect, it } from "vitest";

import { flowNodeSchema } from "../validate.js";

// ---------------------------------------------------------------------------
// DZUPAGENT-TEST-M1: adapter.run/race/parallel/supervisor validators share a
// large, repetitive set of optional-field validation branches (reasoning,
// promptPrep, idempotency, outputSchema, policy, input, ...). The existing
// `validate.test.ts` suite only exercised the happy path and the top-level
// required-field failures, leaving most of these per-file branches uncovered
// (each validate/adapter-*.ts sat around 30-47% line coverage). This file
// drives every optional-field error branch for all four adapter node kinds.
// ---------------------------------------------------------------------------

describe("flowNodeSchema — adapter.run error paths", () => {
  const base = {
    type: "adapter.run" as const,
    id: "run",
    provider: "claude" as const,
    instructions: "Summarize",
    output: "summary",
  };

  it("rejects a non-object input", () => {
    const result = flowNodeSchema.safeParse({ ...base, input: "oops" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid reasoning level", () => {
    const result = flowNodeSchema.safeParse({ ...base, reasoning: "extreme" });
    expect(result.success).toBe(false);
  });

  it("accepts an inline object outputSchema", () => {
    const result = flowNodeSchema.safeParse({
      ...base,
      outputSchema: { type: "object" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an array outputSchema", () => {
    const result = flowNodeSchema.safeParse({ ...base, outputSchema: [1, 2] });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid promptPrep", () => {
    const result = flowNodeSchema.safeParse({ ...base, promptPrep: "cooked" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid promptPrep", () => {
    const result = flowNodeSchema.safeParse({ ...base, promptPrep: "raw" });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid idempotency mode", () => {
    const result = flowNodeSchema.safeParse({ ...base, idempotency: "maybe" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid idempotency mode", () => {
    const result = flowNodeSchema.safeParse({
      ...base,
      idempotency: "at-least-once",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-object policy", () => {
    const result = flowNodeSchema.safeParse({ ...base, policy: "strict" });
    expect(result.success).toBe(false);
  });

  it("accepts an object policy", () => {
    const result = flowNodeSchema.safeParse({
      ...base,
      policy: { retries: 2 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-array, non-empty-array tags value", () => {
    const result = flowNodeSchema.safeParse({
      type: "adapter.run",
      id: "run",
      tags: [],
      instructions: "Summarize",
      output: "summary",
    });
    expect(result.success).toBe(false);
  });

  it("accepts model, systemPrompt, and persona pass-through fields", () => {
    const result = flowNodeSchema.safeParse({
      ...base,
      model: "opus",
      systemPrompt: "Be terse",
      persona: "reviewer",
    });
    expect(result.success).toBe(true);
  });
});

describe("flowNodeSchema — adapter.race error paths", () => {
  const base = {
    type: "adapter.race" as const,
    id: "race",
    providers: ["claude", "codex"] as const,
    instructions: "Implement it",
    output: "best",
  };

  it("rejects fewer than 2 valid providers", () => {
    const result = flowNodeSchema.safeParse({
      ...base,
      providers: ["claude", "not-a-provider"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object input", () => {
    const result = flowNodeSchema.safeParse({ ...base, input: "oops" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid reasoning level", () => {
    const result = flowNodeSchema.safeParse({ ...base, reasoning: "extreme" });
    expect(result.success).toBe(false);
  });

  it("accepts a string-ref outputSchema", () => {
    const result = flowNodeSchema.safeParse({
      ...base,
      outputSchema: "dzup.schema@1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid promptPrep", () => {
    const result = flowNodeSchema.safeParse({ ...base, promptPrep: "cooked" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid idempotency mode", () => {
    const result = flowNodeSchema.safeParse({ ...base, idempotency: "maybe" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object policy", () => {
    const result = flowNodeSchema.safeParse({ ...base, policy: "strict" });
    expect(result.success).toBe(false);
  });

  it("accepts model, systemPrompt, and persona pass-through fields", () => {
    const result = flowNodeSchema.safeParse({
      ...base,
      model: "opus",
      systemPrompt: "Be terse",
      persona: "reviewer",
    });
    expect(result.success).toBe(true);
  });
});

describe("flowNodeSchema — adapter.parallel error paths", () => {
  const base = {
    type: "adapter.parallel" as const,
    id: "fanout",
    providers: ["claude", "codex"] as const,
    instructions: "Draft it",
    output: "drafts",
  };

  it("rejects an invalid merge mode", () => {
    const result = flowNodeSchema.safeParse({ ...base, merge: "zip" });
    expect(result.success).toBe(false);
  });

  it("accepts every valid merge mode", () => {
    for (const merge of ["first-wins", "all", "best-of-n"] as const) {
      const result = flowNodeSchema.safeParse({ ...base, merge });
      expect(result.success).toBe(true);
    }
  });

  it("rejects a non-object input", () => {
    const result = flowNodeSchema.safeParse({ ...base, input: "oops" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid reasoning level", () => {
    const result = flowNodeSchema.safeParse({ ...base, reasoning: "extreme" });
    expect(result.success).toBe(false);
  });

  it("rejects an array outputSchema", () => {
    const result = flowNodeSchema.safeParse({ ...base, outputSchema: [1] });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid promptPrep", () => {
    const result = flowNodeSchema.safeParse({ ...base, promptPrep: "cooked" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid idempotency mode", () => {
    const result = flowNodeSchema.safeParse({ ...base, idempotency: "maybe" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object policy", () => {
    const result = flowNodeSchema.safeParse({ ...base, policy: "strict" });
    expect(result.success).toBe(false);
  });

  it("rejects fewer than 2 providers", () => {
    const result = flowNodeSchema.safeParse({ ...base, providers: ["claude"] });
    expect(result.success).toBe(false);
  });
});

describe("flowNodeSchema — adapter.supervisor error paths", () => {
  const base = {
    type: "adapter.supervisor" as const,
    id: "ship",
    goal: "Ship the feature",
    output: "result",
  };

  it("rejects non-string specialists", () => {
    const result = flowNodeSchema.safeParse({ ...base, specialists: [1, 2] });
    expect(result.success).toBe(false);
  });

  it("accepts string specialists", () => {
    const result = flowNodeSchema.safeParse({
      ...base,
      specialists: ["claude", "codex"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-object input", () => {
    const result = flowNodeSchema.safeParse({ ...base, input: "oops" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid reasoning level", () => {
    const result = flowNodeSchema.safeParse({ ...base, reasoning: "extreme" });
    expect(result.success).toBe(false);
  });

  it("accepts an inline object outputSchema", () => {
    const result = flowNodeSchema.safeParse({
      ...base,
      outputSchema: { type: "object" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an array outputSchema", () => {
    const result = flowNodeSchema.safeParse({ ...base, outputSchema: [1] });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid promptPrep", () => {
    const result = flowNodeSchema.safeParse({ ...base, promptPrep: "cooked" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid idempotency mode", () => {
    const result = flowNodeSchema.safeParse({ ...base, idempotency: "maybe" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object policy", () => {
    const result = flowNodeSchema.safeParse({ ...base, policy: "strict" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing goal", () => {
    const result = flowNodeSchema.safeParse({
      type: "adapter.supervisor",
      id: "ship",
      output: "result",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing output", () => {
    const result = flowNodeSchema.safeParse({
      type: "adapter.supervisor",
      id: "ship",
      goal: "Ship it",
    });
    expect(result.success).toBe(false);
  });
});
