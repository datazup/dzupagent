/**
 * Parse <-> Validate equivalence tests (DZUPAGENT-CODE-L-07 safety net).
 *
 * These tests verify that parse and validate impose the same field-level rules
 * for every agent node field. When a value is VALID the parser must produce a
 * non-null AST with no errors AND the validator must report success. When a
 * value is INVALID the parser must emit at least one error AND the validator
 * must report failure.
 *
 * A failing test here signals drift between the two modules — exactly the
 * defect that the long-term table-driven DSL refactor (out of scope this
 * session) aims to prevent structurally.
 */
import { describe, it, expect } from "vitest";
import { parseFlow } from "../index.js";
import { flowNodeSchema } from "../index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal valid agent node shape; individual test cases override specific fields. */
const VALID_BASE = {
  type: "agent" as const,
  id: "test-node",
  agentId: "my-agent",
  instructions: "Do something useful.",
  output: { key: "result", schemaRef: "result.v1" },
};

function parseAccepts(node: Record<string, unknown>): boolean {
  const r = parseFlow(node);
  return r.ast !== null && r.errors.length === 0;
}

function parseRejects(node: Record<string, unknown>): boolean {
  const r = parseFlow(node);
  return r.errors.length > 0;
}

function validateAccepts(node: Record<string, unknown>): boolean {
  return flowNodeSchema.safeParse(node).success;
}

function validateRejects(node: Record<string, unknown>): boolean {
  return !flowNodeSchema.safeParse(node).success;
}

// ── required field: agentId ──────────────────────────────────────────────────

describe("equivalence — agentId (required non-empty string)", () => {
  it("both accept a valid agentId", () => {
    const node = { ...VALID_BASE, agentId: "researcher" };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject a missing agentId", () => {
    const { agentId: _omit, ...node } = VALID_BASE;
    expect(parseRejects(node as Record<string, unknown>)).toBe(true);
    expect(validateRejects(node as Record<string, unknown>)).toBe(true);
  });

  it("both reject an empty-string agentId", () => {
    const node = { ...VALID_BASE, agentId: "" };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject a numeric agentId", () => {
    const node = { ...VALID_BASE, agentId: 42 };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });
});

// ── required field: instructions ─────────────────────────────────────────────

describe("equivalence — instructions (required when no template.ref)", () => {
  it("both accept valid instructions", () => {
    const node = { ...VALID_BASE, instructions: "Plan the sprint." };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject missing instructions without template.ref", () => {
    const { instructions: _omit, ...node } = VALID_BASE;
    expect(parseRejects(node as Record<string, unknown>)).toBe(true);
    expect(validateRejects(node as Record<string, unknown>)).toBe(true);
  });

  it("both reject empty-string instructions without template.ref", () => {
    const node = { ...VALID_BASE, instructions: "" };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });
});

// ── required field: output ───────────────────────────────────────────────────

describe("equivalence — output (required object)", () => {
  it("both accept output with schemaRef", () => {
    const node = { ...VALID_BASE, output: { key: "out", schemaRef: "out.v1" } };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both accept output with inline schema", () => {
    const node = {
      ...VALID_BASE,
      output: { key: "out", schema: { type: "object" } },
    };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject missing output", () => {
    const { output: _omit, ...node } = VALID_BASE;
    expect(parseRejects(node as Record<string, unknown>)).toBe(true);
    expect(validateRejects(node as Record<string, unknown>)).toBe(true);
  });

  it("both reject output that is not an object", () => {
    const node = { ...VALID_BASE, output: "string-instead" };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject output with missing key", () => {
    const node = { ...VALID_BASE, output: { schemaRef: "out.v1" } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject output with neither schemaRef nor schema", () => {
    const node = { ...VALID_BASE, output: { key: "out" } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject output.schemaRef that is not a string", () => {
    const node = { ...VALID_BASE, output: { key: "out", schemaRef: 99 } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject output.schema that is not an object", () => {
    const node = {
      ...VALID_BASE,
      output: { key: "out", schema: "not-object" },
    };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });
});

// ── optional string fields: model, provider, profile, toolset ────────────────

describe("equivalence — optional string fields (model, provider, profile, toolset)", () => {
  it("both accept a valid model string", () => {
    const node = { ...VALID_BASE, model: "claude-sonnet-4-6" };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject a non-string model", () => {
    const node = { ...VALID_BASE, model: 123 };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both accept a valid provider string", () => {
    const node = { ...VALID_BASE, provider: "anthropic" };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject a non-string provider", () => {
    const node = { ...VALID_BASE, provider: true };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both accept a valid profile string", () => {
    const node = { ...VALID_BASE, profile: "fast-agent" };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject a non-string profile", () => {
    const node = { ...VALID_BASE, profile: [] };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both accept a valid toolset string", () => {
    const node = { ...VALID_BASE, toolset: "coding" };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject a non-string toolset", () => {
    const node = { ...VALID_BASE, toolset: {} };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });
});

// ── optional tools array ──────────────────────────────────────────────────────

describe("equivalence — tools (optional string array)", () => {
  it("both accept a valid string array", () => {
    const node = { ...VALID_BASE, tools: ["fs.read", "shell"] };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both accept an empty tools array", () => {
    const node = { ...VALID_BASE, tools: [] };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject tools that is not an array", () => {
    const node = { ...VALID_BASE, tools: "shell" };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject tools array with non-string entries", () => {
    const node = { ...VALID_BASE, tools: ["fs.read", 42] };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });
});

// ── optional input object ─────────────────────────────────────────────────────

describe("equivalence — input (optional object)", () => {
  it("both accept a valid input object", () => {
    const node = {
      ...VALID_BASE,
      input: { topic: "flow dsl", maxResults: 10 },
    };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject input that is not an object", () => {
    const node = { ...VALID_BASE, input: "not-an-object" };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });
});

// ── optional stop object ──────────────────────────────────────────────────────

describe("equivalence — stop (optional object)", () => {
  it("both accept a valid stop object", () => {
    const node = {
      ...VALID_BASE,
      stop: { maxIterations: 10, maxToolCalls: 50, requireFinalSchema: true },
    };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject stop that is not an object", () => {
    const node = { ...VALID_BASE, stop: "stop-me" };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject stop.maxIterations that is not a number", () => {
    const node = { ...VALID_BASE, stop: { maxIterations: "ten" } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject stop.requireFinalSchema that is not a boolean", () => {
    const node = { ...VALID_BASE, stop: { requireFinalSchema: "yes" } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });
});

// ── stop.maxToolCalls — parse/validate PARITY (DZUPAGENT-CODE-M-06) ───────────
//
// Both parse and validate now enforce the same rule via the shared
// `isPositiveFinitePolicyNumber` guard: maxToolCalls must be a positive,
// finite integer. The former drift (parse rejected 0, validate accepted it)
// is closed.

describe("equivalence — stop.maxToolCalls (positive integer)", () => {
  it("both accept a valid positive integer for maxToolCalls", () => {
    const node = { ...VALID_BASE, stop: { maxToolCalls: 10 } };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject zero maxToolCalls", () => {
    const node = { ...VALID_BASE, stop: { maxToolCalls: 0 } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject a negative maxToolCalls", () => {
    const node = { ...VALID_BASE, stop: { maxToolCalls: -5 } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject a non-integer maxToolCalls", () => {
    const node = { ...VALID_BASE, stop: { maxToolCalls: 2.5 } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });
});

// ── optional onInvalidOutput object ──────────────────────────────────────────

describe("equivalence — onInvalidOutput", () => {
  it("both accept a valid onInvalidOutput", () => {
    const node = {
      ...VALID_BASE,
      onInvalidOutput: {
        retry: 2,
        repairPrompt: true,
        failAfterRetries: false,
      },
    };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject onInvalidOutput that is not an object", () => {
    const node = { ...VALID_BASE, onInvalidOutput: "retry-please" };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject onInvalidOutput.retry that is not a number", () => {
    const node = { ...VALID_BASE, onInvalidOutput: { retry: "two" } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject onInvalidOutput.retry that is negative", () => {
    const node = { ...VALID_BASE, onInvalidOutput: { retry: -1 } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  // DRIFT DETECTED: parse silently ignores non-boolean repairPrompt/failAfterRetries
  // (only copies when `typeof === 'boolean'`). The validator raises an error.
  it("parse accepts non-boolean repairPrompt (silently ignores); validate rejects it (known drift)", () => {
    const node = {
      ...VALID_BASE,
      onInvalidOutput: { retry: 1, repairPrompt: "yes" },
    };
    // Parser silently ignores non-boolean optional fields — no error raised.
    expect(parseAccepts(node)).toBe(true);
    // Validator enforces boolean type on repairPrompt.
    expect(validateRejects(node)).toBe(true);
  });
});

// ── optional retry object ─────────────────────────────────────────────────────

describe("equivalence — retry", () => {
  it("both accept a fully populated retry", () => {
    const node = {
      ...VALID_BASE,
      retry: {
        onInvalidOutput: { attempts: 2, repairPrompt: true },
        onToolError: { attempts: 1 },
        onValidationFailure: { attempts: 1, fullLoop: false },
        onModelUnavailable: { attempts: 2, fallbackProfile: "backup" },
      },
    };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject retry that is not an object", () => {
    const node = { ...VALID_BASE, retry: 3 };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject retry.onInvalidOutput with missing attempts", () => {
    const node = {
      ...VALID_BASE,
      retry: { onInvalidOutput: { repairPrompt: true } },
    };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject retry.onValidationFailure with negative attempts", () => {
    const node = {
      ...VALID_BASE,
      retry: { onValidationFailure: { attempts: -1 } },
    };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });
});

// ── optional validation block ─────────────────────────────────────────────────

describe("equivalence — validation block", () => {
  it("both accept a valid validation block", () => {
    const node = {
      ...VALID_BASE,
      validation: {
        required: [{ id: "typecheck", command: "yarn typecheck" }],
        repair: { maxAttempts: 2 },
      },
    };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject validation that is not an object", () => {
    const node = { ...VALID_BASE, validation: "run tests" };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject validation with empty required array", () => {
    const node = { ...VALID_BASE, validation: { required: [] } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject validation.required entry with non-string command", () => {
    const node = { ...VALID_BASE, validation: { required: [{ command: 42 }] } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject validation.repair.maxAttempts that is negative", () => {
    const node = {
      ...VALID_BASE,
      validation: {
        required: [{ command: "yarn test" }],
        repair: { maxAttempts: -1 },
      },
    };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });
});

// ── optional policy block ─────────────────────────────────────────────────────

describe("equivalence — policy", () => {
  it("both accept a fully populated policy", () => {
    const node = {
      ...VALID_BASE,
      policy: {
        timeoutMs: 60000,
        budgetCents: 100,
        maxToolCalls: 80,
        workingDirectory: "apps/codev-app",
        approval: { requiredFor: ["destructive_shell"] },
        audit: { captureToolCalls: true, captureDiffs: false },
      },
    };
    expect(parseAccepts(node)).toBe(true);
    expect(validateAccepts(node)).toBe(true);
  });

  it("both reject policy that is not an object", () => {
    const node = { ...VALID_BASE, policy: "strict" };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject policy.timeoutMs that is not a number", () => {
    const node = { ...VALID_BASE, policy: { timeoutMs: "sixty-seconds" } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject policy.timeoutMs that is zero or negative", () => {
    const node = { ...VALID_BASE, policy: { timeoutMs: 0 } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject policy.maxToolCalls that is not a number", () => {
    const node = { ...VALID_BASE, policy: { maxToolCalls: "all" } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  // DZUPAGENT-CODE-M-06: policy.maxToolCalls now uses the shared
  // `isPositiveFinitePolicyNumber` guard in BOTH parse and validate. The former
  // opposite-direction drift (parse accepted 0, validate rejected it) is closed.
  it("both reject zero policy.maxToolCalls", () => {
    const node = { ...VALID_BASE, policy: { maxToolCalls: 0 } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject a negative policy.maxToolCalls", () => {
    const node = { ...VALID_BASE, policy: { maxToolCalls: -1 } };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });

  it("both reject policy.approval.requiredFor that is not an array of strings", () => {
    const node = {
      ...VALID_BASE,
      policy: { approval: { requiredFor: "all" } },
    };
    expect(parseRejects(node)).toBe(true);
    expect(validateRejects(node)).toBe(true);
  });
});
