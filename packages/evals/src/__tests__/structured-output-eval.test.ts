import { describe, it, expect } from "vitest";
import { createStructuredOutputScorer } from "../scorers/structured-output-scorer.js";
import type { EvalInput } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeInput = (output: string): EvalInput => ({
  input: "test prompt",
  output,
});
const json = (v: unknown) => JSON.stringify(v);

// ---------------------------------------------------------------------------
// 1. Full schema match — score 1.0
// ---------------------------------------------------------------------------

describe("full schema match", () => {
  it("scores 1.0 when all required fields present with correct types", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["name", "age"],
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
    });
    const result = await scorer.score(
      makeInput(json({ name: "Alice", age: 30 })),
    );
    expect(result.aggregateScore).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("scores 1.0 for empty schema with any valid object", async () => {
    const scorer = createStructuredOutputScorer({});
    const result = await scorer.score(
      makeInput(json({ anything: true, extra: "yes" })),
    );
    expect(result.aggregateScore).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("scores 1.0 for multiple types all matching", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["id", "active", "tags"],
      properties: {
        id: { type: "number" },
        active: { type: "boolean" },
        tags: { type: "array" },
      },
    });
    const result = await scorer.score(
      makeInput(json({ id: 1, active: true, tags: ["a", "b"] })),
    );
    expect(result.aggregateScore).toBe(1);
  });

  it("returns passed=true when aggregateScore equals exactly 1.0", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["x"],
      properties: { x: { type: "string" } },
    });
    const result = await scorer.score(makeInput(json({ x: "hello" })));
    expect(result.passed).toBe(true);
    expect(result.aggregateScore).toBe(1);
  });

  it("includes durationMs in result", async () => {
    const scorer = createStructuredOutputScorer({});
    const result = await scorer.score(makeInput("{}"));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("uses custom id in config", async () => {
    const scorer = createStructuredOutputScorer({ id: "my-scorer" });
    expect(scorer.config.id).toBe("my-scorer");
  });

  it("auto-generates id when not provided", async () => {
    const scorer = createStructuredOutputScorer({});
    expect(scorer.config.id).toMatch(/^structured-output-/);
  });

  it("has correct config name and type", async () => {
    const scorer = createStructuredOutputScorer({});
    expect(scorer.config.name).toBe("structured-output");
    expect(scorer.config.type).toBe("deterministic");
  });
});

// ---------------------------------------------------------------------------
// 2. Missing required field — score < 1.0
// ---------------------------------------------------------------------------

describe("missing required field", () => {
  it("scores 0 when single required field is absent", async () => {
    const scorer = createStructuredOutputScorer({ required: ["name"] });
    const result = await scorer.score(makeInput(json({ age: 30 })));
    expect(result.aggregateScore).toBeLessThan(1);
    expect(result.passed).toBe(false);
  });

  it("includes reasoning about missing field", async () => {
    const scorer = createStructuredOutputScorer({ required: ["email"] });
    const result = await scorer.score(makeInput(json({ name: "Bob" })));
    const reason =
      result.scores.find((s) => s.criterion === "email")?.reasoning ?? "";
    expect(reason).toContain("email");
  });

  it("reduces score for each missing required field", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["a", "b", "c"],
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      },
    });
    // Only 'a' is present → two fields fail
    const result = await scorer.score(makeInput(json({ a: "ok" })));
    expect(result.aggregateScore).toBeLessThan(1);
  });

  it("scores 0 for all required fields when output is empty object", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["x", "y"],
      properties: {
        x: { type: "number" },
        y: { type: "number" },
      },
    });
    const result = await scorer.score(makeInput("{}"));
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Wrong type — field has wrong type
// ---------------------------------------------------------------------------

describe("wrong type", () => {
  it("fails when string field receives number", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["label"],
      properties: { label: { type: "string" } },
    });
    const result = await scorer.score(makeInput(json({ label: 42 })));
    expect(result.aggregateScore).toBeLessThan(1);
    expect(result.passed).toBe(false);
  });

  it("fails when number field receives string (no coercion)", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["count"],
      properties: { count: { type: "number" } },
    });
    const result = await scorer.score(makeInput(json({ count: "five" })));
    expect(result.aggregateScore).toBeLessThan(1);
  });

  it("fails when boolean field receives number", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["active"],
      properties: { active: { type: "boolean" } },
    });
    const result = await scorer.score(makeInput(json({ active: 1 })));
    expect(result.aggregateScore).toBeLessThan(1);
  });

  it("includes type mismatch in score reasoning", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["score"],
      properties: { score: { type: "number" } },
    });
    const result = await scorer.score(makeInput(json({ score: "high" })));
    const entry = result.scores.find((s) => s.criterion === "score");
    expect(entry?.reasoning).toContain("expected type");
  });

  it("returns 0 for invalid JSON input", async () => {
    const scorer = createStructuredOutputScorer({ required: ["x"] });
    const result = await scorer.score(makeInput("not-json"));
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("returns 0 for JSON array at top level", async () => {
    const scorer = createStructuredOutputScorer({ required: ["x"] });
    const result = await scorer.score(makeInput("[1, 2]"));
    expect(result.aggregateScore).toBe(0);
  });

  it("returns 0 for JSON null at top level", async () => {
    const scorer = createStructuredOutputScorer({ required: ["x"] });
    const result = await scorer.score(makeInput("null"));
    expect(result.aggregateScore).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Extra field — output has extra fields not in schema
// ---------------------------------------------------------------------------

describe("extra field handling", () => {
  it("ignores extra fields by default (no penalty)", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["name"],
      properties: { name: { type: "string" } },
    });
    const result = await scorer.score(
      makeInput(json({ name: "Alice", extra: "ignored" })),
    );
    expect(result.aggregateScore).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("penalises extra fields when penaliseExtraFields=true", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["name"],
      properties: { name: { type: "string" } },
      penaliseExtraFields: true,
    });
    const result = await scorer.score(
      makeInput(json({ name: "Alice", extra: "bad" })),
    );
    expect(result.aggregateScore).toBeLessThan(1);
    expect(result.passed).toBe(false);
  });

  it("penalises each extra field separately", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["name"],
      properties: { name: { type: "string" } },
      penaliseExtraFields: true,
    });
    const result = await scorer.score(
      makeInput(json({ name: "Alice", e1: 1, e2: 2 })),
    );
    const extraScores = result.scores.filter((s) =>
      s.criterion.startsWith("e"),
    );
    expect(extraScores.length).toBe(2);
    expect(extraScores.every((s) => s.score === 0)).toBe(true);
  });

  it("still passes when no extra fields and penaliseExtraFields=true", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["name"],
      properties: { name: { type: "string" } },
      penaliseExtraFields: true,
    });
    const result = await scorer.score(makeInput(json({ name: "Alice" })));
    expect(result.aggregateScore).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Nested schema
// ---------------------------------------------------------------------------

describe("nested schema", () => {
  it("validates nested object fields correctly", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["address"],
      properties: {
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            zip: { type: "string" },
          },
        },
      },
    });
    const result = await scorer.score(
      makeInput(
        json({
          address: { street: "123 Main St", zip: "90210" },
        }),
      ),
    );
    expect(result.aggregateScore).toBe(1);
  });

  it("partial score when nested required field is wrong type", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["address"],
      properties: {
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            zip: { type: "number" }, // expects number
          },
        },
      },
    });
    const result = await scorer.score(
      makeInput(
        json({
          address: { street: "123 Main St", zip: "90210" }, // zip is string
        }),
      ),
    );
    expect(result.aggregateScore).toBeLessThan(1);
  });

  it("partial score when one of two nested fields is missing", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["meta"],
      properties: {
        meta: {
          type: "object",
          properties: {
            version: { type: "number" },
            author: { type: "string" },
          },
        },
      },
    });
    // 'author' missing — nested score should be partial
    const result = await scorer.score(
      makeInput(json({ meta: { version: 1 } })),
    );
    const metaScore = result.scores.find((s) => s.criterion === "meta");
    expect(metaScore).toBeDefined();
    expect(metaScore!.score).toBeLessThan(1);
  });

  it("scores 1 when nested object has no property constraints", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["data"],
      properties: {
        data: { type: "object" },
      },
    });
    const result = await scorer.score(
      makeInput(json({ data: { anything: 1 } })),
    );
    expect(result.aggregateScore).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Array schema — array items validated
// ---------------------------------------------------------------------------

describe("array schema", () => {
  it("scores 1.0 when array items all match item type", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["tags"],
      properties: {
        tags: { type: "array", items: { type: "string" } },
      },
    });
    const result = await scorer.score(
      makeInput(json({ tags: ["alpha", "beta", "gamma"] })),
    );
    expect(result.aggregateScore).toBe(1);
  });

  it("partial score when some array items have wrong type", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["ids"],
      properties: {
        ids: { type: "array", items: { type: "number" } },
      },
    });
    // 2 of 4 items are strings (wrong type)
    const result = await scorer.score(
      makeInput(json({ ids: [1, 2, "three", "four"] })),
    );
    const idsScore = result.scores.find((s) => s.criterion === "ids");
    expect(idsScore).toBeDefined();
    expect(idsScore!.score).toBeLessThan(1);
    expect(idsScore!.score).toBeGreaterThan(0);
  });

  it("scores 0 when array required but missing", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["items"],
      properties: { items: { type: "array" } },
    });
    const result = await scorer.score(makeInput(json({})));
    expect(result.aggregateScore).toBe(0);
  });

  it("scores 0 when field is not array but array expected", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["list"],
      properties: { list: { type: "array" } },
    });
    const result = await scorer.score(
      makeInput(json({ list: "not-an-array" })),
    );
    expect(result.aggregateScore).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Partial schema match
// ---------------------------------------------------------------------------

describe("partial schema match", () => {
  it("returns fractional score when half the fields are correct", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["a", "b"],
      properties: {
        a: { type: "string" },
        b: { type: "number" },
      },
    });
    // 'a' correct, 'b' wrong type
    const result = await scorer.score(makeInput(json({ a: "ok", b: "wrong" })));
    expect(result.aggregateScore).toBeGreaterThan(0);
    expect(result.aggregateScore).toBeLessThan(1);
  });

  it("includes per-field breakdown in scores array", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["x", "y"],
      properties: {
        x: { type: "string" },
        y: { type: "number" },
      },
    });
    const result = await scorer.score(
      makeInput(json({ x: "hello", y: "bad" })),
    );
    const xScore = result.scores.find((s) => s.criterion === "x");
    const yScore = result.scores.find((s) => s.criterion === "y");
    expect(xScore?.score).toBe(1);
    expect(yScore?.score).toBe(0);
  });

  it("3-of-4 fields correct → score ~0.75 (equal weights)", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["a", "b", "c", "d"],
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
        d: { type: "string" },
      },
    });
    const result = await scorer.score(
      makeInput(json({ a: "ok", b: "ok", c: "ok", d: 99 })),
    );
    expect(result.aggregateScore).toBeCloseTo(0.75);
  });
});

// ---------------------------------------------------------------------------
// 8. Type coercion
// ---------------------------------------------------------------------------

describe("type coercion", () => {
  it('accepts string "42" for number field when coerce=true', async () => {
    const scorer = createStructuredOutputScorer({
      required: ["count"],
      properties: { count: { type: "number" } },
      coerce: true,
    });
    const result = await scorer.score(makeInput(json({ count: "42" })));
    expect(result.aggregateScore).toBeGreaterThan(0);
    // Coercion gives partial credit (0.8), not full
    expect(result.aggregateScore).toBe(0.8);
  });

  it("rejects non-numeric string for number field even with coerce=true", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["count"],
      properties: { count: { type: "number" } },
      coerce: true,
    });
    const result = await scorer.score(makeInput(json({ count: "abc" })));
    expect(result.aggregateScore).toBe(0);
  });

  it('accepts string "true" for boolean field when coerce=true', async () => {
    const scorer = createStructuredOutputScorer({
      required: ["flag"],
      properties: { flag: { type: "boolean" } },
      coerce: true,
    });
    const result = await scorer.score(makeInput(json({ flag: "true" })));
    expect(result.aggregateScore).toBe(0.8);
  });

  it('accepts string "false" for boolean field when coerce=true', async () => {
    const scorer = createStructuredOutputScorer({
      required: ["flag"],
      properties: { flag: { type: "boolean" } },
      coerce: true,
    });
    const result = await scorer.score(makeInput(json({ flag: "false" })));
    expect(result.aggregateScore).toBe(0.8);
  });

  it("rejects wrong type without coercion", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["count"],
      properties: { count: { type: "number" } },
      coerce: false,
    });
    const result = await scorer.score(makeInput(json({ count: "42" })));
    expect(result.aggregateScore).toBe(0);
  });

  it("coerce=false is the default", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["n"],
      properties: { n: { type: "number" } },
    });
    const result = await scorer.score(makeInput(json({ n: "10" })));
    expect(result.aggregateScore).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Enum validation
// ---------------------------------------------------------------------------

describe("enum validation", () => {
  it("scores 1.0 when field value is in enum list", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["active", "inactive", "pending"] },
      },
    });
    const result = await scorer.score(makeInput(json({ status: "active" })));
    expect(result.aggregateScore).toBe(1);
  });

  it("scores 0 when field value is not in enum list", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["active", "inactive"] },
      },
    });
    const result = await scorer.score(makeInput(json({ status: "unknown" })));
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("includes enum mismatch in reasoning", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["level"],
      properties: {
        level: { enum: ["low", "medium", "high"] },
      },
    });
    const result = await scorer.score(makeInput(json({ level: "ultra" })));
    const entry = result.scores.find((s) => s.criterion === "level");
    expect(entry?.reasoning).toContain("enum");
  });

  it("works with numeric enum values", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["code"],
      properties: {
        code: { type: "number", enum: [200, 201, 204] },
      },
    });
    const result1 = await scorer.score(makeInput(json({ code: 200 })));
    expect(result1.aggregateScore).toBe(1);

    const result2 = await scorer.score(makeInput(json({ code: 404 })));
    expect(result2.aggregateScore).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Pattern validation
// ---------------------------------------------------------------------------

describe("pattern validation", () => {
  it("scores 1.0 when string matches regex pattern", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["email"],
      properties: {
        email: { type: "string", pattern: "^[^@]+@[^@]+\\.[^@]+$" },
      },
    });
    const result = await scorer.score(
      makeInput(json({ email: "user@example.com" })),
    );
    expect(result.aggregateScore).toBe(1);
  });

  it("scores 0 when string does not match pattern", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["email"],
      properties: {
        email: { type: "string", pattern: "^[^@]+@[^@]+\\.[^@]+$" },
      },
    });
    const result = await scorer.score(
      makeInput(json({ email: "not-an-email" })),
    );
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("includes pattern mismatch in reasoning", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["code"],
      properties: {
        code: { type: "string", pattern: "^[A-Z]{3}-\\d{4}$" },
      },
    });
    const result = await scorer.score(makeInput(json({ code: "bad" })));
    const entry = result.scores.find((s) => s.criterion === "code");
    expect(entry?.reasoning).toContain("pattern");
  });

  it("validates UUID-like pattern", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["id"],
      properties: {
        id: {
          type: "string",
          pattern:
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        },
      },
    });
    const valid = await scorer.score(
      makeInput(json({ id: "550e8400-e29b-41d4-a716-446655440000" })),
    );
    expect(valid.aggregateScore).toBe(1);

    const invalid = await scorer.score(makeInput(json({ id: "not-a-uuid" })));
    expect(invalid.aggregateScore).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Nullable field
// ---------------------------------------------------------------------------

describe("nullable field", () => {
  it("accepts null for nullable field", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["comment"],
      properties: {
        comment: { type: "string", nullable: true },
      },
    });
    const result = await scorer.score(makeInput(json({ comment: null })));
    expect(result.aggregateScore).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("rejects null for non-nullable field", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["name"],
      properties: {
        name: { type: "string", nullable: false },
      },
    });
    const result = await scorer.score(makeInput(json({ name: null })));
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("rejects null when nullable not specified (defaults to false)", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["value"],
      properties: { value: { type: "number" } },
    });
    const result = await scorer.score(makeInput(json({ value: null })));
    expect(result.aggregateScore).toBe(0);
  });

  it("includes nullable reasoning in result", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["opt"],
      properties: { opt: { type: "string", nullable: true } },
    });
    const result = await scorer.score(makeInput(json({ opt: null })));
    const entry = result.scores.find((s) => s.criterion === "opt");
    expect(entry?.reasoning).toContain("null");
  });
});

// ---------------------------------------------------------------------------
// 12. Optional field missing
// ---------------------------------------------------------------------------

describe("optional field", () => {
  it("does not penalise missing optional field", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["name"],
      properties: {
        name: { type: "string" },
        nickname: { type: "string", optional: true },
      },
    });
    const result = await scorer.score(makeInput(json({ name: "Alice" })));
    expect(result.aggregateScore).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("still validates optional field when present", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["name"],
      properties: {
        name: { type: "string" },
        age: { type: "number", optional: true },
      },
    });
    // age present but wrong type
    const result = await scorer.score(
      makeInput(json({ name: "Alice", age: "thirty" })),
    );
    expect(result.aggregateScore).toBeLessThan(1);
  });

  it("validates optional field correctly when present with correct type", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["name"],
      properties: {
        name: { type: "string" },
        age: { type: "number", optional: true },
      },
    });
    const result = await scorer.score(
      makeInput(json({ name: "Alice", age: 30 })),
    );
    expect(result.aggregateScore).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 13. Deep nesting — 3-level nested schema
// ---------------------------------------------------------------------------

describe("deep nesting", () => {
  it("validates 3-level nested schema correctly", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["org"],
      properties: {
        org: {
          type: "object",
          properties: {
            name: { type: "string" },
            address: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
            },
          },
        },
      },
    });
    const result = await scorer.score(
      makeInput(
        json({
          org: {
            name: "Acme",
            address: { city: "Springfield" },
          },
        }),
      ),
    );
    expect(result.aggregateScore).toBe(1);
  });

  it("partial score when deep nested field is wrong type", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["org"],
      properties: {
        org: {
          type: "object",
          properties: {
            name: { type: "string" },
            address: {
              type: "object",
              properties: {
                zip: { type: "number" },
              },
            },
          },
        },
      },
    });
    // zip should be number but is string
    const result = await scorer.score(
      makeInput(
        json({
          org: { name: "Acme", address: { zip: "not-a-number" } },
        }),
      ),
    );
    expect(result.aggregateScore).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// 14. Array length constraints
// ---------------------------------------------------------------------------

describe("array length constraints", () => {
  it("scores 0 when array is shorter than minItems", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["items"],
      properties: {
        items: { type: "array", minItems: 3 },
      },
    });
    const result = await scorer.score(makeInput(json({ items: [1, 2] })));
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("scores 0 when array exceeds maxItems", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["items"],
      properties: {
        items: { type: "array", maxItems: 3 },
      },
    });
    const result = await scorer.score(
      makeInput(json({ items: [1, 2, 3, 4, 5] })),
    );
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("scores 1.0 when array length is exactly at minItems", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["items"],
      properties: {
        items: { type: "array", minItems: 2 },
      },
    });
    const result = await scorer.score(makeInput(json({ items: [1, 2] })));
    expect(result.aggregateScore).toBe(1);
  });

  it("scores 1.0 when array length is exactly at maxItems", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["items"],
      properties: {
        items: { type: "array", maxItems: 5 },
      },
    });
    const result = await scorer.score(
      makeInput(json({ items: [1, 2, 3, 4, 5] })),
    );
    expect(result.aggregateScore).toBe(1);
  });

  it("includes length constraint in reasoning", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["tags"],
      properties: {
        tags: { type: "array", minItems: 3 },
      },
    });
    const result = await scorer.score(makeInput(json({ tags: ["a"] })));
    const entry = result.scores.find((s) => s.criterion === "tags");
    expect(entry?.reasoning).toContain("1 items");
    expect(entry?.reasoning).toContain("3");
  });

  it("scores 1.0 when array is within minItems and maxItems range", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["list"],
      properties: {
        list: { type: "array", minItems: 2, maxItems: 5 },
      },
    });
    const result = await scorer.score(
      makeInput(json({ list: ["a", "b", "c"] })),
    );
    expect(result.aggregateScore).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 15. Scoring weight — configurable per-field weights
// ---------------------------------------------------------------------------

describe("scoring weight", () => {
  it("high-weight correct field outweighs low-weight incorrect field", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["important", "minor"],
      properties: {
        important: { type: "string", weight: 10 },
        minor: { type: "string", weight: 1 },
      },
    });
    // important is correct (weight 10), minor is wrong (weight 1)
    const result = await scorer.score(
      makeInput(json({ important: "ok", minor: 999 })),
    );
    // Score = (10*1 + 1*0) / 11 ≈ 0.909
    expect(result.aggregateScore).toBeCloseTo(10 / 11);
    expect(result.passed).toBe(false); // not 1.0
  });

  it("low-weight correct field does not save high-weight wrong field", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["critical", "trivial"],
      properties: {
        critical: { type: "number", weight: 10 },
        trivial: { type: "string", weight: 1 },
      },
    });
    // critical wrong (weight 10), trivial correct (weight 1)
    const result = await scorer.score(
      makeInput(json({ critical: "bad", trivial: "ok" })),
    );
    // Score = (10*0 + 1*1) / 11 ≈ 0.091
    expect(result.aggregateScore).toBeCloseTo(1 / 11);
  });

  it("equal weights produce equal contribution to aggregate", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["a", "b"],
      properties: {
        a: { type: "string", weight: 2 },
        b: { type: "string", weight: 2 },
      },
    });
    // both correct → same as 1 1 weight
    const result = await scorer.score(makeInput(json({ a: "ok", b: "ok" })));
    expect(result.aggregateScore).toBe(1);
  });

  it("missing required field uses its property weight in scoring", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["a", "b"],
      properties: {
        a: { type: "string", weight: 1 },
        b: { type: "string", weight: 9 },
      },
    });
    // 'a' present and correct (weight 1), 'b' missing (weight 9 → score 0)
    const result = await scorer.score(makeInput(json({ a: "ok" })));
    // Score = (1*1 + 9*0) / 10 = 0.1
    expect(result.aggregateScore).toBeCloseTo(0.1);
  });

  it("default weight is 1 when not specified", async () => {
    const scorer = createStructuredOutputScorer({
      required: ["x", "y"],
      properties: {
        x: { type: "string" }, // weight defaults to 1
        y: { type: "string" }, // weight defaults to 1
      },
    });
    // x correct, y wrong → 0.5
    const result = await scorer.score(makeInput(json({ x: "ok", y: 123 })));
    expect(result.aggregateScore).toBeCloseTo(0.5);
  });
});
