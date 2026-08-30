/**
 * `failFast` scope — it stops DISPATCH, and deliberately does NOT halt items
 * already in flight.
 *
 * This behaviour was reachable in production but UNSPECIFIED: the contract
 * field carried no doc comment, and the two readings are both defensible —
 * "stop starting new work" (what the code does) and "abort work underway"
 * (what `budgetBreached` does since 24-I). The operator settled it in favour of
 * the former, on the grounds that an item underway holds a reservation and
 * partial side effects, and halting it mid-body would reintroduce exactly the
 * release/settle ambiguity 24-F..24-H worked to remove.
 *
 * This suite pins that decision so the next person to notice the asymmetry with
 * `budgetBreached` finds a test naming it as intentional rather than a gap. It
 * is the test `LoopNode.forEach.failFast`'s doc comment cites.
 *
 * WHY THE RENDEZVOUS. The obvious test — fail item 0, assert item 1 still ran —
 * is VACUOUS at the shape it invites. The `for_each` worker loop checks the halt
 * before dispatching, so if the failure lands before item 1 is dispatched, item
 * 1 never starts and the assertion measures dispatch ordering rather than
 * in-flight survival. It would pass just as happily against an implementation
 * that DID abort in-flight items. So item 'b' is held inside its first body node
 * until 'a' has already failed: at the instant the halt goes live, 'b' is
 * provably mid-flight with two body nodes still to run. That is the only window
 * in which "stop dispatch" and "abort underway" disagree.
 *
 * MUTATION-PROVED in both directions, on 2026-08-17:
 *   - `if (contract.failFast === true) stopDispatch()` in the body-error branch
 *     (the "abort underway" semantic) turns 'b' into `["b:step-a"]` and kills
 *     the first and last tests.
 *   - neutering the worker-loop guard to `false && firstError !== undefined`
 *     (ignoring `failFast` entirely) dispatches 'c' and kills the second.
 * Both are re-runnable claims, not assertions of diligence.
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

function forEachPipeline(
  concurrency: number,
  failFast: boolean
): PipelineDefinition {
  return {
    id: "for-each-fail-fast-scope",
    name: "ForEachFailFastScope",
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

/** Resolves once, on demand. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

/**
 * The rendezvous executor shared by every N>1 case here: 'a' fails at its first
 * body node and releases the latch; 'b' parks at its own first body node until
 * that latch opens, so the halt is provably live while 'b' is mid-flight.
 */
function rendezvousExecutor(bodyRuns: string[]): NodeExecutor {
  const itemAFailed = deferred();
  return async (nodeId: string, _node: PipelineNode, ctx) => {
    const item = ctx.state["item"] as { id: string };
    bodyRuns.push(`${item.id}:${nodeId}`);
    if (item.id === "a" && nodeId === "step-a") {
      itemAFailed.release();
      throw new Error("simulated body failure");
    }
    if (item.id === "b" && nodeId === "step-a") {
      await itemAFailed.promise;
    }
    return { nodeId, output: "ok", durationMs: 1 };
  };
}

describe("`failFast` stops dispatch without halting in-flight items", () => {
  it("lets an item already in flight finish every remaining body node", async () => {
    const bodyRuns: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(2, true),
      nodeExecutor: rendezvousExecutor(bodyRuns),
    });

    const result = await runtime.execute({
      items: [{ id: "a" }, { id: "b" }],
    });

    expect(result.state).toBe("failed");

    // THE PIN. 'b' was inside step-a when 'a' failed and `failFast` halted
    // dispatch. It goes on to run step-b and step-c. An implementation that
    // aborted in-flight items would stop 'b' after step-a, and these two
    // assertions are what would catch that change.
    expect(bodyRuns).toContain("b:step-b");
    expect(bodyRuns).toContain("b:step-c");

    // Asserted as an exact sequence, not a membership set: it records the
    // observed interleaving in full, so a future reader sees precisely what
    // "does not halt in flight" bought item 'b'.
    expect(bodyRuns).toEqual(["a:step-a", "b:step-a", "b:step-b", "b:step-c"]);
  });

  it("does not dispatch an item that had not started when the failure landed", async () => {
    // The other half of the scope, and what makes the first test a statement
    // about IN-FLIGHT items specifically rather than about `failFast` being
    // inert. Item 'c' is never dispatched, because dispatch IS what `failFast`
    // stops. Without this, an implementation ignoring `failFast` entirely would
    // pass the test above.
    const bodyRuns: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(2, true),
      nodeExecutor: rendezvousExecutor(bodyRuns),
    });

    await runtime.execute({
      items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });

    // 'c' sat behind the concurrency window and was never dispatched.
    expect(bodyRuns.filter((entry) => entry.startsWith("c:"))).toEqual([]);
    // While 'b', already underway, still completed — the contrast that makes
    // the scope precise.
    expect(bodyRuns).toContain("b:step-c");
  });

  it("dispatches every remaining item when `failFast` is off", async () => {
    // The control. It holds `concurrency`, the failure, and the rendezvous
    // fixed and varies ONLY `failFast`, so the previous test's "'c' never ran"
    // is attributable to the flag rather than to the failure aborting the run
    // or to items 'b'/'c' contending for the two-wide window.
    const bodyRuns: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(2, false),
      nodeExecutor: rendezvousExecutor(bodyRuns),
    });

    await runtime.execute({
      items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });

    // With the flag off, 'c' IS dispatched and runs to completion.
    expect(bodyRuns).toContain("c:step-c");
  });

  it("records the in-flight survivor as `completed` in the durable terminal set", async () => {
    // The tests above read the EXECUTION TRACE; this one reads what was
    // PERSISTED. They are independent surfaces — a run can behave correctly and
    // still record the wrong outcome, and it is the durable record a resume and
    // any host-side accounting actually consult. 24-G's terminal set is what
    // makes "every index carries a terminal outcome" assertable at all.
    //
    // Four items, so the record covers both halves of the scope at once: the
    // in-flight survivor (1) and the tail dispatch never reached (2, 3).
    const bodyRuns: string[] = [];
    const store = new InMemoryPipelineCheckpointStore();
    // `after_each_node` is REQUIRED here and deliberately not in the shared
    // factory: without a checkpoint strategy nothing is persisted, so
    // `itemOutcomes` reads back empty and every assertion below passes
    // `undefined` into `?.outcome`. That is a vacuous green, and it is how this
    // test first failed — worth naming so it is not "fixed" by relaxing the
    // assertions.
    const definition = {
      ...forEachPipeline(2, true),
      checkpointStrategy: "after_each_node" as const,
    };
    const runtime = new PipelineRuntime({
      definition,
      nodeExecutor: rendezvousExecutor(bodyRuns),
      checkpointStore: store,
    });

    const result = await runtime.execute({
      items: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    });
    expect(result.state).toBe("failed");

    const checkpoint = await store.load(result.runId);
    const outcomes = (checkpoint?.loopState?.["loop-items"]?.itemOutcomes ??
      {}) as unknown as Record<string, { outcome: string }>;

    expect(outcomes["0"]?.outcome).toBe("failed");
    // The survivor is durably `completed`, not `cancelled` — the persisted
    // counterpart of "in-flight work is allowed to finish".
    expect(outcomes["1"]?.outcome).toBe("completed");
    // Never-dispatched items are `cancelled` rather than absent, which is the
    // property that makes the terminal set complete across `0..n-1`.
    expect(outcomes["2"]?.outcome).toBe("cancelled");
    expect(outcomes["3"]?.outcome).toBe("cancelled");
  });

  it("is observationally inert for in-flight items at concurrency 1", async () => {
    // Why the tests above need N>1, recorded rather than left to be
    // rediscovered. With one worker nothing is ever in flight when the failure
    // is observed, so "stop dispatch" and "abort underway" produce identical
    // output and no test at this concurrency can distinguish them. This is the
    // same equivalence-by-construction that let a mutant survive two drafts in
    // 24-I.
    const bodyRuns: string[] = [];

    const executor: NodeExecutor = async (
      nodeId: string,
      _node: PipelineNode,
      ctx
    ) => {
      const item = ctx.state["item"] as { id: string };
      bodyRuns.push(`${item.id}:${nodeId}`);
      if (item.id === "a" && nodeId === "step-a") {
        throw new Error("simulated body failure");
      }
      return { nodeId, output: "ok", durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: forEachPipeline(1, true),
      nodeExecutor: executor,
    });

    await runtime.execute({
      items: [{ id: "a" }, { id: "b" }],
    });

    // Only the failing item's first node ran. Nothing was in flight to survive.
    expect(bodyRuns).toEqual(["a:step-a"]);
  });
});
