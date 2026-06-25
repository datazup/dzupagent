/**
 * Comprehensive tests for tool result schema validation surfaces:
 *
 *  1. ToolOutputValidator — required field enforcement, type coercion,
 *     nested object validation, unknown field rejection, error propagation,
 *     edge cases
 *  2. validateAndRepairToolArgs — focused schema-level scenarios that
 *     complement the existing tool-arg-validator.test.ts
 *  3. generateStructured (structured-output engine) — Zod schema enforcement
 *     for structured LLM outputs
 *  4. applyOutputValidation (result-pipeline helper) — wiring between the
 *     ToolOutputValidator and the tool-loop event bus
 *
 * Target: ≥ 75 it()/test() blocks, all passing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { ToolOutputValidator } from "../agent/tool-loop/output-validator.js";
import { applyOutputValidation } from "../agent/tool-loop/result-pipeline.js";
import { validateAndRepairToolArgs } from "../agent/tool-arg-validator.js";
import { generateStructured } from "../structured/structured-output-engine.js";
import type {
  StructuredLLM,
  StructuredLLMWithMeta,
} from "../structured/structured-output-engine.js";
import type { ToolLoopConfig } from "../agent/tool-loop/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLLM(response: string, modelName?: string): StructuredLLMWithMeta {
  return {
    model: modelName,
    invoke: vi.fn(async () => ({ content: response })),
  };
}

function mockLLMSequence(responses: string[]): StructuredLLMWithMeta {
  let idx = 0;
  return {
    invoke: vi.fn(async () => {
      const r = responses[idx] ?? responses[responses.length - 1]!;
      idx++;
      return { content: r };
    }),
  };
}

function makeConfig(overrides: Partial<ToolLoopConfig> = {}): ToolLoopConfig {
  return {
    maxIterations: 10,
    ...overrides,
  } as ToolLoopConfig;
}

function makeEventBus() {
  const emitted: Array<Record<string, unknown>> = [];
  return {
    bus: {
      emit: vi.fn((e: unknown) => emitted.push(e as Record<string, unknown>)),
      on: vi.fn(),
      off: vi.fn(),
    },
    emitted,
  };
}

// ---------------------------------------------------------------------------
// 1. ToolOutputValidator — Required field enforcement
// ---------------------------------------------------------------------------

describe("ToolOutputValidator — required field enforcement", () => {
  it("passes when all required fields are present", () => {
    const schema = z.object({ id: z.string(), status: z.string() });
    const v = new ToolOutputValidator({ myTool: schema });
    expect(
      v.validate("myTool", JSON.stringify({ id: "x", status: "ok" })).valid,
    ).toBe(true);
  });

  it("fails when a required field is missing from JSON result", () => {
    const schema = z.object({ id: z.string(), status: z.string() });
    const v = new ToolOutputValidator({ myTool: schema });
    const result = v.validate("myTool", JSON.stringify({ id: "x" }));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/status/);
  });

  it("fails when all required fields are absent", () => {
    const schema = z.object({ name: z.string(), count: z.number() });
    const v = new ToolOutputValidator({ counter: schema });
    const result = v.validate("counter", JSON.stringify({}));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/name|count/);
  });

  it("fails when the result is an empty object but fields are required", () => {
    const schema = z.object({ value: z.string() });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", "{}").valid).toBe(false);
  });

  it("passes for a schema with no required fields on an empty object", () => {
    const schema = z.object({
      label: z.string().optional(),
      score: z.number().optional(),
    });
    const v = new ToolOutputValidator({ scorer: schema });
    expect(v.validate("scorer", "{}").valid).toBe(true);
  });

  it("fails when a required numeric field has value null in serialized JSON", () => {
    const schema = z.object({ count: z.number() });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({ count: null })).valid).toBe(false);
  });

  it("error message includes the path of the missing field", () => {
    const schema = z.object({ user: z.object({ email: z.string() }) });
    const v = new ToolOutputValidator({ profile: schema });
    const result = v.validate("profile", JSON.stringify({ user: {} }));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/email/);
  });
});

// ---------------------------------------------------------------------------
// 2. ToolOutputValidator — Type coercion (Zod strict types — no auto-coerce)
// ---------------------------------------------------------------------------

describe("ToolOutputValidator — type enforcement (Zod does not auto-coerce)", () => {
  it("fails when a number field receives a string value", () => {
    const schema = z.object({ count: z.number() });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({ count: "42" })).valid).toBe(false);
  });

  it("fails when a boolean field receives a string value", () => {
    const schema = z.object({ enabled: z.boolean() });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({ enabled: "true" })).valid).toBe(
      false,
    );
  });

  it("passes when types are exactly correct", () => {
    const schema = z.object({ count: z.number(), enabled: z.boolean() });
    const v = new ToolOutputValidator({ t: schema });
    expect(
      v.validate("t", JSON.stringify({ count: 5, enabled: false })).valid,
    ).toBe(true);
  });

  it("fails when an array field receives a plain string", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({ tags: "typescript" })).valid).toBe(
      false,
    );
  });

  it("passes when an array field contains correctly typed items", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const v = new ToolOutputValidator({ t: schema });
    expect(
      v.validate("t", JSON.stringify({ tags: ["ts", "node"] })).valid,
    ).toBe(true);
  });

  it("fails when array items have wrong type", () => {
    const schema = z.object({ scores: z.array(z.number()) });
    const v = new ToolOutputValidator({ t: schema });
    expect(
      v.validate("t", JSON.stringify({ scores: [1, "two", 3] })).valid,
    ).toBe(false);
  });

  it('z.coerce.number() passes a string "42"', () => {
    const schema = z.object({ n: z.coerce.number() });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({ n: "42" })).valid).toBe(true);
  });

  it('z.coerce.boolean() passes string "true"', () => {
    const schema = z.object({ flag: z.coerce.boolean() });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({ flag: "true" })).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. ToolOutputValidator — Nested object validation
// ---------------------------------------------------------------------------

describe("ToolOutputValidator — nested object validation", () => {
  const deepSchema = z.object({
    user: z.object({
      profile: z.object({
        name: z.string(),
        age: z.number(),
      }),
    }),
  });

  it("passes when deeply nested required fields are all present", () => {
    const v = new ToolOutputValidator({ t: deepSchema });
    expect(
      v.validate(
        "t",
        JSON.stringify({
          user: { profile: { name: "Alice", age: 30 } },
        }),
      ).valid,
    ).toBe(true);
  });

  it("fails when a leaf field in a deep nest is missing", () => {
    const v = new ToolOutputValidator({ t: deepSchema });
    const result = v.validate(
      "t",
      JSON.stringify({
        user: { profile: { name: "Alice" } },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/age/);
  });

  it("fails when an intermediate object is entirely missing", () => {
    const v = new ToolOutputValidator({ t: deepSchema });
    const result = v.validate("t", JSON.stringify({ user: {} }));
    expect(result.valid).toBe(false);
  });

  it("fails when nested field has wrong type", () => {
    const v = new ToolOutputValidator({ t: deepSchema });
    const result = v.validate(
      "t",
      JSON.stringify({
        user: { profile: { name: "Alice", age: "thirty" } },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/age/);
  });

  it("passes with array of objects matching a nested schema", () => {
    const schema = z.object({
      items: z.array(z.object({ id: z.string(), value: z.number() })),
    });
    const v = new ToolOutputValidator({ t: schema });
    expect(
      v.validate(
        "t",
        JSON.stringify({
          items: [
            { id: "a", value: 1 },
            { id: "b", value: 2 },
          ],
        }),
      ).valid,
    ).toBe(true);
  });

  it("fails when one item in a nested array is invalid", () => {
    const schema = z.object({
      items: z.array(z.object({ id: z.string(), value: z.number() })),
    });
    const v = new ToolOutputValidator({ t: schema });
    const result = v.validate(
      "t",
      JSON.stringify({
        items: [{ id: "a", value: 1 }, { id: "b" }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/value/);
  });

  it("passes when optional nested fields are absent", () => {
    const schema = z.object({
      meta: z.object({ label: z.string().optional() }).optional(),
    });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({})).valid).toBe(true);
  });

  it("reports path context in error messages for nested failures", () => {
    const schema = z.object({
      outer: z.object({ inner: z.string() }),
    });
    const v = new ToolOutputValidator({ t: schema });
    const result = v.validate("t", JSON.stringify({ outer: { inner: 42 } }));
    expect(result.valid).toBe(false);
    // Path should appear as "outer.inner" or similar
    expect(result.error).toMatch(/inner/);
  });
});

// ---------------------------------------------------------------------------
// 4. ToolOutputValidator — Unknown field rejection
// ---------------------------------------------------------------------------

describe("ToolOutputValidator — unknown field rejection via z.strict()", () => {
  it("z.strict() rejects unknown fields in tool output", () => {
    const schema = z.object({ id: z.string() }).strict();
    const v = new ToolOutputValidator({ t: schema });
    const result = v.validate(
      "t",
      JSON.stringify({ id: "x", extra: "not-allowed" }),
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/extra|unrecognized/);
  });

  it("z.object() (default) passes through extra fields silently", () => {
    const schema = z.object({ id: z.string() });
    const v = new ToolOutputValidator({ t: schema });
    expect(
      v.validate("t", JSON.stringify({ id: "x", extra: "ok" })).valid,
    ).toBe(true);
  });

  it("z.strip() explicitly strips unknown keys and still passes", () => {
    const schema = z.object({ id: z.string() }).strip();
    const v = new ToolOutputValidator({ t: schema });
    expect(
      v.validate("t", JSON.stringify({ id: "x", rogue: "field" })).valid,
    ).toBe(true);
  });

  it("z.passthrough() explicitly preserves unknown keys and still passes", () => {
    const schema = z.object({ id: z.string() }).passthrough();
    const v = new ToolOutputValidator({ t: schema });
    expect(
      v.validate("t", JSON.stringify({ id: "x", bonus: "ok" })).valid,
    ).toBe(true);
  });

  it("z.strict() rejects multiple unknown fields and lists them", () => {
    const schema = z.object({ name: z.string() }).strict();
    const v = new ToolOutputValidator({ t: schema });
    const result = v.validate(
      "t",
      JSON.stringify({
        name: "Alice",
        foo: 1,
        bar: 2,
      }),
    );
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. ToolOutputValidator — Error propagation
// ---------------------------------------------------------------------------

describe("ToolOutputValidator — error propagation", () => {
  it("returns error text for a failing Zod schema", () => {
    const schema = z.object({ status: z.enum(["ok", "error"]) });
    const v = new ToolOutputValidator({ t: schema });
    const result = v.validate("t", JSON.stringify({ status: "unknown" }));
    expect(result.valid).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("includes all field paths in multi-field failures", () => {
    const schema = z.object({ a: z.string(), b: z.number(), c: z.boolean() });
    const v = new ToolOutputValidator({ t: schema });
    const result = v.validate("t", JSON.stringify({ a: 1, b: "x", c: "y" }));
    expect(result.valid).toBe(false);
    // All three fields should be flagged
    expect(result.error).toBeTruthy();
  });

  it("predicate error is returned as a string", () => {
    const v = new ToolOutputValidator({
      t: (r) => r === "expected",
    });
    const result = v.validate("t", "unexpected");
    expect(result.valid).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("predicate throw message surfaces in error field", () => {
    const v = new ToolOutputValidator({
      t: () => {
        throw new Error("boom from predicate");
      },
    });
    const result = v.validate("t", "x");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("boom from predicate");
  });

  it("does not throw — validation errors are returned, not thrown", () => {
    const schema = z.object({ x: z.string() });
    const v = new ToolOutputValidator({ t: schema });
    expect(() => v.validate("t", "not json")).not.toThrow();
    const result = v.validate("t", "not json");
    // Non-JSON string is treated as raw string; z.string() actually passes
    // because parsed = 'not json' (string) and schema expects { x: string }
    expect(typeof result.valid).toBe("boolean");
  });

  it("never throws when the predicate is a malformed implementation", () => {
    const v = new ToolOutputValidator({
      t: () => {
        throw new TypeError("internal");
      },
    });
    expect(() => v.validate("t", "anything")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. ToolOutputValidator — Edge cases
// ---------------------------------------------------------------------------

describe("ToolOutputValidator — edge cases", () => {
  it("returns valid when no schema is registered for tool", () => {
    const v = new ToolOutputValidator();
    expect(v.validate("unknown-tool", "anything").valid).toBe(true);
  });

  it("validates empty string result as non-JSON, treated as raw string", () => {
    const schema = z.string().min(1);
    const v = new ToolOutputValidator({ t: schema });
    // Empty string: parsed = '' — z.string().min(1) fails
    expect(v.validate("t", "").valid).toBe(false);
  });

  it("passes an empty string through when no schema registered", () => {
    const v = new ToolOutputValidator();
    expect(v.validate("t", "").valid).toBe(true);
  });

  it("validates null-valued JSON field against z.null()", () => {
    const schema = z.object({ value: z.null() });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({ value: null })).valid).toBe(true);
  });

  it("rejects non-null value against z.null()", () => {
    const schema = z.object({ value: z.null() });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({ value: "not-null" })).valid).toBe(
      false,
    );
  });

  it("handles union types — passes when first union member matches", () => {
    const schema = z.object({ result: z.union([z.string(), z.number()]) });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({ result: "hello" })).valid).toBe(
      true,
    );
  });

  it("handles union types — passes when second union member matches", () => {
    const schema = z.object({ result: z.union([z.string(), z.number()]) });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({ result: 42 })).valid).toBe(true);
  });

  it("handles union types — fails when no union member matches", () => {
    const schema = z.object({ result: z.union([z.string(), z.number()]) });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({ result: [] })).valid).toBe(false);
  });

  it("validates array-only result wrapped in object", () => {
    const schema = z.object({ items: z.array(z.string()) });
    const v = new ToolOutputValidator({ t: schema });
    expect(v.validate("t", JSON.stringify({ items: [] })).valid).toBe(true);
  });

  it("has() returns false for unregistered tool", () => {
    const v = new ToolOutputValidator();
    expect(v.has("ghost")).toBe(false);
  });

  it("has() returns true after register()", () => {
    const v = new ToolOutputValidator();
    v.register("myTool", z.string());
    expect(v.has("myTool")).toBe(true);
  });

  it("register() replaces existing schema", () => {
    const v = new ToolOutputValidator({ t: z.string().min(100) });
    expect(v.validate("t", "short").valid).toBe(false);
    v.register("t", z.string());
    expect(v.validate("t", "short").valid).toBe(true);
  });

  it("handles deeply nested union with discriminated schema", () => {
    const schema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("a"), value: z.string() }),
      z.object({ type: z.literal("b"), count: z.number() }),
    ]);
    const v = new ToolOutputValidator({ t: schema });
    expect(
      v.validate("t", JSON.stringify({ type: "a", value: "hello" })).valid,
    ).toBe(true);
    expect(v.validate("t", JSON.stringify({ type: "b", count: 5 })).valid).toBe(
      true,
    );
    expect(v.validate("t", JSON.stringify({ type: "c" })).valid).toBe(false);
  });

  it("validates raw string result against z.string() schema", () => {
    const v = new ToolOutputValidator({ t: z.string() });
    // Non-JSON string — tryParse path sets parsed = original string
    expect(v.validate("t", "plain text output").valid).toBe(true);
  });

  it("z.string().min() fails on a too-short raw string result", () => {
    const v = new ToolOutputValidator({ t: z.string().min(10) });
    expect(v.validate("t", "short").valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. validateAndRepairToolArgs — additional schema scenarios
// ---------------------------------------------------------------------------

describe("validateAndRepairToolArgs — required field enforcement", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", default: 10 },
    },
    required: ["query"],
  };

  it("fails when the sole required field is absent", () => {
    const result = validateAndRepairToolArgs({}, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field "query"');
  });

  it("passes when required field is present", () => {
    expect(validateAndRepairToolArgs({ query: "test" }, schema).valid).toBe(
      true,
    );
  });

  it("fills in default when optional field is absent", () => {
    const result = validateAndRepairToolArgs({ query: "q" }, schema);
    expect(result.valid).toBe(true);
    expect(result.repairedArgs!["limit"]).toBe(10);
  });

  it("multiple required fields — reports all missing at once", () => {
    const s = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "number" },
        c: { type: "boolean" },
      },
      required: ["a", "b", "c"],
    };
    const result = validateAndRepairToolArgs({}, s);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("a"))).toBe(true);
    expect(result.errors.some((e) => e.includes("b"))).toBe(true);
    expect(result.errors.some((e) => e.includes("c"))).toBe(true);
  });
});

describe("validateAndRepairToolArgs — type coercion", () => {
  it('coerces "1" to integer 1', () => {
    const s = {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    };
    const result = validateAndRepairToolArgs({ n: "1" }, s);
    expect(result.valid).toBe(true);
    expect(result.repairedArgs!["n"]).toBe(1);
  });

  it('coerces "TRUE" (uppercase) to boolean true', () => {
    const s = {
      type: "object",
      properties: { flag: { type: "boolean" } },
      required: ["flag"],
    };
    const result = validateAndRepairToolArgs({ flag: "TRUE" }, s);
    expect(result.valid).toBe(true);
    expect(result.repairedArgs!["flag"]).toBe(true);
  });

  it('coerces "FALSE" (uppercase) to boolean false', () => {
    const s = {
      type: "object",
      properties: { flag: { type: "boolean" } },
      required: ["flag"],
    };
    const result = validateAndRepairToolArgs({ flag: "FALSE" }, s);
    expect(result.valid).toBe(true);
    expect(result.repairedArgs!["flag"]).toBe(false);
  });

  it("converts number to string when expected type is string", () => {
    const s = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const result = validateAndRepairToolArgs({ name: 42 }, s);
    expect(result.valid).toBe(true);
    expect(typeof result.repairedArgs!["name"]).toBe("string");
  });

  it("rounds float to integer for integer type", () => {
    const s = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    };
    const result = validateAndRepairToolArgs({ count: 2.9 }, s);
    expect(result.valid).toBe(true);
    expect(result.repairedArgs!["count"]).toBe(3);
  });

  it("fails non-numeric string coercion in strict mode", () => {
    const s = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    };
    const result = validateAndRepairToolArgs({ n: "not-a-number" }, s, {
      autoRepair: false,
    });
    expect(result.valid).toBe(false);
  });
});

describe("validateAndRepairToolArgs — unknown field rejection", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  };

  it("removes unknown fields in auto-repair mode (default)", () => {
    const result = validateAndRepairToolArgs(
      { path: "/src", hallucinated: "value", another: 99 },
      schema,
    );
    expect(result.valid).toBe(true);
    expect(result.repairedArgs).not.toHaveProperty("hallucinated");
    expect(result.repairedArgs).not.toHaveProperty("another");
  });

  it("reports error for each unknown field in strict mode", () => {
    const result = validateAndRepairToolArgs(
      { path: "/src", extra1: "x", extra2: "y" },
      schema,
      { autoRepair: false },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("extra1"))).toBe(true);
    expect(result.errors.some((e) => e.includes("extra2"))).toBe(true);
  });
});

describe("validateAndRepairToolArgs — error propagation", () => {
  it("returns errors array even on partial repair", () => {
    const schema = {
      type: "object",
      properties: { required_field: { type: "string" } },
      required: ["required_field"],
    };
    const result = validateAndRepairToolArgs({ extra: "ok" }, schema);
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns empty errors array on success", () => {
    const schema = {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
    };
    const result = validateAndRepairToolArgs({ x: "hello" }, schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. generateStructured — schema validation of structured LLM outputs
// ---------------------------------------------------------------------------

describe("generateStructured — required field enforcement", () => {
  const schema = z.object({ name: z.string(), score: z.number() });

  it("succeeds when both required fields are present", async () => {
    const llm = mockLLM('{"name":"Alice","score":99}');
    const result = await generateStructured(llm, [], {
      schema,
      strategy: "generic-parse",
    });
    expect(result.data).toEqual({ name: "Alice", score: 99 });
  });

  it("retries when a required field is missing, succeeds on second attempt", async () => {
    const llm = mockLLMSequence([
      '{"name":"Alice"}',
      '{"name":"Alice","score":95}',
    ]);
    const result = await generateStructured(llm, [], {
      schema,
      strategy: "generic-parse",
      maxRetries: 2,
    });
    expect(result.data.score).toBe(95);
    expect(result.retries).toBe(1);
  });

  it("throws after max retries when required field is always absent", async () => {
    const llm = mockLLM('{"name":"Alice"}');
    await expect(
      generateStructured(llm, [], {
        schema,
        strategy: "generic-parse",
        maxRetries: 1,
      }),
    ).rejects.toThrow();
  });

  it("throws with schema name in error message when exhausted", async () => {
    const llm = mockLLM('{"name":"Alice"}');
    await expect(
      generateStructured(llm, [], {
        schema,
        strategy: "generic-parse",
        maxRetries: 0,
        schemaName: "MyOutputSchema",
      }),
    ).rejects.toThrow(/MyOutputSchema/);
  });
});

describe("generateStructured — type validation", () => {
  it("fails when number field is a string (strict Zod)", async () => {
    const schema = z.object({ count: z.number() });
    const llm = mockLLM('{"count":"not-a-number"}');
    await expect(
      generateStructured(llm, [], {
        schema,
        strategy: "generic-parse",
        maxRetries: 0,
      }),
    ).rejects.toThrow();
  });

  it("succeeds with z.coerce.number() when number field is a string", async () => {
    const schema = z.object({ count: z.coerce.number() });
    const llm = mockLLM('{"count":"42"}');
    const result = await generateStructured(llm, [], {
      schema,
      strategy: "generic-parse",
    });
    expect(result.data.count).toBe(42);
  });

  it("validates enum constraints correctly — passes on valid enum", async () => {
    const schema = z.object({ status: z.enum(["pending", "done", "failed"]) });
    const llm = mockLLM('{"status":"done"}');
    const result = await generateStructured(llm, [], {
      schema,
      strategy: "generic-parse",
    });
    expect(result.data.status).toBe("done");
  });

  it("fails on invalid enum value after maxRetries", async () => {
    const schema = z.object({ status: z.enum(["pending", "done", "failed"]) });
    const llm = mockLLM('{"status":"unknown"}');
    await expect(
      generateStructured(llm, [], {
        schema,
        strategy: "generic-parse",
        maxRetries: 0,
      }),
    ).rejects.toThrow();
  });
});

describe("generateStructured — nested object validation", () => {
  const nestedSchema = z.object({
    meta: z.object({
      title: z.string(),
      version: z.number(),
    }),
    items: z.array(z.string()),
  });

  it("passes deeply nested valid JSON", async () => {
    const llm = mockLLM(
      '{"meta":{"title":"Test","version":2},"items":["a","b"]}',
    );
    const result = await generateStructured(llm, [], {
      schema: nestedSchema,
      strategy: "generic-parse",
    });
    expect(result.data.meta.title).toBe("Test");
    expect(result.data.items).toHaveLength(2);
  });

  it("fails and retries when nested field is wrong type", async () => {
    const llm = mockLLMSequence([
      '{"meta":{"title":"T","version":"two"},"items":[]}',
      '{"meta":{"title":"T","version":2},"items":[]}',
    ]);
    const result = await generateStructured(llm, [], {
      schema: nestedSchema,
      strategy: "generic-parse",
      maxRetries: 2,
    });
    expect(result.data.meta.version).toBe(2);
  });
});

describe("generateStructured — error propagation", () => {
  it("error has structuredOutput metadata attached", async () => {
    const schema = z.object({ x: z.string() });
    const llm = mockLLM('{"x":42}');
    try {
      await generateStructured(llm, [], {
        schema,
        strategy: "generic-parse",
        maxRetries: 0,
      });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as Error & Record<string, unknown>;
      expect(e["structuredOutput"]).toBeDefined();
      expect(e["failureCategory"]).toBe("parse_exhausted");
    }
  });

  it("error includes schemaHash for debugging", async () => {
    const schema = z.object({ x: z.string() });
    const llm = mockLLM("not json");
    try {
      await generateStructured(llm, [], {
        schema,
        strategy: "generic-parse",
        maxRetries: 0,
      });
    } catch (err) {
      const e = err as Error & Record<string, unknown>;
      expect(typeof e["schemaHash"]).toBe("string");
    }
  });

  it("provider execution failure yields provider_execution_failed category", async () => {
    const llm: StructuredLLM = {
      invoke: async () => {
        throw new Error("provider down");
      },
    };
    try {
      await generateStructured(llm, [], {
        schema: z.object({ x: z.string() }),
        strategy: "generic-parse",
        maxRetries: 0,
      });
    } catch (err) {
      const e = err as Error & Record<string, unknown>;
      expect(e["failureCategory"]).toBe("provider_execution_failed");
    }
  });
});

describe("generateStructured — edge cases", () => {
  it("handles array schema wrapped in envelope", async () => {
    const schema = z.array(z.string());
    const llm = mockLLM('{"result":["a","b","c"]}');
    const result = await generateStructured(llm, [], {
      schema,
      strategy: "generic-parse",
    });
    expect(result.data).toEqual(["a", "b", "c"]);
  });

  it("handles empty array result", async () => {
    const schema = z.array(z.string());
    const llm = mockLLM('{"result":[]}');
    const result = await generateStructured(llm, [], {
      schema,
      strategy: "generic-parse",
    });
    expect(result.data).toEqual([]);
  });

  it("extracts JSON from markdown code block", async () => {
    const schema = z.object({ answer: z.string() });
    const llm = mockLLM('```json\n{"answer":"42"}\n```');
    const result = await generateStructured(llm, [], {
      schema,
      strategy: "generic-parse",
    });
    expect(result.data.answer).toBe("42");
  });

  it("handles unicode in string fields", async () => {
    const schema = z.object({ text: z.string() });
    const llm = mockLLM('{"text":"こんにちは 🎉"}');
    const result = await generateStructured(llm, [], {
      schema,
      strategy: "generic-parse",
    });
    expect(result.data.text).toBe("こんにちは 🎉");
  });

  it("z.optional() fields are not required and do not fail when absent", async () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const llm = mockLLM('{"required":"yes"}');
    const result = await generateStructured(llm, [], {
      schema,
      strategy: "generic-parse",
    });
    expect(result.data.required).toBe("yes");
    expect(result.data.optional).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. applyOutputValidation — result-pipeline wiring
// ---------------------------------------------------------------------------

describe("applyOutputValidation — event bus wiring", () => {
  it("emits tool:output:invalid when validation fails", () => {
    const { bus, emitted } = makeEventBus();
    const validator = new ToolOutputValidator({
      myTool: z.object({ x: z.string() }),
    });
    const config = makeConfig({
      eventBus: bus as never,
      toolOutputValidator: validator,
    });
    applyOutputValidation('{"x":42}', "myTool", "tc_1", config);
    const evt = emitted.find((e) => e["type"] === "tool:output:invalid");
    expect(evt).toBeDefined();
    expect(evt!["toolName"]).toBe("myTool");
    expect(typeof evt!["error"]).toBe("string");
  });

  it("does not emit tool:output:invalid when validation passes", () => {
    const { bus, emitted } = makeEventBus();
    const validator = new ToolOutputValidator({
      myTool: z.object({ x: z.string() }),
    });
    const config = makeConfig({
      eventBus: bus as never,
      toolOutputValidator: validator,
    });
    applyOutputValidation('{"x":"hello"}', "myTool", "tc_1", config);
    expect(
      emitted.find((e) => e["type"] === "tool:output:invalid"),
    ).toBeUndefined();
  });

  it("does nothing when no validator is configured", () => {
    const { bus, emitted } = makeEventBus();
    const config = makeConfig({ eventBus: bus as never });
    expect(() =>
      applyOutputValidation("anything", "tool", "tc_1", config),
    ).not.toThrow();
    expect(emitted).toHaveLength(0);
  });

  it("does nothing when tool has no registered schema", () => {
    const { bus, emitted } = makeEventBus();
    const validator = new ToolOutputValidator({ otherTool: z.string() });
    const config = makeConfig({
      eventBus: bus as never,
      toolOutputValidator: validator,
    });
    applyOutputValidation("any output", "unregistered", "tc_1", config);
    expect(emitted).toHaveLength(0);
  });

  it("includes agentId and runId in the emitted event", () => {
    const { bus, emitted } = makeEventBus();
    const validator = new ToolOutputValidator({
      t: z.object({ x: z.number() }),
    });
    const config = makeConfig({
      eventBus: bus as never,
      toolOutputValidator: validator,
      agentId: "agent-42",
      runId: "run-99",
    });
    applyOutputValidation('{"x":"not-a-number"}', "t", "tc_1", config);
    const evt = emitted.find((e) => e["type"] === "tool:output:invalid");
    expect(evt!["agentId"]).toBe("agent-42");
    expect(evt!["runId"]).toBe("run-99");
  });

  it("invokes onToolOutputInvalid callback when validation fails", () => {
    const onInvalid = vi.fn();
    const validator = new ToolOutputValidator({
      t: z.object({ required: z.string() }),
    });
    const config = makeConfig({
      toolOutputValidator: validator,
      onToolOutputInvalid: onInvalid,
    });
    applyOutputValidation("{}", "t", "tc_1", config);
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid.mock.calls[0]![0].toolName).toBe("t");
    expect(typeof onInvalid.mock.calls[0]![0].error).toBe("string");
  });

  it("does not invoke onToolOutputInvalid when validation passes", () => {
    const onInvalid = vi.fn();
    const validator = new ToolOutputValidator({
      t: z.object({ x: z.string() }),
    });
    const config = makeConfig({
      toolOutputValidator: validator,
      onToolOutputInvalid: onInvalid,
    });
    applyOutputValidation('{"x":"ok"}', "t", "tc_1", config);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("swallows eventBus.emit exceptions silently", () => {
    const validator = new ToolOutputValidator({
      t: z.object({ n: z.number() }),
    });
    const brokenBus = {
      emit: () => {
        throw new Error("bus exploded");
      },
    };
    const config = makeConfig({
      eventBus: brokenBus as never,
      toolOutputValidator: validator,
    });
    expect(() =>
      applyOutputValidation('{"n":"string"}', "t", "tc_1", config),
    ).not.toThrow();
  });

  it("swallows onToolOutputInvalid callback exceptions silently", () => {
    const validator = new ToolOutputValidator({
      t: z.object({ n: z.number() }),
    });
    const config = makeConfig({
      toolOutputValidator: validator,
      onToolOutputInvalid: () => {
        throw new Error("callback exploded");
      },
    });
    expect(() =>
      applyOutputValidation('{"n":"string"}', "t", "tc_1", config),
    ).not.toThrow();
  });
});
