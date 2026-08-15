import { describe, expect, it, vi } from "vitest";

import type {
  PipelineCheckpoint,
  PipelineDefinition,
} from "@dzupagent/core/pipeline";

import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";

function unsupportedDefinition(): PipelineDefinition {
  return {
    id: "unsupported-recursive-fork",
    name: "UnsupportedRecursiveFork",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "fork",
    nodes: [
      { id: "fork", type: "fork", forkId: "parallel" },
      { id: "decision", type: "gate", gateType: "quality" },
      { id: "left", type: "agent", agentId: "left" },
      { id: "right", type: "agent", agentId: "right" },
      { id: "sibling", type: "agent", agentId: "sibling" },
      { id: "join", type: "join", forkId: "parallel" },
    ],
    edges: [
      { type: "sequential", sourceNodeId: "fork", targetNodeId: "decision" },
      { type: "sequential", sourceNodeId: "fork", targetNodeId: "sibling" },
      {
        type: "conditional",
        sourceNodeId: "decision",
        predicateName: "choose",
        branches: { true: "left", false: "right" },
      },
      { type: "sequential", sourceNodeId: "left", targetNodeId: "join" },
      { type: "sequential", sourceNodeId: "right", targetNodeId: "join" },
      { type: "sequential", sourceNodeId: "sibling", targetNodeId: "join" },
    ],
  };
}

function checkpoint(): PipelineCheckpoint {
  return {
    pipelineRunId: "recursive-resume",
    pipelineId: "unsupported-recursive-fork",
    version: 1,
    schemaVersion: "1.0.0",
    completedNodeIds: ["fork"],
    forkState: {
      parallel: {
        branches: {
          sibling: {
            stateDelta: { sibling: true },
            nodeResults: {
              sibling: {
                nodeId: "sibling",
                output: "sibling",
                durationMs: 1,
              },
            },
          },
        },
      },
    },
    state: {},
    createdAt: new Date(0).toISOString(),
  };
}

describe("recursive fork definition denial", () => {
  it("fails before dispatch on a fresh execute", async () => {
    const nodeExecutor = vi.fn();
    const runtime = new PipelineRuntime({
      definition: unsupportedDefinition(),
      nodeExecutor,
      predicates: { choose: () => true },
    });

    await expect(runtime.execute()).rejects.toThrow(
      "recursive fork branches require"
    );
    expect(nodeExecutor).not.toHaveBeenCalled();
  });

  it("cannot bypass definition admission through resume", async () => {
    const nodeExecutor = vi.fn();
    const runtime = new PipelineRuntime({
      definition: unsupportedDefinition(),
      nodeExecutor,
      predicates: { choose: () => true },
    });

    await expect(runtime.resume(checkpoint())).rejects.toThrow(
      "recursive fork branches require"
    );
    expect(nodeExecutor).not.toHaveBeenCalled();
  });
});
