import { describe, expect, it } from "vitest";

import {
  type FlowExpression,
  type FlowTypedCondition,
} from "../expressions.js";
import {
  evaluateFlowTypedCondition,
  FLOW_TYPED_CONDITION_CAPABILITY,
} from "../typed-condition-evaluator.js";

const capability = [FLOW_TYPED_CONDITION_CAPABILITY];

function condition(expression: FlowExpression): FlowTypedCondition {
  return {
    schema: "dzupagent.flowTypedCondition/v1",
    expression,
  };
}

describe("evaluateFlowTypedCondition", () => {
  it("requires exact host capability acknowledgment", () => {
    expect(
      evaluateFlowTypedCondition(condition({ op: "literal", value: true }), {
        hostCapabilities: [],
        bindings: {},
      }),
    ).toMatchObject({
      ok: false,
      code: "TYPED_CONDITION_CAPABILITY_REQUIRED",
    });
  });

  it("evaluates boolean composition without truthy coercion", () => {
    const expression: FlowExpression = {
      op: "and",
      args: [
        { op: "ref", path: "inputs.ready" },
        {
          op: "gte",
          left: { op: "ref", path: "inputs.score" },
          right: { op: "literal", value: 3 },
        },
      ],
    };
    expect(
      evaluateFlowTypedCondition(condition(expression), {
        hostCapabilities: capability,
        bindings: { inputs: { ready: true, score: 4 } },
      }),
    ).toEqual({
      ok: true,
      value: true,
      resolvedReferences: ["inputs.ready", "inputs.score"],
    });
    expect(
      evaluateFlowTypedCondition(
        condition({
          op: "and",
          args: [{ op: "literal", value: "truthy" }],
        }),
        { hostCapabilities: capability, bindings: {} },
      ),
    ).toMatchObject({
      ok: false,
      code: "TYPED_CONDITION_TYPE_MISMATCH",
      path: "condition.expression.args[0]",
    });
  });

  it("supports strict indexed references and deterministic filters", () => {
    expect(
      evaluateFlowTypedCondition(
        condition({
          op: "eq",
          left: {
            op: "ref",
            path: 'steps.review.results[0].summary | default:"missing" | upper',
          },
          right: { op: "literal", value: "APPROVED" },
        }),
        {
          hostCapabilities: capability,
          bindings: {
            steps: {
              review: { results: [{ summary: "approved" }] },
            },
          },
        },
      ),
    ).toMatchObject({ ok: true, value: true });
  });

  it("covers the bounded operator set and short-circuits guarded missing values", () => {
    const cases: Array<[FlowExpression, boolean]> = [
      [
        {
          op: "or",
          args: [
            { op: "literal", value: true },
            { op: "ref", path: "inputs.missing" },
          ],
        },
        true,
      ],
      [
        {
          op: "not",
          arg: { op: "literal", value: false },
        },
        true,
      ],
      [
        {
          op: "ne",
          left: { op: "literal", value: "a" },
          right: { op: "literal", value: "b" },
        },
        true,
      ],
      [
        {
          op: "gt",
          left: { op: "literal", value: 4 },
          right: { op: "literal", value: 3 },
        },
        true,
      ],
      [
        {
          op: "lt",
          left: { op: "literal", value: "a" },
          right: { op: "literal", value: "b" },
        },
        true,
      ],
      [
        {
          op: "lte",
          left: { op: "literal", value: 3 },
          right: { op: "literal", value: 3 },
        },
        true,
      ],
      [
        {
          op: "in",
          value: { op: "literal", value: "b" },
          collection: { op: "ref", path: "inputs.labels" },
        },
        true,
      ],
      [
        {
          op: "eq",
          left: { op: "ref", path: "inputs.labels | length" },
          right: { op: "literal", value: 2 },
        },
        true,
      ],
      [
        {
          op: "eq",
          left: { op: "ref", path: "inputs.payload | json" },
          right: { op: "literal", value: '{"ready":true}' },
        },
        true,
      ],
    ];
    for (const [expression, expected] of cases) {
      expect(
        evaluateFlowTypedCondition(condition(expression), {
          hostCapabilities: capability,
          bindings: {
            inputs: {
              labels: ["a", "b"],
              payload: { ready: true },
            },
          },
        }),
      ).toMatchObject({ ok: true, value: expected });
    }
  });

  it("keeps missing behavior explicit for exists, empty, and comparisons", () => {
    const options = {
      hostCapabilities: capability,
      bindings: { inputs: {} },
    };
    expect(
      evaluateFlowTypedCondition(
        condition({
          op: "exists",
          arg: { op: "ref", path: "inputs.optional" },
        }),
        options,
      ),
    ).toMatchObject({ ok: true, value: false });
    expect(
      evaluateFlowTypedCondition(
        condition({
          op: "empty",
          arg: { op: "ref", path: "inputs.optional" },
        }),
        options,
      ),
    ).toMatchObject({ ok: true, value: true });
    expect(
      evaluateFlowTypedCondition(
        condition({
          op: "eq",
          left: { op: "ref", path: "inputs.optional" },
          right: { op: "literal", value: null },
        }),
        options,
      ),
    ).toMatchObject({
      ok: false,
      code: "TYPED_REFERENCE_MISSING",
    });
  });

  it("uses structural equality for portable collection membership", () => {
    expect(
      evaluateFlowTypedCondition(
        condition({
          op: "contains",
          collection: { op: "ref", path: "state.items" },
          value: { op: "ref", path: "inputs.target" },
        }),
        {
          hostCapabilities: capability,
          bindings: {
            inputs: { target: { id: 2, tags: ["a"] } },
            state: {
              items: [{ id: 1 }, { tags: ["a"], id: 2 }],
            },
          },
        },
      ),
    ).toMatchObject({ ok: true, value: true });
  });

  it("fails closed for JavaScript, malformed references, and unsupported values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      evaluateFlowTypedCondition(condition({ exprJs: "Date.now() > 0" }), {
        hostCapabilities: capability,
        bindings: {},
      }),
    ).toMatchObject({
      ok: false,
      code: "RAW_JS_EXPRESSION_FORBIDDEN",
    });
    expect(
      evaluateFlowTypedCondition(condition({ op: "ref", path: "ctx.ready" }), {
        hostCapabilities: capability,
        bindings: { ctx: { ready: true } },
      }),
    ).toMatchObject({
      ok: false,
      code: "INVALID_TYPED_REFERENCE",
    });
    expect(
      evaluateFlowTypedCondition(
        condition({
          op: "eq",
          left: { op: "ref", path: "state.when" },
          right: { op: "ref", path: "state.when" },
        }),
        {
          hostCapabilities: capability,
          bindings: { state: { when: new Date(0) } },
        },
      ),
    ).toMatchObject({
      ok: false,
      code: "TYPED_CONDITION_VALUE_UNSUPPORTED",
    });
    expect(
      evaluateFlowTypedCondition(
        condition({
          op: "eq",
          left: { op: "ref", path: "state.cyclic" },
          right: { op: "ref", path: "state.cyclic" },
        }),
        {
          hostCapabilities: capability,
          bindings: { state: { cyclic } },
        },
      ),
    ).toMatchObject({
      ok: false,
      code: "TYPED_CONDITION_VALUE_UNSUPPORTED",
    });
  });
});
