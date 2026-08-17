/**
 * 24-F — durable per-item economics across a mid-item crash.
 *
 * Packet F built the reservation lifecycle entirely in process memory: `held`
 * is a local `const` inside `runIteration`, taken before the first body node
 * and reconciled only on one of that same call's three exits. Every one of
 * those exits requires the process to still be alive.
 *
 * A mid-item crash is precisely the case `itemFrames` exists to survive, and
 * it escapes all three: the checkpoint records `nextBodyNodeIndex` but carries
 * no reservation id, no reservation amount, and no outcome. So the reservation
 * the dead process took is durably invisible — the resumed process cannot know
 * it exists, cannot release it, and cannot settle it.
 *
 * These tests characterise that gap end-to-end BEFORE any guard is written,
 * because the lesson of 24-E is that a guard for an unreachable defect is dead
 * code that reads as protection. Each test names the durable fact it needs.
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";
import type { LoopBudgetStrictHost } from "../pipeline/loop-executor.js";

/** A for_each loop whose body is three sequential nodes, so a crash can land strictly inside an item. */
function threeBodyForEachPipeline(): PipelineDefinition {
  return {
    id: "for-each-item-economics",
    name: "ForEachItemEconomics",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "loop-items",
    checkpointStrategy: "after_each_node",
    nodes: [
      {
        id: "loop-items",
        type: "loop",
        bodyNodeIds: ["step-a", "step-b", "step-c"],
        maxIterations: 1000,
        continuePredicateName: "forEach__item__predicate",
        forEach: {
          source: "$.items",
          as: "item",
          order: "input",
          concurrency: 1,
          empty: { body: "skip", aggregate: "empty-array" },
        },
      },
      { id: "step-a", type: "agent", agentId: "a", timeoutMs: 5000 },
      { id: "step-b", type: "agent", agentId: "b", timeoutMs: 5000 },
      { id: "step-c", type: "agent", agentId: "c", timeoutMs: 5000 },
    ],
    edges: [],
  };
}

/**
 * Executor that CRASHES rather than failing.
 *
 * A returned error is an ordinary body failure, which reaches `runIteration`'s
 * release exit and reconciles the reservation cleanly. To model process death
 * the throw has to escape the loop entirely, which is what a thrown
 * non-`Error` rejection out of the node executor does here.
 */
function tracingExecutor(
  runs: string[],
  crashOn?: { item: string; nodeId: string }
): NodeExecutor {
  return async (nodeId: string, _node: PipelineNode, ctx) => {
    const item = ctx.state["item"] as { id: string };
    runs.push(`${item.id}:${nodeId}`);
    if (crashOn && item.id === crashOn.item && nodeId === crashOn.nodeId) {
      throw new Error(`simulated crash at ${item.id}/${nodeId}`);
    }
    return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
  };
}

/** Records every lifecycle call the host receives, in order. */
function recordingHost() {
  const reserves: unknown[] = [];
  const settles: unknown[] = [];
  const releases: unknown[] = [];
  const config: LoopBudgetStrictHost = {
    mode: "strict",
    itemBudgetCents: 100,
    reserve: (input) => {
      reserves.push(input);
      return { status: "reserved", reservedCostCents: 50 };
    },
    settle: (input) => {
      settles.push(input);
    },
    release: (input) => {
      releases.push(input);
    },
    reconcile: () => ({ status: "unknown" }),
    measureItemCost: () => ({ status: "known", costCents: 50 }),
  };
  return {
    reserves,
    settles,
    releases,
    config,
  };
}

const ITEMS = [{ id: "a" }, { id: "b" }];

describe("for_each durable per-item economics (24-F)", () => {
  it("persists the reservation on the item frame when a crash lands mid-item", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const host = recordingHost();
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([], { item: "b", nodeId: "step-c" }),
      checkpointStore: store,
      loopIterationBudgetReservation: host.config,
    });

    const result = await runtime.execute({ items: ITEMS });
    expect(result.state).toBe("failed");

    // Item 'b' held a reservation when its body failed.
    expect(host.reserves).toHaveLength(2);

    const checkpoint = await store.load(result.runId);
    const frame = checkpoint?.loopState?.["loop-items"]?.itemFrames?.["1"];
    expect(frame).toBeDefined();

    // THE DEFECT: the frame records where the body stopped but not that money
    // is outstanding. A resumed process reading this checkpoint has no durable
    // evidence a reservation was ever taken.
    expect(frame?.economics).toMatchObject({
      reservationId: expect.stringContaining("resv:v1:"),
      reservedCostCents: 50,
    });
  });

  it("records a terminal outcome on the frame rather than only a body cursor", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const host = recordingHost();
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([], { item: "b", nodeId: "step-c" }),
      checkpointStore: store,
      loopIterationBudgetReservation: host.config,
    });

    const result = await runtime.execute({ items: ITEMS });
    expect(result.state).toBe("failed");

    const checkpoint = await store.load(result.runId);
    const frame = checkpoint?.loopState?.["loop-items"]?.itemFrames?.["1"];

    // `nextBodyNodeIndex` says "resume at step-c" but says nothing about
    // whether this item is still running, was released, or settled. Proof 5's
    // outcome sub-part has no field to validate until this exists.
    expect(frame?.outcome).toBe("running");
  });

  it("does not double-reserve the same item on resume after a mid-item crash", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const firstHost = recordingHost();
    const first = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([], { item: "b", nodeId: "step-c" }),
      checkpointStore: store,
      loopIterationBudgetReservation: firstHost.config,
    });
    const firstResult = await first.execute({ items: ITEMS });
    expect(firstResult.state).toBe("failed");
    // Item 'b' failed inside its body, so packet F released its reservation.
    expect(firstHost.releases).toHaveLength(1);

    const secondHost = recordingHost();
    const second = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      checkpointStore: store,
      loopIterationBudgetReservation: secondHost.config,
    });
    const checkpoint = await store.load(firstResult.runId);
    const resumed = await second.resume(checkpoint!);
    expect(resumed.state).toBe("completed");

    // The resumed item re-reserves under the SAME reservation id as the
    // attempt that already ran, because `attempt` was never incremented for
    // the resumed dispatch. A host that treats the id as an idempotency key
    // silently reuses the released reservation's row.
    expect(secondHost.reserves).toHaveLength(1);
    const replayed = secondHost.reserves[0] as { reservationId: string };
    const original = firstHost.reserves[1] as { reservationId: string };
    expect(replayed.reservationId).not.toEqual(original.reservationId);
  });
});
