import type {
  FlowNode,
  ResolvedTool,
  ToolResolver,
} from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import {
  createFlowCompiledClassificationEnvelope,
  createFlowCompiler,
  semanticResolve,
  validateFlowCompiledClassificationEnvelope,
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
    expect(rawResult.errors).toContainEqual(
      expect.objectContaining({
        code: "PRIMITIVE_REDACTION_REQUIRED",
        nodePath: "root.source",
      }),
    );
    expect(
      redactedResult.errors.some(
        (diagnostic) =>
          diagnostic.code === "UNSAFE_DATA_FLOW" ||
          diagnostic.code === "PRIMITIVE_REDACTION_REQUIRED",
      ),
    ).toBe(false);

    const envelope = createFlowCompiledClassificationEnvelope(
      redacted,
      "compile-redaction",
      "semantic-redaction",
      {
        referenceBindings: {
          state: ["secretResult"],
          steps: ["write_redacted"],
        },
        referenceTypeBindings: {
          state: { secretResult: "unknown" },
        },
        referencePortBindings: {
          write_redacted: { receipt: "object" },
        },
        referenceClassificationBindings: {
          state: { secretResult: "secret" },
        },
        referencePortClassificationBindings: {
          write_redacted: { receipt: "internal" },
        },
      },
    );
    expect(envelope.classificationComplete).toBe(true);
    expect(envelope.unclassifiedReferences).toEqual([]);
    expect(envelope.primitives[0]).toEqual(
      expect.objectContaining({
        nodePath: "root",
        primitiveRef: "primitive://evidence.write@1",
        redaction: {
          requiredAbove: "internal",
          policyRef: "policy://dzupagent/evidence-redaction@1",
          receiptRequired: true,
          receiptSchema: "dzupagent.flowRedactionReceipt/v1",
        },
      }),
    );
    expect(envelope.classificationHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(validateFlowCompiledClassificationEnvelope(envelope)).toEqual({
      valid: true,
      issues: [],
    });
    expect(
      validateFlowCompiledClassificationEnvelope({
        ...envelope,
        semanticHash: "tampered",
      }),
    ).toEqual({
      valid: false,
      issues: ["classificationHash does not match envelope contents"],
    });
    expect(
      validateFlowCompiledClassificationEnvelope({
        ...envelope,
        rawContent: "must-never-be-carried",
      }),
    ).toEqual({
      valid: false,
      issues: ["envelope.rawContent is not allowed"],
    });
    expect(
      validateFlowCompiledClassificationEnvelope({
        ...envelope,
        values: [
          {
            ...envelope.values[0],
            rawContent: "must-never-be-carried",
          },
        ],
      }),
    ).toEqual(
      expect.objectContaining({
        valid: false,
        issues: expect.arrayContaining([
          "values[0].rawContent is not allowed",
          "classificationHash does not match envelope contents",
        ]),
      }),
    );
    expect(
      createFlowCompiledClassificationEnvelope(
        redacted,
        "different-compile-id",
        "semantic-redaction",
        {
          referenceBindings: {
            state: ["secretResult"],
            steps: ["write_redacted"],
          },
          referenceTypeBindings: {
            state: { secretResult: "unknown" },
          },
          referencePortBindings: {
            write_redacted: { receipt: "object" },
          },
          referenceClassificationBindings: {
            state: { secretResult: "secret" },
          },
          referencePortClassificationBindings: {
            write_redacted: { receipt: "internal" },
          },
        },
      ).classificationHash,
    ).toBe(envelope.classificationHash);
    const incomplete = createFlowCompiledClassificationEnvelope(
      redacted,
      "compile-incomplete",
      "semantic-redaction",
      {
        referenceBindings: {
          context: ["tenantLabel"],
          state: ["secretResult"],
        },
        referenceTypeBindings: {
          context: { tenantLabel: "string" },
          state: { secretResult: "unknown" },
        },
        referencePortBindings: {},
        referenceClassificationBindings: {
          state: { secretResult: "secret" },
        },
        referencePortClassificationBindings: {},
      },
    );
    expect(incomplete.classificationComplete).toBe(false);
    expect(incomplete.unclassifiedReferences).toEqual([
      "context.tenantLabel",
    ]);
  });

  it("uses generated primitive ports and preserves their inferred classification", async () => {
    const result = await createFlowCompiler({
      toolResolver: resolver,
      referencePolicy: "strict",
    }).compileDocument({
      dsl: "dzupflow/v1",
      id: "generated_classified_port",
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
            assign: { candidate: "{{ inputs.payload }}" },
          },
          {
            type: "validate.schema",
            id: "checked",
            source: "candidate",
            schema: { type: "object" },
            output: "validationResult",
          },
          {
            type: "complete",
            id: "finish",
            result: "{{ steps.checked.result }}",
          },
        ],
      },
    });

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected strict failure");
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "UNSAFE_DATA_FLOW",
        nodePath: "root.nodes[2].result",
        message: expect.stringContaining("[SENSITIVE_TO_ARTIFACT]"),
      }),
    );
    expect(
      result.errors.some((diagnostic) =>
        diagnostic.message.includes("UNKNOWN_STEP_PORT"),
      ),
    ).toBe(false);
  });

  it("admits an opaque credential handle only at a declared primitive path", async () => {
    const result = await createFlowCompiler({
      toolResolver: resolver,
      referencePolicy: "strict",
    }).compileDocument({
      dsl: "dzupflow/v1",
      id: "credential_handle_admission",
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
            type: "adapter.run",
            id: "call",
            provider: "codex",
            instructions: "Perform the bounded task",
            input: {
              credential: "{{ inputs.providerCredential }}",
            },
            output: "result",
          },
        ],
      },
    });

    expect("errors" in result).toBe(false);
    if ("errors" in result) {
      throw new Error(
        `expected credential admission success: ${JSON.stringify(result.errors)}`,
      );
    }
    expect(
      result.warnings.some((warning) =>
        warning.code.startsWith("CREDENTIAL_HANDLE_"),
      ),
    ).toBe(false);
    expect(result.classificationEnvelope).toEqual(
      expect.objectContaining({
        schema: "dzupagent.flowCompiledClassificationEnvelope/v1",
        compileId: result.compileId,
        classificationHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        classificationComplete: true,
        unclassifiedReferences: [],
        values: expect.arrayContaining([
          expect.objectContaining({
            reference: "inputs.providerCredential",
            classification: "secret",
            valueType: "credential",
            credential: {
              form: "opaque-handle",
              resolution: "lease-only",
            },
          }),
        ]),
        primitives: expect.arrayContaining([
          expect.objectContaining({
            nodePath: "root.nodes[0]",
            primitiveRef: "primitive://adapter.run@1",
            credential: {
              mode: "handle-only",
              inputPaths: ["input.credential", "input.credentials.*"],
              resolverCapabilityRef: "flow.runtime.credential.resolve@1",
            },
            outputs: [
              expect.objectContaining({
                port: "result",
                expectedClassification: "internal",
                effectiveClassification: "secret",
              }),
            ],
          }),
        ]),
      }),
    );
    expect(
      (result.artifact as Record<string, unknown>)["classificationEnvelope"],
    ).toBe(result.classificationEnvelope);
    expect(
      Object.getOwnPropertyDescriptor(
        result.artifact,
        "classificationEnvelope",
      )?.writable,
    ).toBe(false);
  });

  it("preserves credential identity through a whole-value set assignment", async () => {
    const result = await createFlowCompiler({
      toolResolver: resolver,
      referencePolicy: "strict",
    }).compileDocument({
      dsl: "dzupflow/v1",
      id: "credential_handle_state_copy",
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
          {
            type: "adapter.run",
            id: "call",
            provider: "codex",
            instructions: "Perform the bounded task",
            input: {
              credential: "{{ state.copiedCredential }}",
            },
            output: "result",
          },
        ],
      },
    });

    expect("errors" in result).toBe(false);
    if ("errors" in result) {
      throw new Error(
        `expected credential copy admission success: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("rejects credential interpolation and undeclared primitive paths", async () => {
    const result = await createFlowCompiler({
      toolResolver: resolver,
      referencePolicy: "strict",
    }).compileDocument({
      dsl: "dzupflow/v1",
      id: "credential_handle_misuse",
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
            type: "adapter.run",
            id: "call",
            provider: "codex",
            instructions:
              "Use credential {{ inputs.providerCredential | json }}",
            output: "result",
          },
        ],
      },
    });

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected credential failure");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CREDENTIAL_HANDLE_INTERPOLATION",
          nodePath: "root.nodes[0].instructions",
        }),
        expect.objectContaining({
          code: "CREDENTIAL_HANDLE_TRANSFORM_FORBIDDEN",
        }),
        expect.objectContaining({
          code: "CREDENTIAL_HANDLE_NOT_ALLOWED",
        }),
      ]),
    );
  });

  it("rejects raw secret strings even at a credential-handle path", async () => {
    const result = await createFlowCompiler({
      toolResolver: resolver,
      referencePolicy: "strict",
      referenceBindings: { secrets: ["rawApiKey"] },
      referenceTypeBindings: { secrets: { rawApiKey: "string" } },
    }).compile({
      type: "adapter.run",
      id: "call",
      provider: "codex",
      instructions: "Perform the bounded task",
      input: {
        credential: "{{ secrets.rawApiKey }}",
      },
      output: "result",
    });

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected raw-secret failure");
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "PRIMITIVE_INPUT_CLASSIFICATION_DENIED",
        nodePath: "root.input.credential",
      }),
    );
  });

  it("reports primitive admission as a compatibility warning before strict promotion", async () => {
    const result = await createFlowCompiler({
      toolResolver: resolver,
      referenceBindings: { secrets: ["rawApiKey"] },
      referenceTypeBindings: { secrets: { rawApiKey: "string" } },
    }).compile({
      type: "adapter.run",
      id: "call",
      provider: "codex",
      instructions: "Perform the bounded task",
      input: {
        credential: "{{ secrets.rawApiKey }}",
      },
      output: "result",
    });

    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected compatibility success");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "PRIMITIVE_INPUT_CLASSIFICATION_DENIED",
        nodePath: "root.input.credential",
      }),
    );
  });

  it("makes strict classified inputs mandatory for unattended admission", async () => {
    const document = (classification?: "internal") => ({
      dsl: "dzupflow/v1",
      id: "unattended_admission",
      version: 1,
      inputs: {
        task: {
          type: "string",
          required: true,
          ...(classification === undefined ? {} : { classification }),
        },
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "action",
            id: "run",
            toolRef: "known.tool",
            input: {},
          },
          { type: "complete", id: "done", result: "ok" },
        ],
      },
    });

    const compatibility = await createFlowCompiler({
      toolResolver: resolver,
      admissionProfile: "unattended",
    }).compileDocument(document());
    const unclassifiedStrict = await createFlowCompiler({
      toolResolver: resolver,
      admissionProfile: "unattended",
      referencePolicy: "strict",
    }).compileDocument(document());
    const classifiedStrict = await createFlowCompiler({
      toolResolver: resolver,
      admissionProfile: "unattended",
      referencePolicy: "strict",
    }).compileDocument(document("internal"));

    expect("errors" in compatibility).toBe(true);
    if (!("errors" in compatibility)) {
      throw new Error("expected unattended compatibility failure");
    }
    expect(compatibility.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNATTENDED_STRICT_ADMISSION_REQUIRED",
        }),
        expect.objectContaining({
          code: "UNATTENDED_INPUT_CLASSIFICATION_REQUIRED",
        }),
      ]),
    );
    expect("errors" in unclassifiedStrict).toBe(true);
    if (!("errors" in unclassifiedStrict)) {
      throw new Error("expected unclassified unattended failure");
    }
    expect(unclassifiedStrict.errors).toContainEqual(
      expect.objectContaining({
        code: "UNATTENDED_INPUT_CLASSIFICATION_REQUIRED",
      }),
    );
    if ("errors" in classifiedStrict) {
      throw new Error(
        `expected classified unattended success: ${JSON.stringify(classifiedStrict.errors)}`,
      );
    }
  });
});
