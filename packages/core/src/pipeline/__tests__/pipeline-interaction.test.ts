import { describe, expect, it } from "vitest";

import {
  createPipelineInteractionResumeV1,
  createPipelineInteractionSpecV1,
  createPipelinePendingInteractionV1,
  digestPipelineDefinition,
  type PipelinePendingInteractionV1,
} from "@dzupagent/runtime-contracts";
import {
  PipelineCheckpointSchema,
  deserializePipeline,
  serializePipeline,
  type PipelineCheckpoint,
  type PipelineDefinition,
} from "../index.js";

const approval = createPipelineInteractionSpecV1({
  kind: "approval",
  authoredNodeId: "approval",
  authoredPath: "root.nodes[0]",
  question: "Proceed?",
  choices: [],
  outcomeToSuccessor: { approved: "yes", rejected: "no" },
  requestSchema: {
    kind: "approval",
    decisions: ["approved", "rejected"],
  },
});

const definition: PipelineDefinition = {
  id: "pipeline",
  name: "interaction pipeline",
  version: "1",
  schemaVersion: "1.1.0",
  entryNodeId: "gate",
  nodes: [
    {
      id: "gate",
      type: "gate",
      gateType: "approval",
      interaction: approval,
    },
    { id: "yes", type: "agent", agentId: "yes" },
    { id: "no", type: "agent", agentId: "no" },
  ],
  edges: [
    {
      type: "conditional",
      sourceNodeId: "gate",
      predicateName: "not-used-for-interaction",
      branches: { approved: "yes", rejected: "no" },
    },
  ],
};

const definitionDigest = digestPipelineDefinition(definition);

const pending: PipelinePendingInteractionV1 = createPipelinePendingInteractionV1({
  kind: "approval",
  definitionDigest,
  pipelineId: "pipeline",
  runId: "run",
  nodeId: "gate",
  scope: { kind: "pipeline" },
  occurrence: 0,
  expectedCheckpointVersion: 3,
  requestDigest: approval.requestDigest,
  expiresAt: "2030-01-01T00:00:00.000Z",
});

function checkpoint(overrides: Partial<PipelineCheckpoint> = {}): PipelineCheckpoint {
  return {
    pipelineRunId: "run",
    pipelineId: "pipeline",
    version: 3,
    schemaVersion: "1.1.0",
    completedNodeIds: [],
    state: {},
    createdAt: "2029-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("pipeline interaction artifact and checkpoint schemas", () => {
  it("round-trips an approval interaction specification on a pipeline node", () => {
    expect(deserializePipeline(serializePipeline(definition))).toEqual(definition);
  });

  it("rejects interaction artifacts on schema 1.0 and routing drift", () => {
    expect(
      serializePipeline.bind(undefined, {
        ...definition,
        schemaVersion: "1.0.0",
      }),
    ).toThrow(/interaction specifications require schemaVersion 1\.1\.0/);
    expect(
      serializePipeline.bind(undefined, {
        ...definition,
        edges: [
          {
            type: "conditional",
            sourceNodeId: "gate",
            predicateName: "not-used-for-interaction",
            branches: { approved: "no", rejected: "yes" },
          },
        ],
      }),
    ).toThrow(/outcome mapping must agree/);
  });

  it("rejects unknown interaction and checkpoint fields", () => {
    expect(
      PipelineCheckpointSchema.safeParse({
        ...checkpoint(),
        arbitraryStateMerge: true,
      }).success,
    ).toBe(false);
    expect(() =>
      serializePipeline({
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.id === "gate" ? { ...node, arbitraryDecision: true } : node,
        ) as PipelineDefinition["nodes"],
      }),
    ).toThrow(/Unrecognized key/);
  });

  it("accepts an exact pending interaction bound to the checkpoint", () => {
    const result = PipelineCheckpointSchema.safeParse(
      checkpoint({
        suspendedAtNodeId: "gate",
        pendingInteraction: pending,
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({ pendingInteraction: pending }),
    );
  });

  it.each([
    ["pipeline", { pipelineId: "other" }],
    ["run", { runId: "other" }],
    ["version", { expectedCheckpointVersion: 4 }],
  ])("rejects a pending %s binding mismatch", (_name, mutation) => {
    const result = PipelineCheckpointSchema.safeParse(
      checkpoint({
        pendingInteraction: { ...pending, ...mutation },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts a committed receipt and exact post-consumption cursor", () => {
    const receipt = createPipelineInteractionResumeV1({
      definitionDigest,
      pipelineId: "pipeline",
      runId: "run",
      nodeId: "gate",
      scope: { kind: "pipeline" },
      occurrence: 0,
      interactionId: pending.interactionId,
      expectedCheckpointVersion: 3,
      requestDigest: approval.requestDigest,
      receiptId: "receipt-1",
      submittedAt: "2029-01-01T00:00:01.000Z",
      response: { kind: "approval", decision: "approved" },
    });
    expect(
      PipelineCheckpointSchema.safeParse(
        checkpoint({
          version: 4,
          completedNodeIds: ["gate"],
          interactionReceipts: { [receipt.interactionId]: receipt },
          interactionResumeCursor: {
            interactionId: receipt.interactionId,
            receiptHash: receipt.receiptHash,
            definitionDigest: receipt.definitionDigest,
            nodeId: receipt.nodeId,
            scope: receipt.scope,
            selectedSuccessorNodeId: "yes",
            nextNodeId: "yes",
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects a cursor without its immutable receipt", () => {
    expect(
      PipelineCheckpointSchema.safeParse(
        checkpoint({
          interactionResumeCursor: {
            interactionId: pending.interactionId,
            receiptHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            definitionDigest,
            nodeId: "gate",
            scope: { kind: "pipeline" },
            selectedSuccessorNodeId: "yes",
            nextNodeId: "yes",
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects a checkpoint that is both pending and post-consumption", () => {
    const receipt = createPipelineInteractionResumeV1({
      definitionDigest,
      pipelineId: "pipeline",
      runId: "run",
      nodeId: "gate",
      scope: { kind: "pipeline" },
      occurrence: 0,
      interactionId: pending.interactionId,
      expectedCheckpointVersion: 3,
      requestDigest: approval.requestDigest,
      receiptId: "receipt-1",
      submittedAt: "2029-01-01T00:00:01.000Z",
      response: { kind: "approval", decision: "approved" },
    });
    expect(
      PipelineCheckpointSchema.safeParse(
        checkpoint({
          pendingInteraction: pending,
          interactionReceipts: { [receipt.interactionId]: receipt },
          interactionResumeCursor: {
            interactionId: receipt.interactionId,
            receiptHash: receipt.receiptHash,
            definitionDigest: receipt.definitionDigest,
            nodeId: receipt.nodeId,
            scope: receipt.scope,
            selectedSuccessorNodeId: "yes",
            nextNodeId: "yes",
          },
        }),
      ).success,
    ).toBe(false);
  });
});
