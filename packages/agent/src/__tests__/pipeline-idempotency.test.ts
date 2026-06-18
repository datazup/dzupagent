/**
 * W5 — node idempotency keys.
 *
 * Verifies that the pipeline runtime:
 *  - exposes a stable `idempotencyKey` to each node via `NodeExecutionContext`,
 *  - the key is deterministic for a given `(runId, nodeId)` pair,
 *  - records the keys for completed nodes into the checkpoint, and
 *  - round-trips the keys through a suspend/resume cycle.
 */
import { describe, it, expect } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import {
  nodeIdempotencyKey,
  nodeIdempotencyContext,
} from "../pipeline/pipeline-runtime/idempotency.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";

/**
 * Rebuild the exact canonical key the runtime produces for a node in a given
 * definition (N3b): the runtime threads the compiled flow definition as the
 * `sourceHash` source plus the node's attempt-policy/input context. Tests must
 * mirror that to compare against `ctx.idempotencyKey` / recorded keys.
 */
function expectedKey(
  def: PipelineDefinition,
  runId: string,
  nodeId: string
): string {
  const node = def.nodes.find((n) => n.id === nodeId)!;
  return nodeIdempotencyKey(runId, nodeId, {
    flowDefinition: def,
    ...nodeIdempotencyContext(node),
  });
}
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
    const def = linearPipeline();
    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
      checkpointStore: store,
    });

    const result = await runtime.execute();
    expect(result.state).toBe("completed");

    // Every node received the canonical key for its (runId, node) (N3b: now
    // including the flow fingerprint + node attempt policy + node input).
    expect(seenKeys["A"]).toBe(expectedKey(def, result.runId, "A"));
    expect(seenKeys["B"]).toBe(expectedKey(def, result.runId, "B"));

    // The latest checkpoint records keys for the completed nodes.
    const checkpoint = await store.load(result.runId);
    expect(checkpoint?.nodeIdempotencyKeys).toMatchObject({
      A: expectedKey(def, result.runId, "A"),
      B: expectedKey(def, result.runId, "B"),
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
      expectedKey(def, first.runId, "A")
    );

    // Resume: B runs and must see a key derived from the SAME runId.
    const resumed = await runtime.resume(checkpoint!);
    expect(resumed.state).toBe("completed");
    expect(seenKeys["B"]).toBe(expectedKey(def, first.runId, "B"));
  });
});

describe("nodeIdempotencyKey — canonical key format (N3 / N3b)", () => {
  it("produces a canonical `dzup:v1:` prefixed key", () => {
    const key = nodeIdempotencyKey("run-123", "node-A");
    expect(key.startsWith("dzup:v1:")).toBe(true);
    // Template: dzup:v1:{sourceHash}:{runId}:{nodeId}:{attemptPolicy}:{digest}
    expect(key).toContain(":run-123:");
    expect(key).toContain(":node-A:");
    expect(key).toContain(":at-least-once:");
  });

  it("is stable: identical inputs produce identical keys", () => {
    expect(nodeIdempotencyKey("run-1", "n1")).toBe(
      nodeIdempotencyKey("run-1", "n1")
    );
    // Stable across identical full context too (N3b).
    expect(
      nodeIdempotencyKey("run-1", "n1", {
        flowDefinition: { id: "f", v: 1 },
        attemptPolicy: "exactly-once-required",
        input: { a: 1 },
      })
    ).toBe(
      nodeIdempotencyKey("run-1", "n1", {
        flowDefinition: { id: "f", v: 1 },
        attemptPolicy: "exactly-once-required",
        input: { a: 1 },
      })
    );
  });

  it("varies by runId and by nodeId", () => {
    const base = nodeIdempotencyKey("run-1", "n1");
    expect(nodeIdempotencyKey("run-2", "n1")).not.toBe(base);
    expect(nodeIdempotencyKey("run-1", "n2")).not.toBe(base);
  });

  it("varies by flowDefinition fingerprint (sourceHash) and attemptPolicy (N3b)", () => {
    const base = nodeIdempotencyKey("run-1", "n1", {
      flowDefinition: { id: "f", version: "1.0.0" },
      attemptPolicy: "at-least-once",
    });
    // Different flow version → different sourceHash → different key.
    expect(
      nodeIdempotencyKey("run-1", "n1", {
        flowDefinition: { id: "f", version: "2.0.0" },
        attemptPolicy: "at-least-once",
      })
    ).not.toBe(base);
    // Different attempt policy → different key.
    expect(
      nodeIdempotencyKey("run-1", "n1", {
        flowDefinition: { id: "f", version: "1.0.0" },
        attemptPolicy: "exactly-once-required",
      })
    ).not.toBe(base);
  });

  it("varies by node input: same node with different inputs → different keys (N3b)", () => {
    const a = nodeIdempotencyKey("run-1", "n1", { input: { x: 1 } });
    const b = nodeIdempotencyKey("run-1", "n1", { input: { x: 2 } });
    expect(a).not.toBe(b);
    // No-input (empty-object default) is its own stable variant.
    expect(nodeIdempotencyKey("run-1", "n1")).not.toBe(a);
  });
});
