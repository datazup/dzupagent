import { describe, expect, it } from "vitest";

import { parseFlowReferenceExpression } from "../expressions.js";

// ---------------------------------------------------------------------------
// DZUPAGENT-TEST-M1: reference-expression/parser.ts sat at 68% line coverage
// (123 uncovered lines) because the existing reference-expression.test.ts
// suite only exercised the "typical" parse paths. This file targets the
// remaining structural error branches: unbalanced/nested template
// delimiters, malformed property access, unexpected tokens, unterminated
// indexes, filter-name/argument edge cases, and custom allowedRoots.
// ---------------------------------------------------------------------------

describe("parseFlowReferenceExpression — template delimiter errors", () => {
  it("rejects unbalanced template delimiters", () => {
    const result = parseFlowReferenceExpression("{{ state.x", {
      policy: "strict",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: "MALFORMED_REFERENCE",
      message: "reference template delimiters are unbalanced",
    });
  });

  it("rejects nested template delimiters", () => {
    const result = parseFlowReferenceExpression("{{ state.{{ x }} }}", {
      policy: "strict",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: "MALFORMED_REFERENCE",
      message: "nested template delimiters are not supported",
    });
  });

  it("treats an unwrapped bare expression as valid input", () => {
    const result = parseFlowReferenceExpression("state.ready");
    expect(result.ok).toBe(true);
  });
});

describe("parseFlowReferenceExpression — empty and malformed roots", () => {
  it("reports EMPTY_REFERENCE for a blank source", () => {
    const result = parseFlowReferenceExpression("   ", { policy: "strict" });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: "EMPTY_REFERENCE",
      message: "reference expression is empty",
    });
  });

  it("reports MALFORMED_REFERENCE when the root is not an identifier", () => {
    const result = parseFlowReferenceExpression("123abc", {
      policy: "strict",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: "MALFORMED_REFERENCE",
      message: "reference must start with an identifier",
    });
  });
});

describe("parseFlowReferenceExpression — property and index errors", () => {
  it("reports a malformed reference when a dot is not followed by an identifier", () => {
    const result = parseFlowReferenceExpression("state.", {
      policy: "strict",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: "MALFORMED_REFERENCE",
      message: "property access must be followed by an identifier",
    });
  });

  it("reports an unexpected token in the reference path", () => {
    const result = parseFlowReferenceExpression("state,items", {
      policy: "strict",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: "MALFORMED_REFERENCE",
    });
    expect(result.diagnostics[0]!.message).toContain("unexpected token");
  });

  it("reports a missing closing bracket for an index segment", () => {
    const result = parseFlowReferenceExpression("state.items[0", {
      policy: "strict",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: "INVALID_REFERENCE_INDEX",
      message: "reference index is missing a closing bracket",
    });
  });

  it("parses a valid unsigned integer index", () => {
    const result = parseFlowReferenceExpression("state.items[3]");
    expect(result.ok).toBe(true);
    expect(result.reference?.segments).toEqual([
      expect.objectContaining({ kind: "property", key: "items" }),
      expect.objectContaining({ kind: "index", index: 3 }),
    ]);
  });
});

describe("parseFlowReferenceExpression — filter parsing edge cases", () => {
  it("reports a malformed reference when a filter has no name", () => {
    const result = parseFlowReferenceExpression("state.items | ", {
      policy: "strict",
    });
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((d) =>
        d.message.includes("template filter must declare a name"),
      ),
    ).toBe(true);
  });

  it("reports unexpected content in a filter without a colon argument", () => {
    const result = parseFlowReferenceExpression(
      "state.items | upper extra",
      { policy: "strict" },
    );
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((d) =>
        d.message.includes('unexpected content in filter "upper"'),
      ),
    ).toBe(true);
  });

  it("parses a quoted string filter argument", () => {
    const result = parseFlowReferenceExpression(
      'state.items | default:"fallback"',
    );
    expect(result.ok).toBe(true);
    expect(result.reference?.filters).toEqual([
      expect.objectContaining({ name: "default", argument: "fallback" }),
    ]);
  });

  it("parses a signed-integer filter argument", () => {
    const result = parseFlowReferenceExpression("state.items | default:-5");
    expect(result.ok).toBe(true);
    expect(result.reference?.filters).toEqual([
      expect.objectContaining({ name: "default", argument: -5 }),
    ]);
  });

  it("parses a bare unquoted word filter argument", () => {
    const result = parseFlowReferenceExpression(
      "state.items | default:fallbackValue",
    );
    expect(result.ok).toBe(true);
    expect(result.reference?.filters).toEqual([
      expect.objectContaining({
        name: "default",
        argument: "fallbackValue",
      }),
    ]);
  });

  it("reports an invalid argument when the unquoted value contains whitespace", () => {
    const result = parseFlowReferenceExpression(
      "state.items | default:not valid",
      { policy: "strict" },
    );
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.code === "INVALID_REFERENCE_FILTER_ARGUMENT",
      ),
    ).toBe(true);
  });

  it("chains multiple filters", () => {
    const result = parseFlowReferenceExpression(
      "state.items | upper | trim",
    );
    expect(result.ok).toBe(true);
    expect(result.reference?.filters.map((f) => f.name)).toEqual([
      "upper",
      "trim",
    ]);
  });
});

describe("parseFlowReferenceExpression — custom allowedRoots", () => {
  it("accepts a root outside the default sets when explicitly allowed", () => {
    const result = parseFlowReferenceExpression("custom.value", {
      policy: "strict",
      allowedRoots: ["custom"],
    });
    expect(result.ok).toBe(true);
  });

  it("still rejects a root outside a custom allowlist", () => {
    const result = parseFlowReferenceExpression("state.value", {
      policy: "strict",
      allowedRoots: ["custom"],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "DISALLOWED_REFERENCE_ROOT" }),
    );
  });

  it("does not flag a missing reference when the root has no segments", () => {
    const result = parseFlowReferenceExpression("inputs", {
      policy: "strict",
      knownBindings: { inputs: ["goal"] },
    });
    expect(result.ok).toBe(true);
  });
});
