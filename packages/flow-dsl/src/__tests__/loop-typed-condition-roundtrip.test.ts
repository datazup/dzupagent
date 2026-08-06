/**
 * F-R4 — DSL codec surface for `loop.typedCondition`.
 *
 * The flow-ast boundaries (parse/validate) admit a typed condition on `loop`
 * under the branch fail-closed contract (loop-typed-condition.test.ts in
 * flow-ast). This file pins the OTHER two hand-written surfaces that can
 * silently drop or bypass it — the DSL normalizer and the canonical
 * formatter. Both are exactly where `loop.progressKey` was lost before the
 * registry migration exposed it, so each rule is pinned here independently.
 *
 * Anti-vacuity design: the accepting fixture (`typedLoop`) round-trips with
 * ZERO diagnostics; every rejecting case varies exactly ONE dimension of that
 * accepting fixture, so a blanket-reject (or blanket-accept) implementation
 * fails at least one case.
 */
import { describe, expect, it } from "vitest";

import { FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW } from "@dzupagent/flow-ast/expressions";
import type { FlowTypedCondition } from "@dzupagent/flow-ast/expressions";
import type { FlowDocumentV1, FlowNode, LoopNode } from "@dzupagent/flow-ast";

import { canonicalizeDsl } from "../canonicalize-dsl.js";
import { formatDocumentToDsl } from "../format-dsl.js";
import { normalizeDslDocument } from "../normalize.js";

const TYPED: FlowTypedCondition = {
  schema: "dzupagent.flowTypedCondition/v1",
  expression: {
    op: "eq",
    left: { op: "ref", path: "status" },
    right: { op: "literal", value: "pending" },
  },
};

const typedLoop: LoopNode = {
  type: "loop",
  id: "poll",
  condition: FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
  typedCondition: TYPED,
  maxIterations: 5,
  body: [{ type: "complete", id: "done" }],
};

function wrap(node: FlowNode): FlowDocumentV1 {
  return {
    dsl: "dzupflow/v1",
    id: "loop-flow",
    version: 1,
    root: { type: "sequence", id: "root", nodes: [node] },
  };
}

function normalizeRaw(rawLoop: Record<string, unknown>) {
  return normalizeDslDocument({
    dsl: "dzupflow/v1",
    id: "loop-flow",
    version: 1,
    steps: [{ loop: rawLoop }],
  });
}

const RAW_TYPED_LOOP: Record<string, unknown> = {
  id: "poll",
  condition: FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
  typedCondition: TYPED,
  maxIterations: 5,
  body: [{ complete: { id: "done" } }],
};

describe("F-R4 — loop.typedCondition DSL codec", () => {
  it("format -> canonicalize round-trips the typed loop losslessly", () => {
    const yaml = formatDocumentToDsl(wrap(typedLoop));
    const result = canonicalizeDsl(yaml);

    expect(result.diagnostics, JSON.stringify(result.diagnostics)).toEqual([]);
    expect(result.ok).toBe(true);
    // Exact equality: a formatter that drops typedCondition (the pre-F-R4
    // loop case) or a normalizer that strips it fails here, not a truthiness
    // check.
    expect(result.document?.root.nodes[0]).toEqual(typedLoop);
  });

  it("normalizer admits the typed loop with zero diagnostics (accepting control)", () => {
    const result = normalizeRaw(RAW_TYPED_LOOP);

    expect(result.diagnostics, JSON.stringify(result.diagnostics)).toEqual([]);
    const node = result.document?.root.nodes[0] as LoopNode;
    expect(node.typedCondition).toEqual(TYPED);
    expect(node.condition).toBe(FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW);
  });

  it("normalizer rejects a malformed typedCondition instead of dropping it", () => {
    const result = normalizeRaw({
      ...RAW_TYPED_LOOP,
      typedCondition: { schema: "nope", expression: { op: "bogus" } },
    });

    expect(
      result.diagnostics.some((d) => d.path?.endsWith(".typedCondition")),
      JSON.stringify(result.diagnostics)
    ).toBe(true);
  });

  it("normalizer rejects a live legacy condition shadowing a typed condition", () => {
    const result = normalizeRaw({ ...RAW_TYPED_LOOP, condition: "true" });

    expect(
      result.diagnostics.some((d) => d.path?.endsWith(".condition")),
      JSON.stringify(result.diagnostics)
    ).toBe(true);
  });

  it("leaves a plain untyped loop untouched — the contract is opt-in", () => {
    const plain: LoopNode = {
      type: "loop",
      id: "poll",
      condition: "${running}",
      body: [{ type: "complete", id: "done" }],
    };

    const yaml = formatDocumentToDsl(wrap(plain));
    const result = canonicalizeDsl(yaml);

    expect(result.diagnostics, JSON.stringify(result.diagnostics)).toEqual([]);
    expect(result.document?.root.nodes[0]).toEqual(plain);
  });
});
