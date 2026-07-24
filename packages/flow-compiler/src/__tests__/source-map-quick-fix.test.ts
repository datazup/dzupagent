import type { ResolvedTool, ToolResolver } from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import {
  applyFlowDiagnosticQuickFix,
  createFlowCompiler,
  projectCompilationDiagnostics,
} from "../index.js";

const TOOL: ResolvedTool = {
  ref: "known.tool",
  kind: "skill",
  inputSchema: { type: "object" },
  handle: {
    name: "known.tool",
    description: "known test tool",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    permissionLevel: "read",
    sideEffects: [],
    namespace: "known",
  },
};

const resolver: ToolResolver = {
  resolve: (ref) => (ref === TOOL.ref ? TOOL : null),
  listAvailable: () => [TOOL.ref],
};

describe("absolute semantic source mapping and safe quick fixes", () => {
  it("projects normalization diagnostics onto absolute authored fields", async () => {
    const source = `dsl: dzupflow/v1
id: graph_shape
version: 1
nodes: []
steps: []
`;
    const result = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDsl(source);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected normalization failure");
    const diagnostic = result.errors.find(
      (item) => item.nodePath === "root.nodes",
    );
    expect(diagnostic?.span).toEqual(
      expect.objectContaining({
        kind: "source-offsets",
        lineStart: 4,
        lineEnd: 4,
      }),
    );
  });

  it("maps a strict reference root to raw YAML and applies a guarded fix", async () => {
    const source = `dsl: dzupflow/v1
id: safe_fix
version: 1
inputs:
  goal: string
steps:
  - action:
      id: run
      ref: known.tool
      input:
        prompt: "Implement {{ input.goal }}"
`;
    const compiler = createFlowCompiler({
      toolResolver: resolver,
      referencePolicy: "strict",
    });
    const result = await compiler.compileDsl(source);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected strict failure");

    const diagnostic = result.errors.find((item) =>
      item.message.includes("[DISALLOWED_REFERENCE_ROOT]"),
    );
    expect(diagnostic).toEqual(
      expect.objectContaining({
        nodePath: "root.nodes[0].input.prompt",
        span: expect.objectContaining({
          kind: "source-offsets",
          start: expect.any(Number),
          end: expect.any(Number),
          lineStart: 11,
          lineEnd: 11,
        }),
        fixes: [
          expect.objectContaining({
            id: "canonical-reference-root",
            applicability: "safe",
            sourceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          }),
        ],
      }),
    );
    if (diagnostic?.span?.kind !== "source-offsets") {
      throw new Error("expected absolute source span");
    }
    expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toBe(
      "input",
    );
    const fix = diagnostic.fixes?.[0];
    if (fix === undefined) throw new Error("expected safe fix");
    const applied = applyFlowDiagnosticQuickFix(source, fix);
    expect(applied).toEqual(
      expect.objectContaining({ ok: true, source: expect.stringContaining("{{ inputs.goal }}") }),
    );
    if (!applied.ok) throw new Error(applied.reason);
    expect("errors" in await compiler.compileDsl(applied.source)).toBe(false);

    expect(applyFlowDiagnosticQuickFix(`${source}\n`, fix)).toEqual({
      ok: false,
      reason: "source digest changed after the diagnostic was produced",
    });
  });

  it("maps nested branch diagnostics but does not invent a dominance edit", async () => {
    const source = `dsl: dzupflow/v1
id: branch_map
version: 1
inputs:
  flag:
    type: boolean
    required: true
steps:
  - if:
      id: choose
      condition: inputs.flag == true
      then:
        - set:
            id: prepare
            assign:
              ready: true
      else:
        - complete:
            id: skipped
            result: skipped
  - action:
      id: consume
      ref: known.tool
      input:
        prompt: "Ready {{ state.ready }}"
`;
    const result = await createFlowCompiler({
      toolResolver: resolver,
      referencePolicy: "strict",
    }).compileDsl(source);
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected dominance failure");
    const diagnostic = result.errors.find((item) =>
      item.message.includes("[REFERENCE_NOT_AVAILABLE]"),
    );
    expect(diagnostic).toEqual(
      expect.objectContaining({
        nodePath: "root.nodes[1].input.prompt",
        span: expect.objectContaining({
          kind: "source-offsets",
          lineStart: 25,
          lineEnd: 25,
        }),
      }),
    );
    expect(diagnostic?.fixes).toBeUndefined();
  });

  it("preserves absolute spans and fixes in editor projection", async () => {
    const source = `dsl: dzupflow/v1
id: editor_fix
version: 1
inputs:
  goal: string
steps:
  - action:
      id: run
      ref: known.tool
      input: { "prompt": "Implement {{ input.goal }}" }
`;
    const result = await createFlowCompiler({
      toolResolver: resolver,
      referencePolicy: "strict",
    }).compileDsl(source);
    const projected = projectCompilationDiagnostics(result);
    expect(projected).toContainEqual(
      expect.objectContaining({
        severity: "error",
        span: expect.objectContaining({ kind: "source-offsets" }),
        fixes: [expect.objectContaining({ applicability: "safe" })],
      }),
    );
  });
});
