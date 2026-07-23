import type {
  FlowNode,
  ResolvedTool,
  ToolResolver,
} from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import {
  createFlowCompiler,
  semanticResolve,
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

describe("classified flow policy", () => {
  it("warns in compatibility mode and rejects the same sensitive tool flow in strict mode", async () => {
    const document = {
      dsl: "dzupflow/v1",
      id: "classified_tool_input",
      version: 1,
      inputs: {
        customerRecord: {
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
            type: "action",
            id: "send",
            toolRef: "known.tool",
            input: {
              record: "{{ inputs.customerRecord }}",
            },
          },
        ],
      },
    };

    const compat = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDocument(document);
    const strict = await createFlowCompiler({
      toolResolver: resolver,
      referencePolicy: "strict",
    }).compileDocument(document);

    expect("errors" in compat).toBe(false);
    if ("errors" in compat) throw new Error("expected compatibility success");
    expect(compat.warnings).toContainEqual(
      expect.objectContaining({
        code: "UNSAFE_DATA_FLOW",
        nodePath: "root.nodes[0].input.record",
        message: expect.stringContaining("[SENSITIVE_TO_TOOL_INPUT]"),
      }),
    );

    expect("errors" in strict).toBe(true);
    if (!("errors" in strict)) throw new Error("expected strict failure");
    expect(strict.errors).toContainEqual(
      expect.objectContaining({
        stage: 3,
        code: "UNSAFE_DATA_FLOW",
        category: "policy",
        nodePath: "root.nodes[0].input.record",
      }),
    );
  });

  it("propagates secrets through state before checking a later provider prompt", async () => {
    const compiler = createFlowCompiler({
      toolResolver: resolver,
      referencePolicy: "strict",
      referenceBindings: { secrets: ["apiKey"] },
    });
    const result = await compiler.compile({
      type: "sequence",
      id: "root",
      nodes: [
        {
          type: "set",
          id: "copy_secret",
          assign: { copiedKey: "{{ secrets.apiKey }}" },
        },
        {
          type: "prompt",
          id: "leak",
          userPrompt: "Use {{ state.copiedKey }}",
          outputKey: "answer",
        },
      ],
    });

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected strict failure");
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "UNSAFE_DATA_FLOW",
        nodePath: "root.nodes[1].userPrompt",
        message: expect.stringContaining("[SECRET_TO_PROVIDER_PROMPT]"),
      }),
    );
  });

  it("requires evidence redaction for a secret bare reference", async () => {
    const unredacted: FlowNode = {
      type: "evidence.write",
      id: "write_raw",
      source: "secretResult",
      output: "evidenceRef",
    };
    const redacted: FlowNode = {
      ...unredacted,
      id: "write_redacted",
      redact: true,
    };
    const options = {
      toolResolver: resolver,
      referencePolicy: "strict" as const,
      referenceBindings: { state: ["secretResult"] },
      referenceClassificationBindings: {
        state: { secretResult: "secret" as const },
      },
    };

    const rawResult = await semanticResolve(unredacted, options);
    const redactedResult = await semanticResolve(redacted, options);

    expect(rawResult.errors).toContainEqual(
      expect.objectContaining({
        code: "UNSAFE_DATA_FLOW",
        nodePath: "root.source",
        message: expect.stringContaining("[SECRET_TO_EVIDENCE]"),
      }),
    );
    expect(
      redactedResult.errors.some(
        (diagnostic) => diagnostic.code === "UNSAFE_DATA_FLOW",
      ),
    ).toBe(false);
  });
});
