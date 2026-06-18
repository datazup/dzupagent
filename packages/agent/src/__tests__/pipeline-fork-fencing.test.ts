/**
 * P2 — fork BRANCH-node lease/fence/replay-skip/heartbeat.
 *
 * The sequential path (`dispatchStandardNode`) already runs every node under
 * the durable ledger. Fork branch nodes used to call `config.nodeExecutor`
 * directly, bypassing the split-brain fencing guarantee. These tests pin the
 * branch path to the SAME ledger lifecycle as the sequential path:
 *
 *  1. each branch node acquires a lease and records a completion
 *  2. an already-completed branch node REPLAYS (skips re-execution)
 *  3. a fenced-out completion fails the branch (re-runs on resume) without
 *     aborting sibling branches
 *  4. with NO ledger the branch path is byte-for-byte unchanged
 *  5. the heartbeat interval is stopped on every branch-node exit (no leak)
 *
 * Mirrors `pipeline-fork-resume.test.ts`'s `forkPipeline()`:
 *   fork F -> branch a1 -> J(join), branch b1 -> J, J -> done.
 */
import { describe, it, expect, vi } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryDurableNodeLedger } from "@dzupagent/core";
import type { PipelineDefinition } from "@dzupagent/core";
import type {
  NodeExecutor,
  NodeLedgerLike,
  NodeLeaseLike,
} from "../pipeline/pipeline-runtime-types.js";
import { nodeIdempotencyKey } from "../pipeline/pipeline-runtime/idempotency.js";

function forkPipeline(): PipelineDefinition {
  return {
    id: "fork-fencing",
    name: "ForkFencing",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "F",
    checkpointStrategy: "after_each_node",
    nodes: [
      { id: "F", type: "fork", forkId: "fk1" },
      { id: "a1", type: "agent", agentId: "a", timeoutMs: 5000 },
      { id: "b1", type: "agent", agentId: "b", timeoutMs: 5000 },
      { id: "J", type: "join", forkId: "fk1" },
      { id: "done", type: "agent", agentId: "d", timeoutMs: 5000 },
    ],
    edges: [
      { type: "sequential", sourceNodeId: "F", targetNodeId: "a1" },
      { type: "sequential", sourceNodeId: "F", targetNodeId: "b1" },
      { type: "sequential", sourceNodeId: "a1", targetNodeId: "J" },
      { type: "sequential", sourceNodeId: "b1", targetNodeId: "J" },
      { type: "sequential", sourceNodeId: "J", targetNodeId: "done" },
    ],
  } as PipelineDefinition;
}

describe("fork branch-node fencing (P2)", () => {
  it("leases each branch node and records a completion in the ledger", async () => {
    const ledger = new InMemoryDurableNodeLedger();
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      ctx.state[`ran_${nodeId}`] = true;
      return { nodeId, output: `out_${nodeId}`, durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: forkPipeline(),
      nodeExecutor: executor,
      nodeLedger: ledger,
    });

    const result = await runtime.execute();
    expect(result.state).toBe("completed");

    // Each branch node has a completed ledger entry queryable for replay.
    const a1 = await ledger.getByIdempotencyKey(
      nodeIdempotencyKey(result.runId, "a1")
    );
    const b1 = await ledger.getByIdempotencyKey(
      nodeIdempotencyKey(result.runId, "b1")
    );
    expect(a1?.output).toBe("out_a1");
    expect(b1?.output).toBe("out_b1");
  });

  it("replays an already-completed branch node without re-executing it", async () => {
    const base = new InMemoryDurableNodeLedger();

    // The runtime generates its own runId, so we cannot pre-seed a fixed key.
    // Instead, wrap the ledger so any key whose nodeId segment is `a1` reports a
    // prior completion — exactly what the runtime sees when a1 already ran in an
    // earlier attempt. The canonical key embeds nodeId as a delimited
    // `:{nodeId}:` segment, so match that rather than a suffix.
    const ledger: NodeLedgerLike = {
      acquire: (...args) => base.acquire(...args),
      heartbeat: (...args) => base.heartbeat(...args),
      fail: (record) => base.fail(record),
      complete: (record) => base.complete(record),
      getByIdempotencyKey: async (k) => {
        if (k.includes(":a1:")) return { output: "preseeded_a1" };
        return base.getByIdempotencyKey(k);
      },
    };

    const calls: Record<string, number> = {};
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      calls[nodeId] = (calls[nodeId] ?? 0) + 1;
      ctx.state[`ran_${nodeId}`] = true;
      return { nodeId, output: `out_${nodeId}`, durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: forkPipeline(),
      nodeExecutor: executor,
      nodeLedger: ledger,
    });

    const result = await runtime.execute();
    expect(result.state).toBe("completed");

    // a1 replayed (executor NOT called); b1 ran normally.
    expect(calls["a1"]).toBeUndefined();
    expect(calls["b1"]).toBe(1);

    // a1's result in the run equals the pre-seeded ledger output.
    expect(result.nodeResults.get("a1")?.output).toBe("preseeded_a1");
    expect(result.nodeResults.get("b1")?.output).toBe("out_b1");
  });

  it("treats a fenced-out branch completion as a branch error, leaving siblings intact", async () => {
    const base = new InMemoryDurableNodeLedger();

    // Wrapper that delegates to a real ledger but makes `complete` for a1
    // throw a FencedOutError ONCE (a newer lease superseded us mid-exec).
    class FencedOutError extends Error {
      constructor() {
        super("fenced out");
        this.name = "FencedOutError";
      }
    }
    let a1Fenced = false;
    const ledger: NodeLedgerLike = {
      acquire: (...args) => base.acquire(...args),
      heartbeat: (...args) => base.heartbeat(...args),
      getByIdempotencyKey: (k) => base.getByIdempotencyKey(k),
      fail: (record) => base.fail(record),
      complete: async (record) => {
        if (record.nodeId === "a1" && !a1Fenced) {
          a1Fenced = true;
          throw new FencedOutError();
        }
        return base.complete(record);
      },
    };

    const calls: Record<string, number> = {};
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      calls[nodeId] = (calls[nodeId] ?? 0) + 1;
      ctx.state[`ran_${nodeId}`] = true;
      return { nodeId, output: `out_${nodeId}`, durationMs: 1 };
    };

    const events: Array<{ type: string; nodeId?: string }> = [];
    const runtime = new PipelineRuntime({
      definition: forkPipeline(),
      nodeExecutor: executor,
      nodeLedger: ledger,
      onEvent: (e) =>
        events.push(e as unknown as { type: string; nodeId?: string }),
    });

    const result = await runtime.execute();

    // a1 was fenced out → its completion is NOT recorded in the real ledger
    // (the branch is treated as failed and re-runs on resume).
    const a1Recorded = await base.getByIdempotencyKey(
      nodeIdempotencyKey(result.runId, "a1")
    );
    expect(a1Recorded).toBeUndefined();

    // The sibling branch b1 still completes and is recorded.
    const b1Recorded = await base.getByIdempotencyKey(
      nodeIdempotencyKey(result.runId, "b1")
    );
    expect(b1Recorded?.output).toBe("out_b1");

    // a1 emitted a node_failed; b1 emitted a node_completed.
    expect(
      events.some((e) => e.type === "pipeline:node_failed" && e.nodeId === "a1")
    ).toBe(true);
    expect(
      events.some(
        (e) => e.type === "pipeline:node_completed" && e.nodeId === "b1"
      )
    ).toBe(true);
  });

  it("with NO ledger the branch path is unchanged (executor once per branch node)", async () => {
    const calls: Record<string, number> = {};
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      calls[nodeId] = (calls[nodeId] ?? 0) + 1;
      ctx.state[`ran_${nodeId}`] = true;
      return { nodeId, output: `out_${nodeId}`, durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: forkPipeline(),
      nodeExecutor: executor,
      // no nodeLedger
    });

    const result = await runtime.execute();
    expect(result.state).toBe("completed");

    // Both branch nodes executed exactly once and merged their outputs.
    expect(calls["a1"]).toBe(1);
    expect(calls["b1"]).toBe(1);
    expect(result.nodeResults.get("a1")?.output).toBe("out_a1");
    expect(result.nodeResults.get("b1")?.output).toBe("out_b1");
  });

  it("stops the per-branch heartbeat — no lease renewals after the run finishes", async () => {
    vi.useFakeTimers();
    try {
      const base = new InMemoryDurableNodeLedger();
      const heartbeat = vi.fn(
        (...args: Parameters<NodeLedgerLike["heartbeat"]>) =>
          base.heartbeat(...args)
      );
      const ledger: NodeLedgerLike = {
        acquire: (...args) => base.acquire(...args),
        heartbeat,
        getByIdempotencyKey: (k) => base.getByIdempotencyKey(k),
        fail: (record) => base.fail(record),
        complete: (record) => base.complete(record),
      };

      const executor: NodeExecutor = async (nodeId, _node, ctx) => {
        ctx.state[`ran_${nodeId}`] = true;
        return { nodeId, output: `out_${nodeId}`, durationMs: 1 };
      };

      const runtime = new PipelineRuntime({
        definition: forkPipeline(),
        nodeExecutor: executor,
        nodeLedger: ledger,
      });

      const result = await runtime.execute();
      expect(result.state).toBe("completed");

      // The run finished fast (each node resolves immediately), so heartbeats
      // should not have fired during execution; crucially, after stop() no
      // further renewals leak when timers advance.
      const before = heartbeat.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(heartbeat.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
