/**
 * F-R1 agent `template` / `validate` codec closure. Both fields were
 * TYPE-ONLY on the authoring side: `AgentNode.template` and
 * `AgentNode.validate` existed in `@dzupagent/flow-ast`'s types (and the
 * validator handled `template`), but flow-dsl's normalizer rejected them as
 * UNSUPPORTED_FIELD and the formatter never emitted them — so an authored
 * template ref or inline validation block was silently lost on every
 * format→parse round-trip. flow-ast's parser also hard-required
 * `instructions`, contradicting the validator's template-ref relaxation.
 *
 * The DSL-06 matrix (`field-reachability-matrix.test.ts`) proves the MINIMAL
 * fixture round-trips, but its fixtures deliberately omit every optional
 * field — so optional-field loss is invisible there. This spec covers exactly
 * that gap, following `spdd-roundtrip.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { FlowDocumentV1, FlowNode } from "@dzupagent/flow-ast";

import { formatDocumentToDslChecked } from "../src/format-dsl.js";
import { normalizeDslDocument } from "../src/normalize.js";

function docWith(nodes: FlowNode[]): FlowDocumentV1 {
  return {
    dsl: "dzupflow/v1",
    id: "agent-template-fixture",
    version: 1,
    root: { type: "sequence", id: "root", nodes },
  } as FlowDocumentV1;
}

function expectLossless(document: FlowDocumentV1): string {
  const result = formatDocumentToDslChecked(document);
  if (!result.ok) {
    throw new Error(
      `agent codec lost authored fields: ${result.lossPaths.join(
        ", "
      )}\n--- dsl ---\n${result.dsl}`
    );
  }
  return result.dsl;
}

const VALID_OUTPUT = { key: "o", schema: { type: "object" } };

describe("agent template/validate optional-field round-trips", () => {
  it("round-trips template.ref and template.inputDefaults", () => {
    const dsl = expectLossless(
      docWith([
        {
          type: "agent",
          id: "a0",
          agentId: "ag-1",
          instructions: "do the thing",
          template: { ref: "tpl-1", inputDefaults: { topic: "codec" } },
          output: VALID_OUTPUT,
        } as FlowNode,
      ])
    );
    expect(dsl).toContain("ref: tpl-1");
    expect(dsl).toContain("topic: codec");
  });

  it("round-trips the validate block (schema, errorMessage, failBehavior, maxRetries)", () => {
    const dsl = expectLossless(
      docWith([
        {
          type: "agent",
          id: "a0",
          agentId: "ag-1",
          instructions: "do the thing",
          validate: {
            schema: { type: "object" },
            errorMessage: "shape mismatch",
            failBehavior: "retry",
            maxRetries: 2,
          },
          output: VALID_OUTPUT,
        } as FlowNode,
      ])
    );
    expect(dsl).toContain("failBehavior: retry");
    expect(dsl).toContain("maxRetries: 2");
    expect(dsl).toContain("shape mismatch");
  });

  it("round-trips template-ref mode with the empty-instructions sentinel", () => {
    // The synthesis pass fills instructions later; the codec must not reject
    // or fabricate them. Mirrors flow-ast's validate/agent.ts relaxation.
    const dsl = expectLossless(
      docWith([
        {
          type: "agent",
          id: "a0",
          agentId: "ag-1",
          instructions: "",
          template: { ref: "tpl-1" },
          output: VALID_OUTPUT,
        } as FlowNode,
      ])
    );
    expect(dsl).toContain("ref: tpl-1");
    expect(dsl).not.toContain("instructions:");
  });
});

describe("agent template/validate normalizer fails closed", () => {
  function normalize(agentNode: Record<string, unknown>) {
    return normalizeDslDocument({
      dsl: "dzupflow/v1",
      id: "agent-template-fixture",
      version: 1,
      steps: [{ agent: agentNode }],
    });
  }

  const VALID_AGENT = {
    id: "a0",
    agentId: "ag-1",
    instructions: "do the thing",
    output: { key: "o", schema: { type: "object" } },
  };

  it("admits a well-formed template and validate block with zero diagnostics", () => {
    // NOTE: on the SUCCESS path the node lives under `document`;
    // `partialDocument` is null and is only populated when normalization
    // partially fails (see `normalize.ts`). Reading `partialDocument` here
    // would make this positive control assert against `undefined` and fail
    // even though both fields normalize correctly.
    const { diagnostics, document } = normalize({
      ...VALID_AGENT,
      template: { ref: "tpl-1", inputDefaults: { a: 1 } },
      validate: { schema: { type: "object" }, failBehavior: "abort" },
    });
    expect(diagnostics).toEqual([]);
    const node = document?.root.nodes[0] as
      | Record<string, unknown>
      | undefined;
    expect(node?.template).toEqual({
      ref: "tpl-1",
      inputDefaults: { a: 1 },
    });
    expect(node?.validate).toEqual({
      schema: { type: "object" },
      failBehavior: "abort",
    });
  });

  it("accepts template-ref mode without instructions (synthesis fills them)", () => {
    const { instructions: _omit, ...base } = VALID_AGENT;
    const { diagnostics } = normalize({
      ...base,
      template: { ref: "tpl-1" },
    });
    expect(diagnostics).toEqual([]);
  });

  it("still requires instructions when template is absent (relaxation is not blanket)", () => {
    const { instructions: _omit, ...base } = VALID_AGENT;
    const { diagnostics } = normalize(base);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" &&
          d.path.includes("instructions")
      ),
      diagnostics.map((d) => `${d.code} ${d.path}`).join(" | ")
    ).toBe(true);
  });

  it("rejects a template missing its ref and drops it rather than admitting it", () => {
    const { diagnostics, partialDocument } = normalize({
      ...VALID_AGENT,
      template: { inputDefaults: { a: 1 } },
    });
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" &&
          d.path.includes("template.ref")
      ),
      diagnostics.map((d) => `${d.code} ${d.path}`).join(" | ")
    ).toBe(true);
    const node = partialDocument?.root.nodes[0] as
      | Record<string, unknown>
      | undefined;
    expect(node?.template).toBeUndefined();
  });

  it("rejects a validate block missing its schema and drops it", () => {
    const { diagnostics, partialDocument } = normalize({
      ...VALID_AGENT,
      validate: { failBehavior: "retry" },
    });
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" &&
          d.path.includes("validate.schema")
      ),
      diagnostics.map((d) => `${d.code} ${d.path}`).join(" | ")
    ).toBe(true);
    const node = partialDocument?.root.nodes[0] as
      | Record<string, unknown>
      | undefined;
    expect(node?.validate).toBeUndefined();
  });

  it("rejects an out-of-enum failBehavior without dropping the whole block", () => {
    const { diagnostics, partialDocument } = normalize({
      ...VALID_AGENT,
      validate: { schema: { type: "object" }, failBehavior: "explode" },
    });
    expect(
      diagnostics.some(
        (d) =>
          d.code === "INVALID_NODE_SHAPE" &&
          d.path.includes("validate.failBehavior")
      ),
      diagnostics.map((d) => `${d.code} ${d.path}`).join(" | ")
    ).toBe(true);
    // The block itself survives with the bad field dropped, not admitted.
    const node = partialDocument?.root.nodes[0] as
      | { validate?: Record<string, unknown> }
      | undefined;
    expect(node?.validate?.failBehavior).toBeUndefined();
  });
});
