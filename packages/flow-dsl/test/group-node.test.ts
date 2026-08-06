/**
 * group-node.test.ts — the `group:` authoring surface for a nested sequence.
 *
 * Before this slice the DSL had NO keyword for a nested `sequence`: flow-ast
 * parsed one and the compiler lowered one, but `normalize-node-helpers.ts`
 * dispatched every structural kind except that one. With no authorable form,
 * the formatter could only splice a nested sequence's children into the
 * parent list — losing `type`, `id` and `nodes` on every round trip (the
 * DSL-06 matrix pinned this as `KNOWN_LOSSY_KINDS.sequence`).
 *
 * `group:` closes that hole. Each test varies ONE dimension against an
 * otherwise-valid document so a failure cannot pass for the wrong reason.
 */
import { describe, expect, it } from "vitest";
import type { FlowDocumentV1, FlowNode, SequenceNode } from "@dzupagent/flow-ast";

import { formatDocumentToDslChecked } from "../src/format-dsl.js";
import { normalizeDslDocument } from "../src/index.js";

function docWith(node: FlowNode): FlowDocumentV1 {
  return {
    dsl: "dzupflow/v1",
    id: "group-fixture",
    version: 1,
    root: { type: "sequence", id: "root", nodes: [node] },
  } as FlowDocumentV1;
}

const NESTED_GROUP: FlowNode = {
  type: "sequence",
  id: "preflight",
  nodes: [{ type: "complete", id: "inner-done" }],
} as FlowNode;

describe("group: authoring surface (nested sequence)", () => {
  it("emits a `group:` block for a nested sequence instead of splicing its children", () => {
    const result = formatDocumentToDslChecked(docWith(NESTED_GROUP));

    expect(result.ok).toBe(true);
    expect(result.dsl).toContain("- group:");
    expect(result.dsl).toContain("id: preflight");
  });

  it("round-trips a nested sequence losslessly (the DSL-06 loss this slice closes)", () => {
    const result = formatDocumentToDslChecked(docWith(NESTED_GROUP));

    expect(result.ok).toBe(true);
    // ok:false would carry the exact lost paths; assert on them so a
    // regression names the field rather than just flipping a boolean.
    expect((result as { lossPaths?: string[] }).lossPaths ?? []).toEqual([]);
  });

  it("normalizes an authored `group:` into a sequence node preserving id and children", () => {
    const result = normalizeDslDocument({
      dsl: "dzupflow/v1",
      id: "authored",
      version: 1,
      steps: [
        {
          group: {
            id: "preflight",
            steps: [{ complete: { id: "inner-done" } }],
          },
        },
      ],
    });

    const root = result.document?.root as SequenceNode | undefined;
    const child = root?.nodes?.[0] as SequenceNode | undefined;
    expect(child?.type).toBe("sequence");
    expect(child?.id).toBe("preflight");
    expect(child?.nodes).toHaveLength(1);
    expect(child?.nodes?.[0]?.type).toBe("complete");
  });

  it("rejects a group with no steps (fail-closed, one dimension off an accepting control)", () => {
    const { diagnostics } = normalizeDslDocument({
      dsl: "dzupflow/v1",
      id: "authored",
      version: 1,
      steps: [{ group: { id: "preflight", steps: [] } }],
    });

    // Assert the CODE, not a bare truthiness of the diagnostics array.
    expect(diagnostics.map((d) => d.code)).toContain("EMPTY_BRANCH_BODY");
  });

  it("accepts the same group once it has one step (the control for the rejection above)", () => {
    const { diagnostics } = normalizeDslDocument({
      dsl: "dzupflow/v1",
      id: "authored",
      version: 1,
      steps: [
        { group: { id: "preflight", steps: [{ complete: { id: "d" } }] } },
      ],
    });

    expect(diagnostics.map((d) => d.code)).not.toContain("EMPTY_BRANCH_BODY");
  });

  it("reports an unsupported field inside a group rather than silently dropping it", () => {
    const { diagnostics } = normalizeDslDocument({
      dsl: "dzupflow/v1",
      id: "authored",
      version: 1,
      steps: [
        {
          group: {
            id: "preflight",
            steps: [{ complete: { id: "d" } }],
            nonsense: true,
          },
        },
      ],
    });

    expect(diagnostics.map((d) => d.code)).toContain("UNSUPPORTED_FIELD");
  });
});
