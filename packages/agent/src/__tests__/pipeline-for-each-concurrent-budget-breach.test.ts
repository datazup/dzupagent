/**
 * 24-I — a budget breach must stop items that are ALREADY IN FLIGHT.
 *
 * Before this packet `budgetBreached` was a plain flag read by the worker loop
 * between items. The source said, in a comment, exactly why that was safe and
 * exactly when it would stop being safe:
 *
 *   "this flag is read by the worker loop BETWEEN items, which stops dispatch
 *    exactly because `concurrency` is pinned to 1 above — one worker, no item
 *    in flight when the check runs. At concurrency > 1 that is no longer
 *    sufficient: up to N-1 items would already be mid-flight with reservations
 *    outstanding and would settle spend past the breach."
 *
 * The comment described an internal `AbortController` composed with
 * `context.signal` as the fix. Nothing implemented it — the only occurrence of
 * `AbortController` in the file was inside that comment. This suite is the
 * killing test for the implementation that replaced it.
 *
 * Why an AbortController rather than merging into `context.signal`: three
 * sites classify an item's terminal outcome by reading
 * `context.signal?.aborted`. Routing a breach through the host signal would
 * relabel every breached run as a host cancellation and destroy the
 * distinction 24-G's terminal set exists to record.
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

function forEachPipeline(concurrency: number): PipelineDefinition {
  return {
    id: "for-each-concurrent-budget-breach",
    name: "ForEachConcurrentBudgetBreach",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "loop-items",
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
          concurrency,
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

const ITEMS = [{ id: "a" }, { id: "b" }];

/** Resolves once, on demand. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

describe("24-I — a budget breach halts in-flight for_each items", () => {
  it("stops an in-flight item's remaining body nodes when another item is denied", async () => {
    // The rendezvous: item 'a' parks inside its FIRST body node until item 'b'
    // has been denied its reservation. So at the instant the breach is raised,
    // 'a' is genuinely mid-flight with two body nodes still to run and a
    // reservation outstanding — the precise state the old between-items check
    // could not see.
    const itemBDenied = deferred();
    const bodyRuns: string[] = [];
    const settled: number[] = [];
    const released: number[] = [];

    const executor: NodeExecutor = async (
      nodeId: string,
      _node: PipelineNode,
      ctx
    ) => {
      const item = ctx.state["item"] as { id: string };
      bodyRuns.push(`${item.id}:${nodeId}`);
      if (item.id === "a" && nodeId === "step-a") {
        await itemBDenied.promise;
      }
      return { nodeId, output: "ok", durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: forEachPipeline(2),
      nodeExecutor: executor,
      loopIterationBudgetReservation: {
        mode: "strict",
        itemBudgetCents: 100,
        // The parameter types are INFERRED from the host-config contract rather
        // than re-declared narrowly: an explicit `{ itemIndex: number }` is not
        // assignable to the contract's wider input and made this mock a type
        // error. `itemIndex` is optional there, hence the `?? -1` below.
        reserve: (input) => {
          // Item 1 ('b') cannot be afforded: this is the breach. `unknown` is
          // the contract's denial status — `denied` is a runtime CLASSIFICATION
          // derived in `for-each-loop.ts`, never a value a host may return.
          if (input.itemIndex === 1) {
            itemBDenied.release();
            return { status: "unknown" as const };
          }
          return { status: "reserved" as const, reservedCostCents: 50 };
        },
        settle: (input) => {
          settled.push(input.itemIndex ?? -1);
        },
        release: (input) => {
          released.push(input.itemIndex ?? -1);
        },
        reconcile: () => ({ status: "unknown" as const }),
        measureItemCost: () => ({ status: "known" as const, costCents: 50 }),
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");

    // THE PROOF. Item 'a' was inside step-a when the breach landed. It must
    // not have gone on to run step-b and step-c. Without the abort
    // propagation it runs all three and settles a full item's spend after the
    // ceiling was already breached.
    expect(bodyRuns).toContain("a:step-a");
    expect(bodyRuns).not.toContain("a:step-b");
    expect(bodyRuns).not.toContain("a:step-c");

    // And its outstanding reservation is RELEASED, not settled: the item never
    // completed, so charging for it would be the double-charge defect 24-H
    // closed, reintroduced through the breach path.
    expect(settled).toEqual([]);
    expect(released).toContain(0);
  });

  it("keeps a genuine body failure classified as failed while another item breaches", async () => {
    // The vacuity guard, and the reason a simpler shape of this test was not
    // one. At `concurrency: 1` a body failure never sets the halt flag, so
    // classifying by `haltedBeforeBody` and by the global `dispatchHalted()`
    // are observationally identical and a mutant swapping them SURVIVES —
    // verified by running it.
    //
    // The distinction needs item 'a' to fail its OWN body while a breach is
    // also live. Ordering matters and was established by probe, not by
    // reasoning: 'a' must fail BEFORE the breach halts dispatch, otherwise it
    // breaks at the dispatch gate without ever reaching its failing node and
    // `aborted` is then the correct answer. So 'a' fails immediately at
    // step-a, and item 'b' is held until that has happened.
    const releasedWith: string[] = [];
    const itemAFailed = deferred();
    const itemBDenied = deferred();

    const executor: NodeExecutor = async (
      nodeId: string,
      _node: PipelineNode,
      ctx
    ) => {
      const item = ctx.state["item"] as { id: string };
      if (item.id === "a" && nodeId === "step-a") {
        // 'a' is INSIDE this body node when the breach fires: it releases the
        // gate, waits for 'b' to be denied, and only then throws. So the halt
        // is live at the moment 'a''s own body fails — the one window where
        // the global halt flag and the per-item one disagree.
        itemAFailed.release();
        await itemBDenied.promise;
        throw new Error("simulated body failure");
      }
      return { nodeId, output: "ok", durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: forEachPipeline(2),
      nodeExecutor: executor,
      loopIterationBudgetReservation: {
        mode: "strict",
        itemBudgetCents: 100,
        reserve: async (input) => {
          if (input.itemIndex === 1) {
            // Deny 'b' only once 'a' is parked inside its body node.
            await itemAFailed.promise;
            itemBDenied.release();
            return { status: "unknown" as const };
          }
          return { status: "reserved" as const, reservedCostCents: 50 };
        },
        settle: () => {},
        release: (input) => {
          releasedWith.push(`${input.itemIndex ?? -1}:${input.reason}`);
        },
        reconcile: () => ({ status: "unknown" as const }),
        measureItemCost: () => ({ status: "known" as const, costCents: 50 }),
      },
    });

    await runtime.execute({ items: ITEMS });

    // `failed`, not `aborted`: item 0's own body threw, even though
    // dispatch. A mutant classifying by the global halt flag reports
    // `aborted` here once any halt is live.
    expect(releasedWith).toContain("0:failed");
  });

  it("releases a body failure as failed at concurrency 1", async () => {
    // The guard against over-broad classification. `haltedBeforeBody` must
    // distinguish "this item stopped at the dispatch gate" from "this item's
    // own body errored". A halt flag alone cannot: at N>1 a failure in one
    // item halts the others, so reading the halt flag would relabel the
    // FAILING item itself as cancelled and tell an operator the run was
    // cancelled when a body actually threw.
    const releasedWith: string[] = [];

    const executor: NodeExecutor = async (
      nodeId: string,
      _node: PipelineNode,
      ctx
    ) => {
      const item = ctx.state["item"] as { id: string };
      if (item.id === "a" && nodeId === "step-b") {
        throw new Error("simulated body failure");
      }
      return { nodeId, output: "ok", durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: forEachPipeline(1),
      nodeExecutor: executor,
      loopIterationBudgetReservation: {
        mode: "strict",
        itemBudgetCents: 100,
        reserve: () => ({ status: "reserved" as const, reservedCostCents: 50 }),
        settle: () => {},
        release: (input) => {
          releasedWith.push(`${input.itemIndex ?? -1}:${input.reason}`);
        },
        reconcile: () => ({ status: "unknown" as const }),
        measureItemCost: () => ({ status: "known" as const, costCents: 50 }),
      },
    });

    await runtime.execute({ items: ITEMS });

    // Released as `failed` — its body threw. A mutant classifying by the halt
    // flag alone reports `aborted` here.
    expect(releasedWith).toContain("0:failed");
  });
});
