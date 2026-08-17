/**
 * 24-H — a terminally-SETTLED item must not be re-dispatched on resume.
 *
 * This packet replaces the one its predecessor's handoff proposed. That handoff
 * argued the uncovered case was an out-of-order completion being fully re-run
 * and leaving a hole in the aggregate (`[a, b, c, undefined]`), to be fixed by
 * a durable per-item OUTPUT record. Instrumenting the seam at `a2e79f35`
 * disproved both halves:
 *
 *   - The item is NOT fully re-run. `retainInFlightItemFrames` keeps every
 *     frame with `itemIndex >= completedIterations`, so an item that completed
 *     PAST the ordered prefix keeps its frame, and the resume re-enters it at
 *     its retained `nextBodyNodeIndex` rather than at body node 0.
 *   - The aggregate has NO hole. The re-entered item recomputes its collected
 *     value and the ordered-prefix merge places it correctly; the final
 *     aggregate is `["a", "b", "c", "d"]`.
 *
 * So an output record would have been dead weight — the third packet running in
 * which a proposed guard turned out to be subsumed by machinery already there.
 *
 * THE REAL DEFECT, which that framing hid, is economic rather than structural.
 * An item that completed out of order was SETTLED in the first run. On resume
 * it is dispatched again, reserves again, and settles AGAIN:
 *
 *     run 1: settle resv:v1:<run>:item:loop-items:3            50 cents
 *     run 2: settle resv:v1:<run>:item:loop-items:3:attempt:1  50 cents
 *
 * The two reservation ids DIFFER — 24-F advances `attempt` whenever a resumed
 * frame carries economics, precisely so a replay is distinguishable — so a host
 * treating the id as an idempotency key cannot collapse them. One item's work is
 * charged twice, and `itemOutcomes` durably recorded `completed` for that index
 * before the second charge was made.
 *
 * That record is the fix. 24-G shipped the terminal set with no reader at all;
 * this is its first real consumer, and unlike the reader 24-G built and deleted,
 * this one is NOT subsumed by the ordered-prefix cursor: the cursor stops at the
 * prefix (2), while the item needing protection sits past it (3).
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type { PipelineDefinition } from "@dzupagent/core";

/**
 * A for_each loop whose body is three sequential nodes, with `failFast` off so
 * a later item keeps running after an earlier one fails — the only way to reach
 * an out-of-order completion at `concurrency: 1`.
 *
 * 24-I: N>1 now offers a second route to out-of-order completion, but this
 * fixture deliberately stays at 1. A failure-driven gap is deterministic; a
 * scheduling-driven one is not, and the assertions here name exact item
 * indices. Kept sequential on purpose, not by omission.
 */
function threeBodyForEachPipeline(): PipelineDefinition {
  return {
    id: "for-each-settled-redispatch",
    name: "ForEachSettledRedispatch",
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
          failFast: false,
          // `order` is required and admits only "input"; omitting it built a
          // definition the serialization schema would have rejected.
          collect: { from: "$.item.id", into: "$.gathered", order: "input" },
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

interface SettlementRecord {
  itemIndex: number;
  reservationId: string;
  actualCostCents: number;
}

/** Host that admits every reservation and records each lifecycle call. */
function recordingHost() {
  const reserves: Array<{ itemIndex: number; reservationId: string }> = [];
  const settles: SettlementRecord[] = [];
  const releases: Array<{ itemIndex: number }> = [];
  return {
    reserves,
    settles,
    releases,
    config: {
      itemBudgetCents: 100,
      reserve: (input: Record<string, unknown>) => {
        reserves.push({
          itemIndex: input["itemIndex"] as number,
          reservationId: input["reservationId"] as string,
        });
        return { status: "reserved" as const, reservedCostCents: 50 };
      },
      settle: (input: Record<string, unknown>) => {
        settles.push({
          itemIndex: input["itemIndex"] as number,
          reservationId: input["reservationId"] as string,
          actualCostCents: input["actualCostCents"] as number,
        });
      },
      release: (input: Record<string, unknown>) => {
        releases.push({ itemIndex: input["itemIndex"] as number });
      },
    },
  };
}

const ITEMS = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

/**
 * Drive a run to the out-of-order state: item 2 ('c') fails at its first body
 * node while item 3 ('d') runs to completion behind it, so the ordered prefix
 * stops at 2 and index 3 is durably `completed` past it.
 */
async function runToOutOfOrderCompletion(
  store: InMemoryPipelineCheckpointStore
) {
  const host = recordingHost();
  const runs: string[] = [];
  const runtime = new PipelineRuntime({
    definition: threeBodyForEachPipeline(),
    nodeExecutor: async (nodeId, _node, ctx) => {
      const item = ctx.state["item"] as { id: string };
      runs.push(`${item.id}:${nodeId}`);
      if (item.id === "c" && nodeId === "step-a") {
        return {
          nodeId,
          output: null,
          durationMs: 1,
          error: "body failure at c/step-a",
        };
      }
      return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
    },
    checkpointStore: store,
    loopIterationBudgetReservation: host.config,
  });
  const result = await runtime.execute({ items: ITEMS });
  return { host, runs, result };
}

describe("24-H: an item settled past the ordered prefix", () => {
  it("is recorded `completed` with a settled cost while the cursor stays behind it", async () => {
    // The precondition the rest of this file depends on. Asserted separately so
    // that if the seam ever stops producing an out-of-order completion, the
    // failure names THAT rather than surfacing as a confusing settlement count.
    const store = new InMemoryPipelineCheckpointStore();
    const { host, result } = await runToOutOfOrderCompletion(store);
    expect(result.state).toBe("failed");

    const checkpoint = await store.load(result.runId);
    const loopState = checkpoint?.loopState?.["loop-items"];
    const outcomes = (loopState?.itemOutcomes ?? {}) as Record<
      string,
      { outcome: string; economics?: { settledCostCents?: number } }
    >;

    expect(outcomes["2"]?.outcome).toBe("failed");
    expect(outcomes["3"]?.outcome).toBe("completed");
    // Settled, not merely reserved: this is what makes a second charge a
    // DOUBLE charge rather than a first one.
    expect(outcomes["3"]?.economics?.settledCostCents).toBe(50);
    // The ordered prefix stops at 2, so index 3 sits past it and the resume
    // cursor alone cannot protect it — the reason 24-G's deleted reader does
    // not cover this case.
    expect(loopState?.iteration).toBe(2);
    expect(host.settles.filter((s) => s.itemIndex === 3)).toHaveLength(1);
  });

  it("is not settled a second time when the run resumes", async () => {
    // THE DEFECT. Before this packet the resumed run re-dispatched index 3,
    // re-reserved it under an `:attempt:1` id, and settled it again — charging
    // 100 cents for one item's work, with the two ids different enough that no
    // host-side idempotency key can collapse them.
    const store = new InMemoryPipelineCheckpointStore();
    const first = await runToOutOfOrderCompletion(store);
    expect(first.result.state).toBe("failed");
    expect(first.host.settles.filter((s) => s.itemIndex === 3)).toHaveLength(1);

    const secondHost = recordingHost();
    const secondRuns: string[] = [];
    const resumed = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: async (nodeId, _node, ctx) => {
        const item = ctx.state["item"] as { id: string };
        secondRuns.push(`${item.id}:${nodeId}`);
        return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
      },
      checkpointStore: store,
      loopIterationBudgetReservation: secondHost.config,
    });
    const checkpoint = await store.load(first.result.runId);
    const done = await resumed.resume(checkpoint!);
    expect(done.state).toBe("completed");

    // The already-settled item must neither reserve nor settle again.
    expect(secondHost.settles.filter((s) => s.itemIndex === 3)).toHaveLength(0);
    expect(secondHost.reserves.filter((r) => r.itemIndex === 3)).toHaveLength(
      0
    );
    // Item 2 is the one that genuinely still owes work, and must be unaffected.
    expect(secondHost.settles.filter((s) => s.itemIndex === 2)).toHaveLength(1);
    // Totalled across both runs, each item's work is charged exactly once.
    const allSettles = [...first.host.settles, ...secondHost.settles];
    for (const index of [0, 1, 2, 3]) {
      expect(allSettles.filter((s) => s.itemIndex === index)).toHaveLength(1);
    }
  });

  it("does not re-execute the settled item's body nodes on resume", async () => {
    // The side-effect half of the same defect. The item's frame survives prefix
    // retirement, so the resume re-entered it at its retained
    // `nextBodyNodeIndex` and re-ran its LAST body node — committing that
    // node's side effect a second time for work already paid for.
    const store = new InMemoryPipelineCheckpointStore();
    const first = await runToOutOfOrderCompletion(store);
    expect(first.result.state).toBe("failed");

    const secondRuns: string[] = [];
    const resumed = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: async (nodeId, _node, ctx) => {
        const item = ctx.state["item"] as { id: string };
        secondRuns.push(`${item.id}:${nodeId}`);
        return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
      },
      checkpointStore: store,
      loopIterationBudgetReservation: recordingHost().config,
    });
    const checkpoint = await store.load(first.result.runId);
    await resumed.resume(checkpoint!);

    expect(secondRuns.filter((entry) => entry.startsWith("d:"))).toEqual([]);
  });

  it("still aggregates the settled item's collected value in source order", async () => {
    // The constraint that makes the skip SAFE, and the reason a naive skip was
    // rejected in 24-G. Skipping an item whose value were unrecoverable would
    // turn `[a, b, c, d]` into `[a, b, c, undefined]`. It is recoverable: the
    // item's collected value is restored from its retained frame, so skipping
    // costs nothing. Asserted end-to-end because this is exactly the hole the
    // superseded handoff predicted and this packet must prove absent.
    const store = new InMemoryPipelineCheckpointStore();
    const first = await runToOutOfOrderCompletion(store);

    const resumed = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: async (nodeId, _node, ctx) => {
        const item = ctx.state["item"] as { id: string };
        return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
      },
      checkpointStore: store,
      loopIterationBudgetReservation: recordingHost().config,
    });
    const checkpoint = await store.load(first.result.runId);
    const done = await resumed.resume(checkpoint!);
    expect(done.state).toBe("completed");

    const final = await store.load(first.result.runId);
    expect(final?.state?.["gathered"]).toEqual(["a", "b", "c", "d"]);
  });
});
