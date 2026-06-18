/**
 * W4 — durable fork/branch resume.
 *
 * Verifies that completed fork branches are checkpointed and, on resume from a
 * mid-fork checkpoint (the on-disk state a process crash would leave between
 * two branch checkpoints), completed branches are NOT re-run — only unfinished
 * branches re-execute — and that branch node contexts carry a stable
 * idempotency key (W5 fork gap).
 */
import { describe, it, expect } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type { PipelineDefinition, PipelineCheckpoint } from "@dzupagent/core";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";
import { nodeIdempotencyKey } from "../pipeline/pipeline-runtime/idempotency.js";

/**
 * Pipeline: entry `F` (fork) fans out to two branches:
 *   branch A: a1  -> J (join)
 *   branch B: b1  -> J (join)
 * then `J` -> `done`. Each branch node writes a marker into state.
 *
 * NOTE the edge shape: { type: "sequential", sourceNodeId, targetNodeId }.
 */
function forkPipeline(): PipelineDefinition {
  return {
    id: "fork-resume",
    name: "ForkResume",
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

/**
 * Find the first checkpoint version that recorded branch `a1` as a completed
 * fork branch but NOT `b1` — the exact on-disk state a process crash between
 * the two branch checkpoints would leave behind.
 */
async function midForkCheckpoint(
  store: InMemoryPipelineCheckpointStore,
  runId: string
): Promise<PipelineCheckpoint> {
  const versions = await store.listVersions(runId);
  for (const summary of versions) {
    const cp = await store.loadVersion(runId, summary.version);
    const branches = cp?.forkState?.["fk1"]?.branches;
    if (branches?.["a1"] && !branches?.["b1"]) return cp!;
  }
  throw new Error(
    "no mid-fork checkpoint with a1 done and b1 pending was recorded"
  );
}

describe("durable fork/branch resume (W4)", () => {
  it("checkpoints each completed branch and exposes a branch idempotency key", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const keysSeen: Record<string, string | undefined> = {};
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      keysSeen[nodeId] = ctx.idempotencyKey;
      ctx.state[`ran_${nodeId}`] = true;
      return { nodeId, output: nodeId, durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: forkPipeline(),
      nodeExecutor: executor,
      checkpointStore: store,
    });

    const result = await runtime.execute();
    expect(result.state).toBe("completed");

    // Branch nodes received the canonical stable key for their (runId, nodeId)
    // (W5 fork gap closed).
    expect(keysSeen["a1"]).toBe(nodeIdempotencyKey(result.runId, "a1"));
    expect(keysSeen["b1"]).toBe(nodeIdempotencyKey(result.runId, "b1"));

    // forkState cleared once the fork+join completed.
    const finalCheckpoint = await store.load(result.runId);
    expect(finalCheckpoint?.forkState?.["fk1"]).toBeUndefined();

    // But an intermediate version recorded one branch before the other.
    const mid = await midForkCheckpoint(store, result.runId);
    expect(mid.forkState?.["fk1"]?.branches?.["a1"]).toBeDefined();
    expect(mid.forkState?.["fk1"]?.branches?.["b1"]).toBeUndefined();
  });

  it("resumes a mid-fork checkpoint without re-running the completed branch", async () => {
    const store = new InMemoryPipelineCheckpointStore();

    // Healthy first run — produces per-branch checkpoints we can rewind into.
    const firstExecutor: NodeExecutor = async (nodeId, _node, ctx) => {
      ctx.state[`ran_${nodeId}`] = true;
      return { nodeId, output: nodeId, durationMs: 1 };
    };
    const first = new PipelineRuntime({
      definition: forkPipeline(),
      nodeExecutor: firstExecutor,
      checkpointStore: store,
    });
    const firstResult = await first.execute();
    expect(firstResult.state).toBe("completed");

    // Recover the mid-fork checkpoint: a1 recorded, b1 not yet — the state a
    // crash between the two branch checkpoints would have persisted.
    const checkpoint = await midForkCheckpoint(store, firstResult.runId);

    // Resume from that checkpoint with a tracking executor; a1 must NOT re-run.
    const resumeRuns: string[] = [];
    const healthyExecutor: NodeExecutor = async (nodeId, _node, ctx) => {
      resumeRuns.push(nodeId);
      ctx.state[`ran_${nodeId}`] = true;
      return { nodeId, output: nodeId, durationMs: 1 };
    };
    const second = new PipelineRuntime({
      definition: forkPipeline(),
      nodeExecutor: healthyExecutor,
      checkpointStore: store,
    });

    const resumed = await second.resume(checkpoint);
    expect(resumed.state).toBe("completed");

    // a1 restored (not re-run); b1 re-ran; the run finished past the join.
    expect(resumeRuns).not.toContain("a1");
    expect(resumeRuns).toContain("b1");
  });

  it("does NOT persist a branch whose node returned an error (failed branch re-runs on resume)", async () => {
    // A node that returns `{ error }` (rather than throwing) breaks its branch
    // early. Spec §4: such a failed branch must NOT be recorded in forkState,
    // so on resume it re-runs rather than being restored.
    const store = new InMemoryPipelineCheckpointStore();
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      if (nodeId === "b1") {
        // Errored result (not a throw) — branch breaks but settles fulfilled.
        return { nodeId, output: null, durationMs: 1, error: "b1 failed" };
      }
      ctx.state[`ran_${nodeId}`] = true;
      return { nodeId, output: nodeId, durationMs: 1 };
    };
    const runtime = new PipelineRuntime({
      definition: forkPipeline(),
      nodeExecutor: executor,
      checkpointStore: store,
    });

    const result = await runtime.execute();

    // No checkpoint version ever records the errored branch b1 in forkState;
    // the successful branch a1 IS recorded. This is the exact guarantee that a
    // failed branch is re-run (not restored) on resume.
    const versions = await store.listVersions(result.runId);
    let sawA1 = false;
    for (const summary of versions) {
      const cp = await store.loadVersion(result.runId, summary.version);
      const branches = cp?.forkState?.["fk1"]?.branches;
      if (branches?.["a1"]) sawA1 = true;
      expect(branches?.["b1"]).toBeUndefined();
    }
    expect(sawA1).toBe(true);
  });

  it("round-trips a recorded branch's nodeResults + stateDelta through the checkpoint store", async () => {
    // The mid-fork checkpoint must survive a save -> load cycle losslessly so
    // resume can restore the completed branch's output and state delta.
    const store = new InMemoryPipelineCheckpointStore();
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      ctx.state[`ran_${nodeId}`] = true;
      return { nodeId, output: `out_${nodeId}`, durationMs: 1 };
    };
    const runtime = new PipelineRuntime({
      definition: forkPipeline(),
      nodeExecutor: executor,
      checkpointStore: store,
    });
    const result = await runtime.execute();

    const mid = await midForkCheckpoint(store, result.runId);
    const a1 = mid.forkState?.["fk1"]?.branches?.["a1"];
    expect(a1).toBeDefined();
    // The recorded branch carries its node's serialized result + state delta.
    expect(
      (a1!.nodeResults as Record<string, { output?: unknown }>)["a1"]?.output
    ).toBe("out_a1");
    expect(a1!.stateDelta).toMatchObject({ ran_a1: true });

    // Re-load the same version: the forkState entry is identical (lossless).
    const reloaded = await store.loadVersion(result.runId, mid.version);
    expect(reloaded?.forkState?.["fk1"]?.branches?.["a1"]).toEqual(a1);
  });
});
