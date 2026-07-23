import type {
  FlowDocumentV1,
  ResolvedTool,
  ToolResolver,
} from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import {
  createFlowCompiler,
  createFlowReferenceAuthoringSnapshot,
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

describe("public compiler diagnostics", () => {
  it("promotes compatibility reference warnings with structured spans", async () => {
    const compiler = createFlowCompiler({ toolResolver: resolver });
    const result = await compiler.compileDocument({
      dsl: "dzupflow/v1",
      id: "compat_warning",
      version: 1,
      inputs: {
        goal: { type: "string", required: true },
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "action",
            id: "run",
            toolRef: "known.tool",
            input: {
              prompt: "Implement {{ inputs.missing }}",
            },
          },
        ],
      },
    });

    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected compatibility success");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        stage: 3,
        code: "INVALID_REFERENCE",
        nodePath: "root.nodes[0].input.prompt",
        message: expect.stringContaining("[MISSING_REFERENCE]"),
        span: expect.objectContaining({
          kind: "node-field-offsets",
          start: expect.any(Number),
          end: expect.any(Number),
        }),
      }),
    );

    expect(projectCompilationDiagnostics(result)).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        stage: 3,
        code: "INVALID_REFERENCE",
        nodePath: "root.nodes[0].input.prompt",
      }),
    );
  });

  it("preserves DSL parser line spans in editor projection", async () => {
    const compiler = createFlowCompiler({ toolResolver: resolver });
    const result = await compiler.compileDsl(
      "dsl: dzupflow/v1\n\tid: invalid\n",
    );

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected parse failure");
    expect(projectCompilationDiagnostics(result)[0]).toEqual(
      expect.objectContaining({
        severity: "error",
        stage: 1,
        span: {
          kind: "source-lines",
          lineStart: 2,
          columnStart: 1,
          lineEnd: 2,
          columnEnd: 1,
        },
      }),
    );
  });
});

describe("reference authoring snapshot", () => {
  it("generates typed binding and reviewed step-port completions", () => {
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "authoring",
      version: 1,
      inputs: {
        payload: {
          type: "object",
          required: true,
          classification: "sensitive",
        },
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "set",
            id: "prepare",
            assign: { ready: true },
          },
        ],
      },
    };

    const snapshot = createFlowReferenceAuthoringSnapshot(document, {
      referenceBindings: { context: ["tenantId"] },
      referenceTypeBindings: { context: { tenantId: "string" } },
      referencePortBindings: { prepare: { result: "object" } },
      referenceClassificationBindings: {
        context: { tenantId: "internal" },
      },
      referencePortClassificationBindings: {
        prepare: { result: "sensitive" },
      },
    });

    expect(snapshot.schema).toBe("dzupagent.flowReferenceAuthoring/v1");
    expect(snapshot.completions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "inputs.payload",
          valueType: "object",
          classification: "sensitive",
        }),
        expect.objectContaining({
          label: "state.ready",
          valueType: "boolean",
        }),
        expect.objectContaining({
          label: "context.tenantId",
          valueType: "string",
          classification: "internal",
        }),
        expect.objectContaining({
          kind: "step-port",
          label: "steps.prepare.result",
          valueType: "object",
          classification: "sensitive",
        }),
      ]),
    );
    expect(snapshot.classifications).toEqual(
      expect.objectContaining({
        inputs: { payload: "sensitive" },
        context: { tenantId: "internal" },
      }),
    );
    expect(
      snapshot.completions.some(
        (completion) => completion.label === "steps.prepare",
      ),
    ).toBe(false);
  });

  it("generates typed and classified ports from primitive definitions", () => {
    const snapshot = createFlowReferenceAuthoringSnapshot({
      type: "sequence",
      id: "root",
      nodes: [
        {
          type: "adapter.run",
          id: "provider",
          provider: "codex",
          instructions: "Summarize {{ inputs.payload }}",
          input: { payload: "{{ inputs.payload }}" },
          output: "providerResult",
        },
        {
          type: "evidence.write",
          id: "evidence",
          source: "providerResult",
          output: "receipt",
          redact: true,
        },
      ],
    }, {
      referenceBindings: { inputs: ["payload"] },
      referenceTypeBindings: { inputs: { payload: "object" } },
      referenceClassificationBindings: {
        inputs: { payload: "sensitive" },
      },
    });

    expect(snapshot.ports).toMatchObject({
      provider: { result: "unknown" },
      evidence: { receipt: "object" },
    });
    expect(snapshot.portClassifications).toMatchObject({
      provider: { result: "sensitive" },
      evidence: { receipt: "internal" },
    });
    expect(snapshot.completions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "steps.provider.result",
          valueType: "unknown",
          classification: "sensitive",
        }),
        expect.objectContaining({
          label: "steps.evidence.receipt",
          valueType: "object",
          classification: "internal",
        }),
      ]),
    );
  });

  it("projects credential inputs as opaque secret handles", () => {
    const snapshot = createFlowReferenceAuthoringSnapshot({
      dsl: "dzupflow/v1",
      id: "credential_authoring",
      version: 1,
      inputs: {
        providerCredential: {
          type: "credential",
          required: true,
        },
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "set",
            id: "copy_credential",
            assign: {
              copiedCredential: "{{ inputs.providerCredential }}",
            },
          },
        ],
      },
    });

    expect(snapshot.completions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "inputs.providerCredential",
          valueType: "credential",
          classification: "secret",
        }),
        expect.objectContaining({
          label: "state.copiedCredential",
          valueType: "credential",
          classification: "secret",
        }),
      ]),
    );

    const conflicting = createFlowReferenceAuthoringSnapshot({
      dsl: "dzupflow/v1",
      id: "credential_authoring_conflict",
      version: 1,
      inputs: {
        providerCredential: {
          type: "credential",
          required: true,
        },
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "set",
            assign: {
              copiedCredential: "{{ inputs.providerCredential }}",
            },
          },
          {
            type: "set",
            assign: {
              copiedCredential: "raw-value",
            },
          },
        ],
      },
    });
    expect(conflicting.types.state?.copiedCredential).not.toBe("credential");
  });
});
