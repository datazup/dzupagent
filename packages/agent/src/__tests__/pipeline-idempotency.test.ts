/**
 * W5 — node idempotency keys.
 *
 * Verifies that the pipeline runtime:
 *  - exposes a stable `idempotencyKey` to each node via `NodeExecutionContext`,
 *  - the key is deterministic (`<runId>:<nodeId>`),
 *  - records the keys for completed nodes into the checkpoint, and
 *  - round-trips the keys through a suspend/resume cycle.
 */
import { describe, it, expect } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { nodeIdempotencyKey } from "../pipeline/pipeline-runtime/idempotency.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";
import type {
  NodeExecutor,
  NodeExecutionContext,
} from "../pipeline/pipeline-runtime-types.js";

function linearPipeline(
  overrides: Partial<PipelineDefinition> = {}
): PipelineDefinition {
  return {
    id: "idem-pipeline",
    name: "Idem",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "A",
    checkpointStrategy: "after_each_node",
    nodes: [
      { id: "A", type: "agent", agentId: "a1", timeoutMs: 5000 },
      { id: "B", type: "agent", agentId: "a2", timeoutMs: 5000 },
    ],
    edges: [{ type: "sequential", sourceNodeId: "A", targetNodeId: "B" }],
    ...overrides,
  };
}

describe("pipeline idempotency keys (W5)", () => {
  it("exposes a stable idempotency key to each node and persists it", async () => {
    const seenKeys: Record<string, string | undefined> = {};
    const executor: NodeExecutor = async (
      nodeId: string,
      _node: PipelineNode,
      ctx: NodeExecutionContext
    ) => {
      seenKeys[nodeId] = ctx.idempotencyKey;
      return { nodeId, output: nodeId, durationMs: 1 };
    };

    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: linearPipeline(),
      nodeExecutor: executor,
      checkpointStore: store,
    });

    const result = await runtime.execute();
    expect(result.state).toBe("completed");

    // Every node received a key, and it is `<runId>:<nodeId>`.
    expect(seenKeys["A"]).toBe(nodeIdempotencyKey(result.runId, "A"));
    expect(seenKeys["B"]).toBe(nodeIdempotencyKey(result.runId, "B"));

    // The latest checkpoint records keys for the completed nodes.
    const checkpoint = await store.load(result.runId);
    expect(checkpoint?.nodeIdempotencyKeys).toMatchObject({
      A: nodeIdempotencyKey(result.runId, "A"),
      B: nodeIdempotencyKey(result.runId, "B"),
    });
  });

  it("round-trips idempotency keys through suspend/resume", async () => {
    // A → (suspend) S → B. Run suspends at S after completing A.
    const def: PipelineDefinition = {
      id: "idem-suspend",
      name: "IdemSuspend",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      entryNodeId: "A",
      checkpointStrategy: "after_each_node",
      nodes: [
        { id: "A", type: "agent", agentId: "a1", timeoutMs: 5000 },
        { id: "S", type: "suspend" },
        { id: "B", type: "agent", agentId: "a2", timeoutMs: 5000 },
      ],
      edges: [
        { type: "sequential", sourceNodeId: "A", targetNodeId: "S" },
        { type: "sequential", sourceNodeId: "S", targetNodeId: "B" },
      ],
    };

    const store = new InMemoryPipelineCheckpointStore();
    const seenKeys: Record<string, string | undefined> = {};
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      seenKeys[nodeId] = ctx.idempotencyKey;
      return { nodeId, output: nodeId, durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
      checkpointStore: store,
    });

    const first = await runtime.execute();
    expect(first.state).toBe("suspended");

    const checkpoint = await store.load(first.runId);
    expect(checkpoint?.suspendedAtNodeId).toBe("S");
    // A completed before the suspend → its key is recorded.
    expect(checkpoint?.nodeIdempotencyKeys?.["A"]).toBe(
      nodeIdempotencyKey(first.runId, "A")
    );

    // Resume: B runs and must see a key derived from the SAME runId.
    const resumed = await runtime.resume(checkpoint!);
    expect(resumed.state).toBe("completed");
    expect(seenKeys["B"]).toBe(nodeIdempotencyKey(first.runId, "B"));
  });
});
