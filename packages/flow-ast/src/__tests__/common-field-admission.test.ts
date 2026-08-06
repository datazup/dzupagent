/**
 * Fail-closed coverage for the shared common-field admission rule (F-R1).
 *
 * `admitCommonField` is the ONE place the admitted value set for the
 * execution-contract fields lives; parse (`parseCommonNodeFields`), validate
 * (`validateCommonNodeFields`) and flow-dsl normalize all delegate to it.
 *
 * WHY THIS FILE EXISTS: before it, disabling enum admission entirely — making
 * `admitCommonField` return `admitted` for ANY value — left all 606 flow-ast,
 * 786 flow-dsl and 775 flow-compiler tests green. flow-dsl had fail-closed
 * tests for the NORMALIZE path only, so the parse and validate stages had no
 * coverage of rejection at all: a regression in the shared rule was invisible
 * to 2,167 tests. Each rejection case below is paired with an ACCEPTING
 * control on the same field, so the assertions cannot pass by rejecting
 * everything.
 */
import { describe, it, expect } from "vitest";

import {
  EFFECT_CLASSES,
  FLOW_EXECUTION_CONTRACT_FIELDS,
  NODE_IDEMPOTENCY_MODES,
  admitCommonField,
  commonFieldSpec,
} from "../types.js";
import { parseFlow } from "../parse.js";
import { validateFlowNodeShape } from "../validate.js";

/**
 * A minimal OTHERWISE-VALID node to hang common fields off.
 *
 * It must be valid on every other axis: an empty `sequence.nodes` trips
 * EMPTY_BODY, which would make the accepting controls below fail for a reason
 * unrelated to field admission — and make the rejection cases pass
 * vacuously, since they only look for an issue mentioning the field.
 */
function nodeWith(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "sequence",
    nodes: [{ type: "action", toolRef: "skill:noop", input: {} }],
    ...fields,
  };
}

/**
 * One rejection case per registered execution-contract field, each with a
 * VALID counterpart on the same field. Derived from the registry so a newly
 * registered field shows up here as an unhandled case rather than silently
 * going untested.
 */
const CASES: Array<{
  field: string;
  valid: unknown;
  invalid: unknown;
}> = [
  { field: "effectClass", valid: EFFECT_CLASSES[0], invalid: "not-a-class" },
  {
    field: "idempotency",
    valid: NODE_IDEMPOTENCY_MODES[0],
    invalid: "not-a-mode",
  },
  { field: "resumePoint", valid: true, invalid: "yes" },
];

describe("admitCommonField is the single admission rule", () => {
  it("covers every registered execution-contract field", () => {
    // If a field joins the registry without a case above, this fails rather
    // than leaving the new field's rejection path unexercised.
    expect(CASES.map((c) => c.field).sort()).toEqual(
      FLOW_EXECUTION_CONTRACT_FIELDS.map((s) => s.field).sort(),
    );
  });

  it.each(CASES)("admits a valid $field and rejects an invalid one", (c) => {
    const spec = commonFieldSpec(c.field);
    expect(spec).toBeDefined();
    // Accepting control and rejecting case differ in ONE dimension: the value.
    expect(admitCommonField(spec!, c.valid)).toEqual({
      outcome: "admitted",
      value: c.valid,
    });
    expect(admitCommonField(spec!, c.invalid).outcome).toBe("invalid");
  });

  it("reports an absent field as absent, never as admitted-undefined", () => {
    // Writing `undefined` onto the typed position would make the key `in` the
    // node and change canonical output — distinct from a rejection.
    const spec = commonFieldSpec("effectClass");
    expect(admitCommonField(spec!, undefined)).toEqual({ outcome: "absent" });
  });
});

describe("parse fails closed on an invalid execution-contract value", () => {
  it.each(CASES)("rejects an invalid $field", (c) => {
    const bad = parseFlow(nodeWith({ [c.field]: c.invalid }));
    expect(bad.errors.some((e) => e.pointer.includes(c.field))).toBe(true);
  });

  it.each(CASES)("accepts a valid $field (accepting control)", (c) => {
    // Holds every other dimension identical; only the value differs from the
    // rejection case above, so a blanket-reject implementation fails here.
    const good = parseFlow(nodeWith({ [c.field]: c.valid }));
    expect(good.errors).toEqual([]);
    expect((good.ast as never)[c.field]).toEqual(c.valid);
  });
});

describe("validate fails closed on an invalid execution-contract value", () => {
  // resumePoint is validated by the generic boolean helper rather than the
  // registry-backed enum path; the two enum fields are the shared rule's.
  const enumCases = CASES.filter((c) => c.field !== "resumePoint");

  it.each(enumCases)("rejects an invalid $field", (c) => {
    const errors = validateFlowNodeShape(nodeWith({ [c.field]: c.invalid }));
    // `nodePath` is the node's path, not the field's, so it alone cannot say
    // WHICH field was rejected — the message carries that.
    expect(
      errors.some(
        (e) => e.nodePath.includes(c.field) || e.message.includes(c.field)
      )
    ).toBe(true);
  });

  it.each(enumCases)("accepts a valid $field (accepting control)", (c) => {
    expect(validateFlowNodeShape(nodeWith({ [c.field]: c.valid }))).toEqual([]);
  });
});
