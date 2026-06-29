import { describe, expect, it } from "vitest";

import {
  expandCollabMacros,
  CollabMacroError,
} from "../expand-collab-macros.js";
import { parseDslToDocument } from "../parse-dsl.js";

const validMacro = () => ({
  steps: [
    {
      "collab.review_loop": {
        id: "impl",
        task: { kind: "code", risk: "medium" },
        proposer: { executionProviderId: "codex" },
        critic: { executionProviderId: "claude" },
        gates: { commands: [{ command: "yarn typecheck" }] },
        reconcile: { mode: "tiered", maxRevise: 2 },
      },
    },
  ],
});

function stepTypes(raw: { steps: Array<Record<string, unknown>> }): string[] {
  return raw.steps.map((n) => Object.keys(n)[0]!);
}

describe("expandCollabMacros (MPCO P5)", () => {
  it("T5a: replaces collab.review_loop with canonical wrappers only", () => {
    const out = expandCollabMacros(validMacro()) as {
      steps: Array<Record<string, unknown>>;
    };
    const types = stepTypes(out);
    expect(types).not.toContain("collab.review_loop");
    expect(
      types.every((t) =>
        [
          "adapter.run",
          "validate",
          "if",
          "sequence",
          "approval",
          "complete",
        ].includes(t)
      )
    ).toBe(true);
  });

  it("T5b: emits no forbidden nodes (prompt/return_to/loop/for_each)", () => {
    const out = expandCollabMacros(validMacro()) as {
      steps: Array<Record<string, unknown>>;
    };
    const forbidden = ["prompt", "return_to", "loop", "for_each"];
    for (const f of forbidden) {
      expect(stepTypes(out)).not.toContain(f);
    }
    // Forbidden keys must not appear as nested wrapper keys anywhere either.
    const flat = JSON.stringify(out);
    for (const f of forbidden) {
      expect(flat).not.toContain(`"${f}":`);
    }
  });

  it("T5c: tags expanded nodes with meta.collabExpansion provenance", () => {
    const out = expandCollabMacros(validMacro()) as {
      steps: Array<Record<string, { meta?: { collabExpansion?: string } }>>;
    };
    const adapter = out.steps.find((n) => n["adapter.run"]);
    expect(adapter?.["adapter.run"]?.meta?.collabExpansion).toBe("impl");
  });

  it("T6: rejects malformed macro input (missing proposer) before expansion", () => {
    const bad = {
      steps: [
        {
          "collab.review_loop": {
            id: "x",
            critic: { executionProviderId: "claude" },
          },
        },
      ],
    };
    expect(() => expandCollabMacros(bad)).toThrow(CollabMacroError);
  });

  it("passes through non-macro documents unchanged (steps form)", () => {
    const doc = { steps: [{ action: { id: "a", ref: "tool.noop" } }] };
    expect(expandCollabMacros(doc)).toEqual(doc);
  });

  it("passes through non-macro documents unchanged (nodes form)", () => {
    const doc = { nodes: [{ action: { id: "a", ref: "tool.noop" } }] };
    expect(expandCollabMacros(doc)).toEqual(doc);
  });

  it("does not mutate the input document", () => {
    const input = validMacro();
    const snapshot = JSON.stringify(input);
    expandCollabMacros(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("T7: a document with collab.review_loop parses to a valid document (no validator errors)", () => {
    // NOTE: the dzupflow mini-yaml subset is block-style only (no inline
    // `{ ... }` maps or `[{...}]` arrays of maps), so the macro body is
    // authored in block form.
    const source = [
      "dsl: dzupflow/v1alpha-agent",
      "id: collab-review-flow",
      "version: 1",
      "steps:",
      "  - collab.review_loop:",
      "      id: impl",
      "      task:",
      "        kind: code",
      "        risk: medium",
      "      proposer:",
      "        executionProviderId: codex",
      "      critic:",
      "        executionProviderId: claude",
      "      gates:",
      "        commands:",
      "          - command: yarn typecheck",
      "      reconcile:",
      "        mode: tiered",
      "        maxRevise: 2",
    ].join("\n");
    const result = parseDslToDocument(source);
    const errors = (result.diagnostics ?? []).filter(
      (d) => d.phase === "validate" || d.phase === "normalize"
    );
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});
