/**
 * F-R4 — `loop` admits a canonical typed condition, on the SAME fail-closed
 * contract `branch` already enforces.
 *
 * Doc 16 mandates a typed-condition evaluator for loops ("no arbitrary
 * condition strings unattended"). `BranchNode` carries `typedCondition?:
 * FlowTypedCondition`, and BOTH the parse and validate boundaries require the
 * legacy `condition` to equal the fail-closed shadow ("false") whenever it is
 * present — so a legacy evaluator that ignores the typed form can never
 * iterate on stale semantics. `LoopNode` carried only `condition: string`,
 * which is precisely why unattended compilation denies loops outright
 * (FLOW_LOOP_CONDITION_RUNTIME_ONLY).
 *
 * Pinned at BOTH boundaries: parse and validate are separate hand-written
 * rules, so covering one leaves the other free to diverge (the DSL-01 defect
 * class, and exactly how loop.progressKey was silently dropped — see
 * loop-progress-key.test.ts).
 */
import { describe, expect, it } from "vitest";

import { FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW } from "../expressions.js";
import { parseFlow } from "../index.js";
import { flowNodeSchema } from "../validate.js";

const TYPED = {
  schema: "dzupagent.flowTypedCondition/v1",
  expression: {
    op: "eq",
    left: { op: "ref", path: "status" },
    right: { op: "literal", value: "pending" },
  },
};

const body = [{ type: "complete" }];

/** A loop carrying a typed condition + the required fail-closed shadow. */
const typedLoop = {
  type: "loop",
  condition: FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
  typedCondition: TYPED,
  body,
};

describe("F-R4 — loop typed condition", () => {
  it("parseFlow keeps typedCondition and the fail-closed shadow on the loop node", () => {
    const result = parseFlow(typedLoop);

    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    // Exact equality, as loop-progress-key does: a silently dropped
    // typedCondition fails here rather than passing a truthiness check.
    expect(result.ast).toEqual(typedLoop);
  });

  it("flowNodeSchema keeps typedCondition on the validated loop node", () => {
    const result = flowNodeSchema.safeParse(typedLoop);

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Pin the VALUE, not presence.
    expect(result.data).toMatchObject({
      condition: FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
      typedCondition: TYPED,
    });
  });

  it("parseFlow rejects a live legacy condition shadowing a typed condition", () => {
    // The defect this contract exists to prevent: typedCondition carries
    // semantic authority while `condition` still reads truthy, so a legacy
    // evaluator loops on semantics nobody authored.
    const result = parseFlow({ ...typedLoop, condition: "true" });

    expect(
      result.errors.some((e) => e.pointer?.endsWith("/condition")),
      JSON.stringify(result.errors)
    ).toBe(true);
  });

  it("flowNodeSchema rejects a live legacy condition shadowing a typed condition", () => {
    const result = flowNodeSchema.safeParse({
      ...typedLoop,
      condition: "true",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a malformed typedCondition rather than silently dropping it", () => {
    // Vacuity guard for the admission cases above: admission must be
    // SHAPE-CHECKED, not blanket. Implemented as an unchecked passthrough,
    // every admission case above would still pass.
    const malformed = {
      ...typedLoop,
      typedCondition: { schema: "nope", expression: { op: "bogus" } },
    };

    const parseResult = parseFlow(malformed);
    expect(
      parseResult.errors.some((e) => e.pointer?.endsWith("/typedCondition")),
      JSON.stringify(parseResult.errors)
    ).toBe(true);

    expect(flowNodeSchema.safeParse(malformed).success).toBe(false);
  });

  it("leaves a plain untyped loop untouched — the contract is opt-in", () => {
    // Negative control: proves the new rules are conditioned on
    // typedCondition being PRESENT, not applied blanket. A blanket
    // "condition must equal false" would break every existing loop, and
    // without this case the reject-cases above would pass just as well.
    const plain = { type: "loop", condition: "${running}", body };

    const parseResult = parseFlow(plain);
    expect(parseResult.errors, JSON.stringify(parseResult.errors)).toEqual([]);
    expect(parseResult.ast).toEqual(plain);

    const validateResult = flowNodeSchema.safeParse(plain);
    expect(validateResult.success).toBe(true);
    if (validateResult.success) {
      expect(validateResult.data).toMatchObject({ condition: "${running}" });
      expect(
        (validateResult.data as unknown as Record<string, unknown>)
          .typedCondition
      ).toBeUndefined();
    }
  });
});
