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
import { materializeIdempotencyKey } from "@dzupagent/runtime-contracts";
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

  it("uses a declared node idempotency key when present (W1)", () => {
    const node: PipelineNode = {
      id: "declared-node",
      type: "tool",
      toolName: "tools.write",
      arguments: { id: 1 },
      declaredIdempotencyKey: "order-123",
      idempotency: "exactly-once-required",
    };

    const context = nodeIdempotencyContext(node);

    expect(context).toMatchObject({
      attemptPolicy: "exactly-once-required",
      declaredKey: "order-123",
      input: { arguments: { id: 1 } },
    });
    expect(nodeIdempotencyKey("run-1", node.id, context)).toBe(
      "dzup:v1:declared:order-123"
    );
    expect(nodeIdempotencyKey("run-1", node.id, { input: { id: 1 } })).not.toBe(
      "dzup:v1:declared:order-123"
    );
  });
});

describe("W1 durability wiring — declared-key short-circuit matrix (T1-T4, T7)", () => {
  it("T1: a node with NO durability decls derives the canonical key, unchanged (declared short-circuit does not fire)", () => {
    const node: PipelineNode = {
      id: "plain-node",
      type: "tool",
      toolName: "tools.read",
      arguments: { q: "x" },
      // No `declaredIdempotencyKey`, no `idempotency`.
    };

    const context = nodeIdempotencyContext(node);
    // The declared short-circuit must not have fired: no `declaredKey` in context.
    expect(context).not.toHaveProperty("declaredKey");
    expect(context.attemptPolicy).toBe("at-least-once");

    const actual = nodeIdempotencyKey("run-9", node.id, context);

    // Golden: reconstruct the same key via the canonical deriver directly.
    const golden = materializeIdempotencyKey({
      sourceHash: "",
      runId: "run-9",
      nodeId: node.id,
      attemptPolicy: "at-least-once",
      input: { arguments: { q: "x" } },
    });

    expect(actual).toBe(golden);
    expect(actual.startsWith("dzup:v1:declared:")).toBe(false);
  });

  it("T2: nodeIdempotencyKey with an explicit declaredKey returns the literal namespaced form, not the derived key", () => {
    const declared = nodeIdempotencyKey("run-1", "node-x", {
      declaredKey: "k",
    });
    expect(declared).toBe("dzup:v1:declared:k");

    const derived = nodeIdempotencyKey("run-1", "node-x");
    expect(declared).not.toBe(derived);
  });

  it("T3: of two nodes in the same batch, only the declared one short-circuits — the other still derives", () => {
    const declaredNode: PipelineNode = {
      id: "n-declared",
      type: "tool",
      toolName: "tools.write",
      arguments: { id: 1 },
      declaredIdempotencyKey: "batch-key-1",
    };
    const plainNode: PipelineNode = {
      id: "n-plain",
      type: "tool",
      toolName: "tools.write",
      arguments: { id: 2 },
    };

    const declaredKey = nodeIdempotencyKey(
      "run-batch",
      declaredNode.id,
      nodeIdempotencyContext(declaredNode)
    );
    const plainKey = nodeIdempotencyKey(
      "run-batch",
      plainNode.id,
      nodeIdempotencyContext(plainNode)
    );

    expect(declaredKey).toBe("dzup:v1:declared:batch-key-1");

    const plainGolden = materializeIdempotencyKey({
      sourceHash: "",
      runId: "run-batch",
      nodeId: plainNode.id,
      attemptPolicy: "at-least-once",
      input: { arguments: { id: 2 } },
    });
    expect(plainKey).toBe(plainGolden);
    expect(plainKey.startsWith("dzup:v1:declared:")).toBe(false);
    expect(declaredKey).not.toBe(plainKey);
  });

  it("T4: idempotency: 'exactly-once-required' threads through as attemptPolicy and changes the derived key vs the at-least-once golden", () => {
    const strictNode: PipelineNode = {
      id: "strict-node",
      type: "tool",
      toolName: "tools.charge",
      arguments: { amount: 100 },
      idempotency: "exactly-once-required",
      // No declaredIdempotencyKey — must still derive, just with the stricter policy.
    };

    const context = nodeIdempotencyContext(strictNode);
    expect(context.attemptPolicy).toBe("exactly-once-required");
    expect(context).not.toHaveProperty("declaredKey");

    const actual = nodeIdempotencyKey("run-strict", strictNode.id, context);

    const atLeastOnceGolden = materializeIdempotencyKey({
      sourceHash: "",
      runId: "run-strict",
      nodeId: strictNode.id,
      attemptPolicy: "at-least-once",
      input: { arguments: { amount: 100 } },
    });
    const exactlyOnceGolden = materializeIdempotencyKey({
      sourceHash: "",
      runId: "run-strict",
      nodeId: strictNode.id,
      attemptPolicy: "exactly-once-required",
      input: { arguments: { amount: 100 } },
    });

    expect(actual).toBe(exactlyOnceGolden);
    expect(actual).not.toBe(atLeastOnceGolden);
  });

  it("T6: a declared key can never collide with the derived key space for the same (runId, nodeId) — segment-2 literals are disjoint", () => {
    const runId = "run-disjoint";
    const nodeId = "node-disjoint";

    const declaredKey = nodeIdempotencyKey(runId, nodeId, {
      declaredKey: "same-logical-id",
    });
    const derivedKey = nodeIdempotencyKey(runId, nodeId, {
      input: { same: "logical-id" },
    });

    expect(declaredKey).not.toBe(derivedKey);

    // The declared space's 3rd colon-segment is always the literal "declared".
    const declaredSegments = declaredKey.split(":");
    expect(declaredSegments[2]).toBe("declared");

    // The derived space's 3rd colon-segment is the sourceHash (never the
    // literal "declared" — empty string when no flowDefinition is threaded,
    // or a hex digest when one is).
    const derivedSegments = derivedKey.split(":");
    expect(derivedSegments[2]).not.toBe("declared");

    // Even with a flowDefinition threaded (non-empty sourceHash), the derived
    // segment-2 still can't spell "declared" (it's a hex sha256 digest).
    const derivedWithSource = nodeIdempotencyKey(runId, nodeId, {
      flowDefinition: { id: "f", v: 1 },
      input: { same: "logical-id" },
    });
    expect(derivedWithSource.split(":")[2]).not.toBe("declared");
  });

  it("T7 (runtime half): a node carrying W1-lowered fields (declaredIdempotencyKey + idempotency) honors the declared key end-to-end via nodeIdempotencyContext + nodeIdempotencyKey", () => {
    // Simulates the shape lowerAction produces for an action WITH durability
    // decls (mirrors the flow-compiler T5/T7 lowering test's expected node).
    const loweredWithDecls: PipelineNode = {
      id: "w1-lowered",
      type: "tool",
      name: "tools.write",
      toolName: "tools.write",
      arguments: { id: 1 },
      declaredIdempotencyKey: "ticket-123",
      idempotency: "exactly-once-required",
      effectClass: "db_write",
    };

    const key = nodeIdempotencyKey(
      "run-roundtrip",
      loweredWithDecls.id,
      nodeIdempotencyContext(loweredWithDecls)
    );
    expect(key).toBe("dzup:v1:declared:ticket-123");

    // Simulates the shape lowerAction produces for an action WITHOUT any
    // durability decls — must be identical to the pre-W1 baseline: a node
    // with no declaredIdempotencyKey/idempotency/effectClass fields at all.
    const loweredWithoutDecls: PipelineNode = {
      id: "w1-lowered",
      type: "tool",
      name: "tools.write",
      toolName: "tools.write",
      arguments: { id: 1 },
    };
    const preW1Baseline: PipelineNode = {
      id: "w1-lowered",
      type: "tool",
      name: "tools.write",
      toolName: "tools.write",
      arguments: { id: 1 },
    };

    const keyWithoutDecls = nodeIdempotencyKey(
      "run-roundtrip",
      loweredWithoutDecls.id,
      nodeIdempotencyContext(loweredWithoutDecls)
    );
    const baselineKey = nodeIdempotencyKey(
      "run-roundtrip",
      preW1Baseline.id,
      nodeIdempotencyContext(preW1Baseline)
    );

    expect(keyWithoutDecls).toBe(baselineKey);
    expect(keyWithoutDecls).not.toBe(key);
  });
});
