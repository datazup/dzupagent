import type { ResolvedTool, ToolResolver } from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";

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

describe("strict reference migration report", () => {
  it("classifies ready, reference-change, and invalid corpus entries", async () => {
    const compiler = createFlowCompiler({ toolResolver: resolver });
    const report = await compiler.analyzeStrictReferenceMigration([
      {
        id: "ready",
        kind: "document",
        input: {
          dsl: "dzupflow/v1",
          id: "ready",
          version: 1,
          inputs: { goal: { type: "string", required: true } },
          root: {
            type: "sequence",
            id: "root",
            nodes: [
              {
                type: "action",
                id: "run",
                toolRef: "known.tool",
                input: { prompt: "{{ inputs.goal }}" },
              },
            ],
          },
        },
      },
      {
        id: "needs-change",
        kind: "document",
        input: {
          dsl: "dzupflow/v1",
          id: "needs_change",
          version: 1,
          inputs: { goal: { type: "string", required: true } },
          root: {
            type: "sequence",
            id: "root",
            nodes: [
              {
                type: "action",
                id: "run",
                toolRef: "known.tool",
                input: { prompt: "{{ inputs.missing }}" },
              },
            ],
          },
        },
      },
      {
        id: "invalid",
        kind: "dsl",
        input: "dsl: dzupflow/v1\n\tid: invalid\n",
      },
      {
        id: "condition-change",
        kind: "document",
        input: {
          dsl: "dzupflow/v1",
          id: "condition_change",
          version: 1,
          inputs: { goal: { type: "string", required: true } },
          root: {
            type: "sequence",
            id: "root",
            nodes: [
              {
                type: "branch",
                id: "gate",
                condition: "inputs.missing === true",
                then: [
                  {
                    type: "wait",
                    id: "pause",
                    durationMs: 1,
                  },
                ],
              },
            ],
          },
        },
      },
    ]);

    expect(report.schema).toBe("dzupagent.strictReferenceMigration/v1");
    expect(report.summary).toEqual({
      total: 4,
      ready: 1,
      changesRequired: 2,
      invalid: 1,
      diagnosticsByCode: { MISSING_REFERENCE: 2 },
      compilerDiagnosticsByCode: {
        INVALID_CONDITION: 1,
        INVALID_REFERENCE: 1,
        INVALID_YAML_SUBSET: 1,
      },
    });
    expect(report.items.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "ready", status: "ready" },
      { id: "needs-change", status: "changes-required" },
      { id: "invalid", status: "invalid" },
      { id: "condition-change", status: "changes-required" },
    ]);
    expect(report.items[1]?.compatibilityWarnings).toContainEqual(
      expect.objectContaining({
        stage: 3,
        code: "INVALID_REFERENCE",
        message: expect.stringContaining("[MISSING_REFERENCE]"),
      }),
    );
    expect(report.items[1]?.blockingReferenceCodes).toEqual([
      "MISSING_REFERENCE",
    ]);
    expect(report.items[1]?.strictDiagnostics[0]?.span).toEqual(
      expect.objectContaining({
        kind: "node-field-offsets",
        start: expect.any(Number),
        end: expect.any(Number),
      }),
    );
    expect(report.items[3]?.blockingReferenceCodes).toEqual([
      "MISSING_REFERENCE",
    ]);
    expect(report.items[3]?.strictDiagnostics[0]?.span).toEqual(
      expect.objectContaining({
        kind: "node-field-offsets",
        start: 0,
        end: expect.any(Number),
      }),
    );
  });
});
