import { describe, expect, it } from "vitest";

import type { PipelineCheckpoint } from "../pipeline-checkpoint-store.js";
import { PipelineCheckpointSchema } from "../pipeline-serialization.js";

const hash = (digit: string): `sha256:${string}` =>
  `sha256:${digit.repeat(64)}`;

function checkpoint(
  schemaVersion: PipelineCheckpoint["schemaVersion"] = "1.2.0"
): PipelineCheckpoint {
  return {
    pipelineRunId: "recursive-run",
    pipelineId: "recursive-flow",
    version: 1,
    schemaVersion,
    sourceBinding: { definitionDigest: hash("1") },
    completedNodeIds: ["fork", "join"],
    recursiveForkCompletions: {
      fork: {
        schema: "dzupagent.pipelineRecursiveForkCompletion/v1",
        definitionDigest: hash("1"),
        ownerPath: ["recursive-flow", "fork"],
        forkNodeId: "fork",
        forkId: "parallel",
        joinNodeId: "join",
        parentCommitIdentity: hash("2"),
        mergeIdentity: hash("3"),
        childCommitIdentities: [hash("4"), hash("5")],
        children: [
          {
            childScopeId: "run/fork/0",
            frameIdentity: hash("6"),
            commitIdentity: hash("4"),
            normalExitNodeId: "then",
          },
          {
            childScopeId: "run/fork/1",
            frameIdentity: hash("7"),
            commitIdentity: hash("5"),
            normalExitNodeId: "sibling",
          },
        ],
        checkpointVersion: 1,
        selectedContinuationNodeId: "after",
      },
    },
    state: {},
    createdAt: new Date(0).toISOString(),
  };
}

describe("W3-C5A recursive fork parent completion checkpoint", () => {
  it("admits the exact receipt at checkpoint schema 1.2.0", () => {
    expect(PipelineCheckpointSchema.safeParse(checkpoint()).success).toBe(true);
  });

  it("rejects the receipt under an older checkpoint schema", () => {
    const result = PipelineCheckpointSchema.safeParse(checkpoint("1.1.0"));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "recursive fork completion receipts require checkpoint schemaVersion 1.2.0"
    );
  });

  it("rejects key, definition, version, and child-set drift", () => {
    const mutations: Array<(value: PipelineCheckpoint) => void> = [
      (value) => {
        value.recursiveForkCompletions!.other =
          value.recursiveForkCompletions!.fork!;
        delete value.recursiveForkCompletions!.fork;
      },
      (value) => {
        value.recursiveForkCompletions!.fork!.definitionDigest = hash("9");
      },
      (value) => {
        value.recursiveForkCompletions!.fork!.checkpointVersion = 2;
      },
      (value) => {
        value.recursiveForkCompletions!.fork!.childCommitIdentities.reverse();
      },
    ];
    for (const mutate of mutations) {
      const value = checkpoint();
      mutate(value);
      expect(PipelineCheckpointSchema.safeParse(value).success).toBe(false);
    }
  });
});
