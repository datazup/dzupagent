import {
  type FlowExpression,
  type ToolResolver,
} from "@dzupagent/flow-ast";
import {
  evaluateFlowTypedCondition,
  FLOW_TYPED_CONDITION_CAPABILITY,
} from "@dzupagent/flow-ast/typed-condition-evaluator";
import { parseDslToDocument } from "@dzupagent/flow-dsl";
import { describe, expect, it } from "vitest";

import {
  collectFlowRequirements,
  createFlowCompiler,
} from "../index.js";
import { analyzeFlowExpressionContract } from "../stages/expression-validate.js";

const resolver: ToolResolver = {
  resolve: () => null,
  listAvailable: () => [],
};

describe("typed dzupflow/v2 conditions", () => {
  it("keeps analyzer-valid fixtures aligned with provider-free evaluation", () => {
    const fixtures: Array<{
      expression: FlowExpression;
      bindings: Readonly<Record<string, unknown>>;
      expected: boolean;
    }> = [
      {
        expression: {
          op: "gte",
          left: { op: "ref", path: "inputs.score" },
          right: { op: "literal", value: 3 },
        },
        bindings: { inputs: { score: 4 } },
        expected: true,
      },
      {
        expression: {
          op: "contains",
          collection: { op: "ref", path: "inputs.label" },
          value: { op: "literal", value: "approved" },
        },
        bindings: { inputs: { label: "review-approved" } },
        expected: true,
      },
      {
        expression: {
          op: "and",
          args: [
            { op: "ref", path: "inputs.ready" },
            {
              op: "not",
              arg: { op: "ref", path: "inputs.blocked" },
            },
          ],
        },
        bindings: { inputs: { ready: true, blocked: true } },
        expected: false,
      },
    ];

    for (const fixture of fixtures) {
      const analysis = analyzeFlowExpressionContract(fixture.expression, {
        policy: "strict",
        knownBindings: {
          inputs: ["score", "label", "ready", "blocked"],
        },
        typeBindings: {
          inputs: {
            score: "number",
            label: "string",
            ready: "boolean",
            blocked: "boolean",
          },
        },
        requireKnownTypes: true,
      });
      expect(analysis).toMatchObject({
        deterministic: true,
        resultType: "boolean",
        issues: [],
      });
      expect(
        evaluateFlowTypedCondition(
          {
            schema: "dzupagent.flowTypedCondition/v1",
            expression: fixture.expression,
          },
          {
            hostCapabilities: [FLOW_TYPED_CONDITION_CAPABILITY],
            bindings: fixture.bindings,
          },
        ),
      ).toMatchObject({
        ok: true,
        value: fixture.expected,
      });
    }
  });

  it("accepts literal boolean and declared compatible comparison contracts", () => {
    expect(
      analyzeFlowExpressionContract(
        { op: "literal", value: true },
        { requireKnownTypes: true },
      ),
    ).toMatchObject({
      deterministic: true,
      resultType: "boolean",
      issues: [],
    });
    expect(
      analyzeFlowExpressionContract(
        {
          op: "gte",
          left: { op: "ref", path: "inputs.score" },
          right: { op: "literal", value: 3 },
        },
        {
          policy: "strict",
          knownBindings: { inputs: ["score"] },
          typeBindings: { inputs: { score: "number" } },
          requireKnownTypes: true,
        },
      ),
    ).toMatchObject({
      deterministic: true,
      refs: ["inputs.score"],
      resultType: "boolean",
      issues: [],
    });
    expect(
      analyzeFlowExpressionContract(
        {
          op: "gte",
          left: { op: "ref", path: "inputs.label" },
          right: { op: "literal", value: 3 },
        },
        {
          policy: "strict",
          knownBindings: { inputs: ["label"] },
          typeBindings: { inputs: { label: "string" } },
          requireKnownTypes: true,
        },
      ).issues,
    ).toContainEqual(
      expect.objectContaining({
        code: "EXPRESSION_TYPE_MISMATCH",
        path: "expression",
      }),
    );
  });

  it("blocks a valid typed condition at target lowering with exact authored span", async () => {
    const source = typedSource(`
    when:
      gte:
        - ref: inputs.score
        - 3
`);
    const result = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDsl(source);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected capability block");
    const diagnostic = result.errors.find(
      (item) => item.code === "TYPED_CONDITION_TARGET_UNSUPPORTED",
    );
    expect(diagnostic).toMatchObject({
      stage: 4,
      nodePath: "root.nodes[0].typedCondition",
      span: {
        kind: "source-offsets",
      },
    });
    if (diagnostic?.span?.kind !== "source-offsets") {
      throw new Error("expected absolute typed-condition span");
    }
    expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toContain(
      "gte:",
    );
  });

  it("rejects a missing reference at its exact authored ref value", async () => {
    const source = typedSource(`
    when:
      ref: inputs.missing
`);
    const result = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDsl(source);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected strict reference error");
    const diagnostic = result.errors.find(
      (item) =>
        item.code === "INVALID_CONDITION" &&
        item.message.includes("MISSING_REFERENCE"),
    );
    expect(diagnostic).toMatchObject({
      stage: 3,
      nodePath:
        "root.nodes[0].typedCondition.expression.path",
      span: { kind: "source-offsets" },
    });
    if (diagnostic?.span?.kind !== "source-offsets") {
      throw new Error("expected exact authored reference span");
    }
    expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toBe(
      "inputs.missing",
    );
  });

  it("rejects a declared non-boolean condition result", async () => {
    const source = typedSource(`
    when:
      ref: inputs.score
`);
    const result = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDsl(source);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected non-boolean error");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 3,
          code: "INVALID_CONDITION",
          nodePath: "root.nodes[0].typedCondition",
          message: expect.stringContaining("boolean is required"),
        }),
      ]),
    );
  });

  it("models guarded state as unavailable after the branch", async () => {
    const source = `dsl: dzupflow/v2
id: guarded-availability
version: 2.0.0
inputs:
  ready: boolean
steps:
  - id: seed
    use: core.set@1
    when:
      ref: inputs.ready
    with:
      assign:
        guardedReady: true
  - id: done
    use: core.complete@1
    when:
      ref: state.guardedReady
    with:
      result: accepted
`;
    const result = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDsl(source);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected availability error");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_REFERENCE",
          message: expect.stringContaining("REFERENCE_NOT_AVAILABLE"),
          nodePath:
            "root.nodes[1].typedCondition.expression.path",
        }),
      ]),
    );
  });

  it("publishes typed-condition capability without claiming host support", () => {
    const parsed = parseDslToDocument(
      typedSource(`
    when: true
`),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const requirements = collectFlowRequirements(parsed.document.root);
    expect(requirements.requiredCapabilities).toContain(
      "flow.control.typed-condition@1",
    );
  });
});

function typedSource(whenBlock: string): string {
  return `dsl: dzupflow/v2
id: typed-condition
version: 2.0.0
inputs:
  ready: boolean
  score: number
steps:
  - id: done
    use: core.complete@1
${whenBlock}    with:
      result: accepted
`;
}
