import { describe, expect, it } from "vitest";

import {
  evaluateFlowTypedCondition,
  FLOW_TYPED_CONDITION_CAPABILITY,
  type FlowExpression,
  type FlowTypedCondition,
} from "../index.js";

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
  });
});
