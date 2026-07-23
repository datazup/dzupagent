import { describe, expect, it } from "vitest";

import {
  analyzeFlowTemplateReferences,
  flowReference,
  isFlowReferenceValue,
  parseFlowReferenceExpression,
} from "../expressions.js";

describe("parseFlowReferenceExpression", () => {
  it("parses canonical properties, indexes, and closed-set filters", () => {
    const result = parseFlowReferenceExpression(
      '{{ steps.review.results[0].summary | default:"missing" | upper }}',
      { policy: "strict", sourcePath: "root.nodes[2].prompt" },
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.reference).toMatchObject({
      root: "steps",
      source:
        'steps.review.results[0].summary | default:"missing" | upper',
      segments: [
        { kind: "property", key: "review" },
        { kind: "property", key: "results" },
        { kind: "index", index: 0 },
        { kind: "property", key: "summary" },
      ],
      filters: [
        { name: "default", argument: "missing" },
        { name: "upper" },
      ],
    });
  });

  it("keeps legacy roots compatible by default", () => {
    const result = parseFlowReferenceExpression("ctx.ready");

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects legacy and unknown roots in strict mode", () => {
    for (const source of ["ctx.ready", "environment.token"]) {
      const result = parseFlowReferenceExpression(source, { policy: "strict" });
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "DISALLOWED_REFERENCE_ROOT",
          severity: "error",
        }),
      );
    }
  });

  it("downgrades malformed indexes and unknown filters to compat warnings", () => {
    const result = parseFlowReferenceExpression(
      "{{ state.items[-1] | mystery }}",
      { policy: "compat-v1" },
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "INVALID_REFERENCE_INDEX",
      "UNKNOWN_REFERENCE_FILTER",
    ]);
    expect(
      result.diagnostics.every(
        (diagnostic) => diagnostic.severity === "warning",
      ),
    ).toBe(true);
  });

  it("makes the same diagnostics fatal in strict mode", () => {
    const result = parseFlowReferenceExpression(
      "{{ state.items[nope] | mystery }}",
      { policy: "strict" },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "INVALID_REFERENCE_INDEX",
      "UNKNOWN_REFERENCE_FILTER",
    ]);
  });

  it("validates declared root bindings when a symbol snapshot is supplied", () => {
    const result = parseFlowReferenceExpression("inputs.missing", {
      policy: "strict",
      knownBindings: { inputs: ["goal", "cwd"] },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "MISSING_REFERENCE",
        message: 'reference "inputs.missing" is not declared',
      }),
    );
  });

  it("validates filter arguments", () => {
    expect(
      parseFlowReferenceExpression("state.items | default", {
        policy: "strict",
      }).diagnostics,
    ).toContainEqual(
      expect.objectContaining({
        code: "INVALID_REFERENCE_FILTER_ARGUMENT",
      }),
    );
    expect(
      parseFlowReferenceExpression("state.items | length:2", {
        policy: "strict",
      }).diagnostics,
    ).toContainEqual(
      expect.objectContaining({
        code: "INVALID_REFERENCE_FILTER_ARGUMENT",
      }),
    );
  });
});

describe("analyzeFlowTemplateReferences", () => {
  it("distinguishes whole-value references from interpolation", () => {
    const whole = analyzeFlowTemplateReferences("  {{ state.count }}  ", {
      policy: "strict",
    });
    const interpolation = analyzeFlowTemplateReferences(
      "count={{ state.count }} of {{ inputs.total }}",
      { policy: "strict" },
    );

    expect(whole.form).toBe("whole-value");
    expect(whole.references.map((reference) => reference.source)).toEqual([
      "state.count",
    ]);
    expect(interpolation.form).toBe("interpolation");
    expect(
      interpolation.references.map((reference) => reference.source),
    ).toEqual(["state.count", "inputs.total"]);
  });

  it("reports source-path and exact offset for strict diagnostics", () => {
    const analysis = analyzeFlowTemplateReferences(
      "prefix {{ state.items[-1] }}",
      {
        policy: "strict",
        sourcePath: "root.nodes[0].question",
      },
    );

    expect(analysis.valid).toBe(false);
    expect(analysis.diagnostics[0]).toMatchObject({
      code: "INVALID_REFERENCE_INDEX",
      sourcePath: "root.nodes[0].question",
      start: 21,
      end: 25,
    });
  });

  it("reports unterminated templates without throwing", () => {
    const analysis = analyzeFlowTemplateReferences("{{ state.ready", {
      policy: "strict",
    });

    expect(analysis.valid).toBe(false);
    expect(analysis.diagnostics).toContainEqual(
      expect.objectContaining({ code: "UNTERMINATED_TEMPLATE" }),
    );
  });
});

describe("flowReference", () => {
  it("creates an immutable typed authored reference", () => {
    const reference = flowReference<number>("params.concurrency");

    expect(reference).toEqual({
      kind: "flow-reference",
      source: "params.concurrency",
    });
    expect(isFlowReferenceValue(reference)).toBe(true);
    expect(Object.isFrozen(reference)).toBe(true);
  });

  it("rejects invalid authored references", () => {
    expect(() => flowReference("ctx.value")).toThrow(/not allowed/);
  });
});
