/**
 * 24-G — terminal-outcome producers and the first reader.
 *
 * 24-F built a durable write path (`PipelineForEachItemFrame.outcome` /
 * `.economics`) and a corruption-rejection guard at the resume seam, but no
 * PRODUCER of any terminal value and no READER. Verified at `c3f01cc4`: the
 * only outcome any producer writes is `"running"`, at the single mid-body
 * boundary in `for-each-loop.ts`, and `isTerminalItemOutcome` has exactly one
 * call site (`stage-dispatch.ts`, inside the resume guard).
 *
 * Two consequences, both scoped to this packet:
 *
 *   - Doc 27 §8 proof 5 is discharged at the resume seam ONLY. Its terminal
 *     branches are reachable today via a hand-built or externally-authored
 *     checkpoint, never by a live run reaching a terminal exit.
 *   - Proof 8 (fail-fast terminal-set accounting) was not merely unwritten but
 *     unprovable: making unstarted items terminal requires a producer that
 *     records a terminal state per item, and none existed.
 *
 * TWO MECHANISMS ERASE TERMINAL FRAMES, which is why this is not "add four
 * writes". Both verified in code at `c3f01cc4`:
 *
 *   1. `for-each-loop.ts` gates its only frame write on
 *      `bodyIndex < bodyNodes.length - 1`, so the last body node never emits.
 *   2. `retainInFlightItemFrames` drops every frame with
 *      `itemIndex < completedIterations` at each item boundary.
 *
 * So a completed item leaves NO frame at all, and neither does a denied,
 * failed, or outcome-unknown one — each returns before any frame write. The
 * terminal set therefore needs a record that survives prefix retirement, which
 * is why these tests assert on a new `itemOutcomes` map rather than on
 * `itemFrames`. Keeping `itemFrames` strictly in-flight is deliberate: it is
 * what holds the three exact `toEqual({ iteration: n })` boundary pins green.
 *
 * Every test below was confirmed RED before the implementation, each for the
 * reason its name states — the 24-E lesson that a guard for an unreachable
 * defect is dead code that reads as protection.
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";
import type { LoopBudgetStrictHost } from "../pipeline/loop-executor.js";

/** A for_each loop whose body is three sequential nodes. */
function threeBodyForEachPipeline(failFast = true): PipelineDefinition {
  return {
    id: "for-each-terminal-outcomes",
    name: "ForEachTerminalOutcomes",
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
          failFast,
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

/** Executor that returns an ordinary body FAILURE for one named item. */
function failingExecutor(failOn?: {
  item: string;
  nodeId: string;
}): NodeExecutor {
  return async (nodeId: string, _node: PipelineNode, ctx) => {
    const item = ctx.state["item"] as { id: string };
    if (failOn && item.id === failOn.item && nodeId === failOn.nodeId) {
      return {
        nodeId,
        output: null,
        durationMs: 1,
        error: `body failure at ${item.id}/${nodeId}`,
      };
    }
    return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
  };
}

/** Host that admits every reservation. */
function admittingHost(reservedCostCents = 50) {
  const reserves: unknown[] = [];
  const settles: unknown[] = [];
  const releases: unknown[] = [];
  const config: LoopBudgetStrictHost = {
    mode: "strict",
    itemBudgetCents: 100,
    reserve: (input) => {
      reserves.push(input);
      return { status: "reserved", reservedCostCents };
    },
    settle: (input) => {
      settles.push(input);
    },
    release: (input) => {
      releases.push(input);
    },
    reconcile: () => ({ status: "unknown" }),
    measureItemCost: () => ({
      status: "known",
      costCents: reservedCostCents,
    }),
  };
  return {
    reserves,
    settles,
    releases,
    config,
  };
}

/** Host that DENIES the ceiling for one named item index. */
function denyingHost(denyIndex: number) {
  const reserves: unknown[] = [];
  const config: LoopBudgetStrictHost = {
    mode: "strict",
    itemBudgetCents: 100,
    reserve: (input) => {
      reserves.push(input);
      if (input.itemIndex === denyIndex) {
        return { status: "unknown" };
      }
      return { status: "reserved", reservedCostCents: 50 };
    },
    settle: () => {},
    release: () => {},
    reconcile: () => ({ status: "absent" }),
    measureItemCost: () => ({ status: "known", costCents: 50 }),
  };
  return {
    reserves,
    config,
  };
}

const THREE_ITEMS = [{ id: "a" }, { id: "b" }, { id: "c" }];

function outcomesOf(
  // `PipelineCheckpointStore.load` resolves `undefined` for an absent run, not
  // `null`. Accepting only `null` made every call site a type error while the
  // body — a `?.` chain — already handled both, so this widens the parameter
  // rather than casting at nine call sites.
  checkpoint:
    | { loopState?: Record<string, { itemOutcomes?: unknown }> }
    | null
    | undefined
): Record<string, { outcome: string; economics?: Record<string, unknown> }> {
  return (checkpoint?.loopState?.["loop-items"]?.itemOutcomes ?? {}) as Record<
    string,
    { outcome: string; economics?: Record<string, unknown> }
  >;
}

describe("24-G: for_each records a terminal outcome at every exit", () => {
  it("records `completed` with a settled cost when an item finishes", async () => {
    // Exit 3. The item completed and settled, but `retainInFlightItemFrames`
    // retires its frame at the item boundary, so before this packet a fully
    // successful item left NO durable trace of having reached a terminal
    // state at all — the strongest form of the missing-producer gap.
    const store = new InMemoryPipelineCheckpointStore();
    const host = admittingHost();
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: failingExecutor(),
      checkpointStore: store,
      loopIterationBudgetReservation: host.config,
    });

    const result = await runtime.execute({ items: THREE_ITEMS });
    expect(result.state).toBe("completed");

    const outcomes = outcomesOf(await store.load(result.runId));
    expect(Object.keys(outcomes).sort()).toEqual(["0", "1", "2"]);
    for (const index of ["0", "1", "2"]) {
      expect(outcomes[index]?.outcome).toBe("completed");
      // Economics must be TERMINAL, not merely reserved: settlement is the
      // fact that closes the ledger row, and recording only the reservation
      // would leave a completed item indistinguishable from a running one.
      expect(outcomes[index]?.economics).toMatchObject({
        reservedCostCents: 50,
        settledCostCents: 50,
      });
    }
  });

  it("records `failed` when a body node reports an error", async () => {
    // Exits 1/2. The release path reconciles the reservation, then returns —
    // recording nothing about WHY the item is gone.
    const store = new InMemoryPipelineCheckpointStore();
    const host = admittingHost();
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: failingExecutor({ item: "b", nodeId: "step-b" }),
      checkpointStore: store,
      loopIterationBudgetReservation: host.config,
    });

    const result = await runtime.execute({ items: THREE_ITEMS });
    expect(result.state).toBe("failed");

    const outcomes = outcomesOf(await store.load(result.runId));
    expect(outcomes["0"]?.outcome).toBe("completed");
    expect(outcomes["1"]?.outcome).toBe("failed");
  });

  it("records `denied` when an item's ceiling cannot be authorized", async () => {
    // Exit 0b. A denied item never dispatches, so it never writes a frame; the
    // loop fails closed with an error string and the item's terminal state is
    // knowable only by parsing that prose.
    const store = new InMemoryPipelineCheckpointStore();
    const host = denyingHost(1);
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: failingExecutor(),
      checkpointStore: store,
      loopIterationBudgetReservation: host.config,
    });

    const result = await runtime.execute({ items: THREE_ITEMS });
    expect(result.state).toBe("failed");

    const outcomes = outcomesOf(await store.load(result.runId));
    expect(outcomes["0"]?.outcome).toBe("completed");
    expect(outcomes["1"]?.outcome).toBe("denied");
    // A denied item took no reservation, so it must carry no economics —
    // recording a zero reservation would assert a ledger row that never
    // existed.
    expect(outcomes["1"]?.economics).toBeUndefined();
  });

  it("records `outcome_unknown` when a reservation cannot be reconciled", async () => {
    // Exit 0. The reserve threw and reconciliation could not prove the
    // reservation is gone, so money is outstanding in an unknown state. This
    // must NOT collapse into `failed`: `isTerminalItemOutcome` deliberately
    // excludes it, so accounting cannot close over it.
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: failingExecutor(),
      checkpointStore: store,
      loopIterationBudgetReservation: {
        mode: "strict",
        itemBudgetCents: 100,
        reserve: (input) => {
          if (input.itemIndex === 1) {
            throw new Error("transport died mid-reserve");
          }
          return { status: "reserved" as const, reservedCostCents: 50 };
        },
        settle: () => {},
        release: () => {},
        reconcile: () => ({ status: "unknown" as const }),
        measureItemCost: () => ({ status: "known" as const, costCents: 50 }),
      },
    });

    const result = await runtime.execute({ items: THREE_ITEMS });
    expect(result.state).toBe("failed");

    const outcomes = outcomesOf(await store.load(result.runId));
    expect(outcomes["1"]?.outcome).toBe("outcome_unknown");
  });
});

describe("24-G: proof 8 — the terminal set covers every index", () => {
  it("marks never-dispatched items `cancelled` when the loop stops early", async () => {
    // Doc 27 §8 proof 8. When `failFast` stops the worker loop, every item at
    // index >= nextIndex is never visited: no frame, no outcome, and
    // `iterationDurations` left undefined. Those items are ABSENT rather than
    // terminal, so "every index in 0..n-1 has a terminal outcome" — the
    // invariant fail-fast accounting rests on — is not assertable at all.
    const store = new InMemoryPipelineCheckpointStore();
    const host = admittingHost();
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(true),
      nodeExecutor: failingExecutor({ item: "a", nodeId: "step-a" }),
      checkpointStore: store,
      loopIterationBudgetReservation: host.config,
    });

    const result = await runtime.execute({ items: THREE_ITEMS });
    expect(result.state).toBe("failed");

    const outcomes = outcomesOf(await store.load(result.runId));
    expect(outcomes["0"]?.outcome).toBe("failed");
    // Items 1 and 2 were never dispatched. `cancelled` is the vocabulary for
    // "terminal for this run, but it never ran" — which is what completes the
    // terminal set.
    expect(outcomes["1"]?.outcome).toBe("cancelled");
    expect(outcomes["2"]?.outcome).toBe("cancelled");
    // A never-dispatched item took no reservation.
    expect(outcomes["1"]?.economics).toBeUndefined();
    expect(host.reserves).toHaveLength(1);
  });

  it("leaves no index without a terminal outcome on an early stop", async () => {
    // The set-completeness assertion itself, stated as an invariant rather
    // than per-index. This is what `LoopMetrics` cannot express today:
    // `completedIterations` counts entries in `iterationDurations`, which are
    // set for started-and-abandoned items too, so it is neither a completed
    // set nor a terminal set.
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(true),
      nodeExecutor: failingExecutor({ item: "b", nodeId: "step-a" }),
      checkpointStore: store,
      loopIterationBudgetReservation: admittingHost().config,
    });

    const result = await runtime.execute({ items: THREE_ITEMS });
    expect(result.state).toBe("failed");

    const outcomes = outcomesOf(await store.load(result.runId));
    for (let index = 0; index < THREE_ITEMS.length; index++) {
      expect(outcomes[String(index)]).toBeDefined();
    }
  });

  it("does not overwrite an earlier run's `completed` with `cancelled` on resume", async () => {
    // The `index < startIndex` half of the cancellation sweep, which the rest
    // of this lane leaves UNCOVERED: deleting that one line keeps all 151
    // other for_each tests green, so without this test the guard reads as
    // protection while being free to regress.
    //
    // The sweep runs over `0..n-1` and the runtime writer merges by index, so
    // on a resume every item behind the restored prefix would be re-swept —
    // rewriting a `completed` recorded by the previous run as `cancelled`.
    // That is strictly worse than the absent record 24-G set out to fix: it
    // does not lose the item's fate, it durably ASSERTS the wrong one, and an
    // operator reconciling the ledger would see settled work reported as
    // never having run.
    const store = new InMemoryPipelineCheckpointStore();
    const failingOnB = () => failingExecutor({ item: "b", nodeId: "step-a" });

    const first = new PipelineRuntime({
      definition: threeBodyForEachPipeline(true),
      nodeExecutor: failingOnB(),
      checkpointStore: store,
    });
    const firstResult = await first.execute({ items: THREE_ITEMS });
    expect(firstResult.state).toBe("failed");

    const checkpoint = await store.load(firstResult.runId);
    // Item 0 completed and is behind the ordered prefix; item 1 failed.
    expect(outcomesOf(checkpoint)["0"]?.outcome).toBe("completed");
    expect(checkpoint?.loopState?.["loop-items"]?.iteration).toBe(1);

    // Resume and fail item 1 again, so the sweep runs a second time with a
    // restored `startIndex` of 1.
    const second = new PipelineRuntime({
      definition: threeBodyForEachPipeline(true),
      nodeExecutor: failingOnB(),
      checkpointStore: store,
    });
    await second.resume(checkpoint!);

    const resumed = outcomesOf(await store.load(firstResult.runId));
    expect(resumed["0"]?.outcome).toBe("completed");
    expect(resumed["1"]?.outcome).toBe("failed");
  });
});

describe("24-G: out-of-order terminal evidence", () => {
  it("retains a completed item past the ordered prefix", async () => {
    // This is the durable seam consumed by the aggregate-receipt resume proof:
    // item 'd' (index 3) completes after item 'c' (index 2) fails, so the
    // ordered prefix stays at 2 while index 3 carries both a completed outcome
    // and its body-complete receipt. Resume must restore it, never redispatch.
    const store = new InMemoryPipelineCheckpointStore();
    const firstRuns: string[] = [];
    const first = new PipelineRuntime({
      definition: threeBodyForEachPipeline(false),
      nodeExecutor: async (nodeId, _node, ctx) => {
        const item = ctx.state["item"] as { id: string };
        firstRuns.push(item.id);
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
    });

    const firstResult = await first.execute({
      items: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    });
    expect(firstResult.state).toBe("failed");

    const checkpoint = await store.load(firstResult.runId);
    const outcomes = outcomesOf(checkpoint);
    // Index 2 failed; index 3 nonetheless completed, past the prefix.
    expect(outcomes["2"]?.outcome).toBe("failed");
    expect(outcomes["3"]?.outcome).toBe("completed");
    // The ordered-prefix cursor still stops at 2 — recording outcomes must not
    // move it.
    expect(checkpoint?.loopState?.["loop-items"]?.iteration).toBe(2);
  });
});
