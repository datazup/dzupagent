import { describe, expect, it } from "vitest";

import {
  PIPELINE_INTERACTION_RESUME_SCHEMA,
  PIPELINE_INTERACTION_SPEC_SCHEMA,
  PIPELINE_PENDING_INTERACTION_SCHEMA,
  createPipelineInteractionId,
  createPipelinePendingInteractionV1,
  createPipelineInteractionResumeV1,
  createPipelineInteractionSpecV1,
  deserializePipelineInteractionResumeV1,
  deserializePipelineInteractionSpecV1,
  deserializePipelinePendingInteractionV1,
  serializePipelineInteractionResumeV1,
  serializePipelineInteractionSpecV1,
  serializePipelinePendingInteractionV1,
  validatePipelineInteractionResumeV1,
  validatePipelineInteractionSpecV1,
  validatePipelinePendingInteractionV1,
  type PipelinePendingInteractionV1,
} from "../pipeline-interaction.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

const approval = createPipelineInteractionSpecV1({
  kind: "approval",
  authoredNodeId: "approval-node",
  authoredPath: "root.nodes[0].body[1]",
  question: "Proceed?",
  choices: ["safe", "fast"],
  outcomeToSuccessor: {
    approved: "approved-node",
    rejected: "rejected-node",
  },
  requestSchema: {
    kind: "approval",
    decisions: ["approved", "rejected"],
  },
});

const clarification = createPipelineInteractionSpecV1({
  kind: "clarification",
  authoredNodeId: "clarification-node",
  authoredPath: "root.nodes[0].body[2]",
  question: "Which environment?",
  choices: ["staging", "preview"],
  outputKey: "selectedEnvironment",
  requestSchema: {
    kind: "clarification",
    response: "choice",
    minLength: 1,
    maxLength: 16_384,
  },
});

const pending: PipelinePendingInteractionV1 =
  createPipelinePendingInteractionV1({
    kind: "approval",
    definitionDigest: digest("a"),
    pipelineId: "pipeline-1",
    runId: "run-1",
    nodeId: "approval-runtime-node",
    scope: { kind: "loop", loopNodeId: "loop-1", iteration: 3 },
    occurrence: 3,
    expectedCheckpointVersion: 7,
    requestDigest: approval.requestDigest,
    expiresAt: "2030-01-02T03:04:05.000Z",
  });

const receipt = createPipelineInteractionResumeV1({
  definitionDigest: pending.definitionDigest,
  pipelineId: pending.pipelineId,
  runId: pending.runId,
  nodeId: pending.nodeId,
  scope: pending.scope,
  occurrence: pending.occurrence,
  interactionId: pending.interactionId,
  expectedCheckpointVersion: pending.expectedCheckpointVersion,
  requestDigest: pending.requestDigest,
  receiptId: "receipt-1",
  submittedAt: "2029-01-02T03:04:05.000Z",
  response: { kind: "approval", decision: "approved", choice: "safe" },
});

function codes(result: {
  valid: boolean;
  issues: readonly { code: string }[];
}): string[] {
  return result.issues.map((entry) => entry.code);
}

describe("pipeline interaction contracts", () => {
  it("pins exact record bytes and digest identities", () => {
    expect(approval.requestDigest).toBe(
      "sha256:37105de6bbc9910610d618557006bd1988ffb972d7be3d7c1d23db17510411e8",
    );
    expect(pending.interactionId).toBe(
      "interaction:6a3208f492b4ab26dfa10a3467b9aa121d24b4d9db0cfe842ec954382478af97",
    );
    expect(receipt.receiptHash).toBe(
      "sha256:1c3506b027ec09534094fd1fce92a68a8d8bf8389abdf657fc17ec632f99652c",
    );
    expect(serializePipelineInteractionSpecV1(approval)).toBe(
      '{"schema":"dzupagent.pipeline-interaction-spec/v1","kind":"approval","authoredNodeId":"approval-node","authoredPath":"root.nodes[0].body[1]","question":"Proceed?","choices":["safe","fast"],"requestSchema":{"kind":"approval","decisions":["approved","rejected"]},"outcomeToSuccessor":{"approved":"approved-node","rejected":"rejected-node"},"requestDigest":"sha256:37105de6bbc9910610d618557006bd1988ffb972d7be3d7c1d23db17510411e8"}',
    );
    expect(serializePipelinePendingInteractionV1(pending)).toBe(
      '{"schema":"dzupagent.pipeline-pending-interaction/v1","state":"pending","kind":"approval","definitionDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pipelineId":"pipeline-1","runId":"run-1","nodeId":"approval-runtime-node","scope":{"kind":"loop","loopNodeId":"loop-1","iteration":3},"occurrence":3,"expectedCheckpointVersion":7,"requestDigest":"sha256:37105de6bbc9910610d618557006bd1988ffb972d7be3d7c1d23db17510411e8","expiresAt":"2030-01-02T03:04:05.000Z","interactionId":"interaction:6a3208f492b4ab26dfa10a3467b9aa121d24b4d9db0cfe842ec954382478af97"}',
    );
    expect(serializePipelineInteractionResumeV1(receipt)).toBe(
      '{"schema":"dzupagent.pipeline-interaction-resume/v1","definitionDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pipelineId":"pipeline-1","runId":"run-1","nodeId":"approval-runtime-node","scope":{"kind":"loop","loopNodeId":"loop-1","iteration":3},"occurrence":3,"interactionId":"interaction:6a3208f492b4ab26dfa10a3467b9aa121d24b4d9db0cfe842ec954382478af97","expectedCheckpointVersion":7,"requestDigest":"sha256:37105de6bbc9910610d618557006bd1988ffb972d7be3d7c1d23db17510411e8","receiptId":"receipt-1","submittedAt":"2029-01-02T03:04:05.000Z","response":{"kind":"approval","decision":"approved","choice":"safe"},"receiptHash":"sha256:1c3506b027ec09534094fd1fce92a68a8d8bf8389abdf657fc17ec632f99652c"}',
    );
  });

  it("pins the pipeline-interaction runtime import surface", async () => {
    const interactionModule = await import("../pipeline-interaction.js");
    expect(Object.keys(interactionModule).sort()).toEqual([
      "PIPELINE_INTERACTION_LIMITS",
      "PIPELINE_INTERACTION_RESUME_SCHEMA",
      "PIPELINE_INTERACTION_SPEC_SCHEMA",
      "PIPELINE_PENDING_INTERACTION_SCHEMA",
      "createPipelineInteractionId",
      "createPipelineInteractionResumeV1",
      "createPipelineInteractionSpecV1",
      "createPipelinePendingInteractionV1",
      "deserializePipelineInteractionResumeV1",
      "deserializePipelineInteractionSpecV1",
      "deserializePipelinePendingInteractionV1",
      "digestPipelineDefinition",
      "digestPipelineInteractionValue",
      "serializePipelineInteractionResumeV1",
      "serializePipelineInteractionSpecV1",
      "serializePipelinePendingInteractionV1",
      "validatePipelineInteractionResumeV1",
      "validatePipelineInteractionSpecV1",
      "validatePipelinePendingInteractionV1",
    ]);
  });

  it("pins validation issue ordering and replay parse failures", () => {
    expect(
      validatePipelineInteractionResumeV1(
        {
          ...receipt,
          schema: "dzupagent.pipeline-interaction-resume/v2",
          runId: "different-run",
          response: { kind: "clarification", value: "unknown" },
          receiptHash: digest("0"),
          unknown: true,
        },
        { spec: approval, pending },
      ).issues.map(({ path, code }) => [path, code]),
    ).toEqual([
      ["$.unknown", "UNKNOWN_FIELD"],
      ["$.schema", "UNKNOWN_VERSION"],
      ["$.runId", "BINDING_MISMATCH"],
      ["$.response.kind", "KIND_MISMATCH"],
      ["$.response.kind", "KIND_MISMATCH"],
    ]);
    expect(() => deserializePipelineInteractionResumeV1("{")).toThrow(
      "Pipeline interaction deserialization failed: invalid JSON.",
    );
  });

  it("round-trips approval and clarification specifications", () => {
    expect(
      deserializePipelineInteractionSpecV1(
        serializePipelineInteractionSpecV1(approval),
      ),
    ).toEqual(approval);
    expect(
      deserializePipelineInteractionSpecV1(
        serializePipelineInteractionSpecV1(clarification),
      ),
    ).toEqual(clarification);
  });

  it("round-trips an exact pending binding and immutable resume receipt", () => {
    expect(
      deserializePipelinePendingInteractionV1(
        serializePipelinePendingInteractionV1(pending),
      ),
    ).toEqual(pending);
    expect(
      deserializePipelineInteractionResumeV1(
        serializePipelineInteractionResumeV1(receipt),
      ),
    ).toEqual(receipt);
  });

  it("rejects unknown contract versions", () => {
    expect(
      codes(
        validatePipelineInteractionSpecV1({
          ...approval,
          schema: "dzupagent.pipeline-interaction-spec/v2",
        }),
      ),
    ).toContain("UNKNOWN_VERSION");
    expect(
      codes(
        validatePipelinePendingInteractionV1({
          ...pending,
          schema: "dzupagent.pipeline-pending-interaction/v2",
        }),
      ),
    ).toContain("UNKNOWN_VERSION");
    expect(
      codes(
        validatePipelineInteractionResumeV1({
          ...receipt,
          schema: "dzupagent.pipeline-interaction-resume/v2",
        }),
      ),
    ).toContain("UNKNOWN_VERSION");
  });

  it("rejects corrupt specification and receipt digests", () => {
    expect(
      codes(
        validatePipelineInteractionSpecV1({
          ...approval,
          requestDigest: digest("0"),
        }),
      ),
    ).toContain("DIGEST_MISMATCH");
    expect(
      codes(
        validatePipelineInteractionResumeV1({
          ...receipt,
          receiptHash: digest("0"),
        }),
      ),
    ).toContain("DIGEST_MISMATCH");
  });

  it("rejects a request schema whose discriminator mismatches the spec", () => {
    const result = validatePipelineInteractionSpecV1({
      ...approval,
      requestSchema: {
        kind: "clarification",
        response: "text",
        minLength: 1,
        maxLength: 10,
      },
    });
    expect(codes(result)).toContain("KIND_MISMATCH");
  });

  it("rejects duplicate, empty, and unbounded choices", () => {
    for (const choices of [
      ["same", "same"],
      [""],
      Array.from({ length: 33 }, (_, index) => `choice-${index}`),
    ]) {
      expect(
        codes(validatePipelineInteractionSpecV1({ ...clarification, choices })),
      ).toContain("INVALID_CHOICE");
    }
  });

  it("rejects a choice response outside the authored bounded set", () => {
    const drifted = createPipelineInteractionResumeV1({
      ...receipt,
      receiptId: "receipt-2",
      response: { kind: "approval", decision: "approved", choice: "unknown" },
    });
    expect(
      codes(
        validatePipelineInteractionResumeV1(drifted, {
          spec: approval,
          pending,
        }),
      ),
    ).toContain("INVALID_CHOICE");
  });

  it("rejects a missing exact binding", () => {
    const { definitionDigest: _definitionDigest, ...unbound } = pending;
    expect(codes(validatePipelinePendingInteractionV1(unbound))).toContain(
      "MISSING_BINDING",
    );
  });

  it("rejects a pending interaction ID that is not derived from its bindings", () => {
    expect(
      codes(
        validatePipelinePendingInteractionV1({
          ...pending,
          interactionId: createPipelineInteractionId({
            definitionDigest: pending.definitionDigest,
            pipelineId: pending.pipelineId,
            runId: "different-run",
            nodeId: pending.nodeId,
            scope: pending.scope,
            occurrence: pending.occurrence,
            requestDigest: pending.requestDigest,
          }),
        }),
      ),
    ).toContain("BINDING_MISMATCH");
  });

  it.each([
    [{ kind: "pipeline" }, 1],
    [{ kind: "loop", loopNodeId: "loop-1", iteration: 3 }, 4],
  ] as const)(
    "rejects a coherently re-identified noncanonical occurrence for scope %#",
    (scope, occurrence) => {
      const forgedPending = createPipelinePendingInteractionV1({
        ...pending,
        scope,
        occurrence,
      });
      const forgedReceipt = createPipelineInteractionResumeV1({
        ...forgedPending,
        receiptId: "forged-occurrence",
        submittedAt: "2029-01-02T03:04:05.000Z",
        response: { kind: "approval", decision: "approved" },
      });
      expect(
        codes(validatePipelinePendingInteractionV1(forgedPending)),
      ).toContain("BINDING_MISMATCH");
      expect(
        codes(validatePipelineInteractionResumeV1(forgedReceipt)),
      ).toContain("BINDING_MISMATCH");
    },
  );

  it("rejects over-limit clarification schemas and reasons", () => {
    expect(
      codes(
        validatePipelineInteractionSpecV1({
          ...clarification,
          requestSchema: { ...clarification.requestSchema, maxLength: 16_385 },
        }),
      ),
    ).toContain("INVALID_VALUE");
    const longReason = createPipelineInteractionResumeV1({
      ...pending,
      receiptId: "long-reason",
      submittedAt: "2029-01-02T03:04:05.000Z",
      response: {
        kind: "approval",
        decision: "approved",
        reason: "x".repeat(4_097),
      },
    });
    expect(codes(validatePipelineInteractionResumeV1(longReason))).toContain(
      "INVALID_VALUE",
    );
  });

  it("rejects every pending/resume binding mismatch", () => {
    const mutations: Record<string, unknown>[] = [
      { definitionDigest: digest("b") },
      { pipelineId: "pipeline-2" },
      { runId: "run-2" },
      { nodeId: "other-node" },
      { scope: { kind: "loop", loopNodeId: "loop-1", iteration: 4 } },
      { occurrence: 4 },
      { interactionId: "other-interaction" },
      { expectedCheckpointVersion: 8 },
      { requestDigest: digest("b") },
    ];
    for (const mutation of mutations) {
      const result = validatePipelineInteractionResumeV1(
        { ...receipt, ...mutation },
        { spec: approval, pending },
      );
      expect(codes(result)).toContain("BINDING_MISMATCH");
    }
  });

  it("rejects a response kind that mismatches pending and authored kinds", () => {
    const result = validatePipelineInteractionResumeV1(
      {
        ...receipt,
        response: { kind: "clarification", value: "safe" },
      },
      { spec: approval, pending },
    );
    expect(codes(result)).toContain("KIND_MISMATCH");
  });

  it("rejects unknown fields rather than retaining arbitrary application state", () => {
    expect(
      codes(
        validatePipelinePendingInteractionV1({
          ...pending,
          additionalState: { secret: true },
        }),
      ),
    ).toContain("UNKNOWN_FIELD");
    expect(
      codes(
        validatePipelineInteractionResumeV1({
          ...receipt,
          providerSession: "must-not-be-retained",
        }),
      ),
    ).toContain("UNKNOWN_FIELD");
  });

  it("pins the public schema constants", () => {
    expect(approval.schema).toBe(PIPELINE_INTERACTION_SPEC_SCHEMA);
    expect(pending.schema).toBe(PIPELINE_PENDING_INTERACTION_SCHEMA);
    expect(receipt.schema).toBe(PIPELINE_INTERACTION_RESUME_SCHEMA);
  });
});
