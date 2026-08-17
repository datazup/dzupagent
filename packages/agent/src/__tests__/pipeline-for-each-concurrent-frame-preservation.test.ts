/**
 * 24-I — proof 3: concurrent commit preservation.
 *
 * Doc 27 §8 proof 3 asks for something strictly stronger than the
 * fail-closed-on-lost-CAS that G2a shipped. G2a proves that a writer which
 * LOSES a compare-and-set race stops instead of executing against a stale
 * cursor. That is a refusal, not a preservation: it says what happens to the
 * loser, and nothing at all about whether the WINNER's concurrently-written
 * frame survived. Letting a fail-closed test stand in for proof 3 is a
 * substitution this program has already made once and had to audit back down
 * (collision B4, 24 flags to an honest 14), so it is not repeated here.
 *
 * The claim under test is the G1 keyed-frame merge at
 * `stage-dispatch.ts:423`, which carries a self-declared note that a mutant
 * dropping its spread survives every suite at `concurrency: 1` — because with
 * one worker only one item is ever in flight, so merging into the existing
 * frames and replacing them wholesale are observationally identical.
 *
 * Two items in flight AT THE SAME TIME is the only condition that separates
 * them, and it is what N>1 finally makes constructible. The executor here
 * holds item 0 inside its first body node until item 1 has also written a
 * mid-item frame, so both frames are live when the second write lands. Under
 * the merge, the checkpoint carries both. Under an overwrite, the second
 * write erases the first and item 0 resumes at body node 0 — re-running body
 * work whose side effects already committed, the exact defect E3 existed to
 * close, reproduced one level up.
 *
 * These tests require the N>1 admission (24-I). They are the killing test the
 * G1 merge has been owed since that packet.
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { readItemFrames } from "../pipeline/pipeline-runtime/stage-dispatch.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

/** A for_each loop over two items, each with a three-node body. */
function concurrentForEachPipeline(concurrency: number): PipelineDefinition {
  return {
    id: "for-each-concurrent-frames",
    name: "ForEachConcurrentFrames",
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
          collect: { from: "itemStatus", into: "itemStatuses", order: "input" },
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

/**
 * An executor that pins item 0 inside `step-b` until item 1 has written its
 * own mid-item frame. Without this rendezvous the two items could serialize by
 * luck and the test would prove nothing about simultaneity — the vacuity this
 * lane keeps finding. `sawBothInFlight` records that the overlap really
 * happened, and is asserted, so a scheduling change that quietly serializes
 * the run fails loudly instead of passing for the wrong reason.
 */
function rendezvousExecutor(state: {
  runs: string[];
  sawBothInFlight: boolean;
}): NodeExecutor {
  const itemOneReachedBodyTwo = deferred();
  return async (nodeId: string, _node: PipelineNode, ctx) => {
    const item = ctx.state["item"] as { id: string };
    state.runs.push(`${item.id}:${nodeId}`);

    // Item 'a' parks at its second body node, holding a live mid-item frame,
    // until item 'b' has also produced one.
    if (item.id === "a" && nodeId === "step-b") {
      await itemOneReachedBodyTwo.promise;
      state.sawBothInFlight = true;
    }
    if (item.id === "b" && nodeId === "step-b") {
      itemOneReachedBodyTwo.release();
    }

    ctx.state["itemStatus"] = `${item.id}:done`;
    return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
  };
}

describe("for_each concurrent commit preservation (24-I proof 3)", () => {
  it("keeps both in-flight item frames when two items write concurrently", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const state = { runs: [] as string[], sawBothInFlight: false };
    const seenFrameKeySets: string[][] = [];

    const runtime = new PipelineRuntime({
      definition: concurrentForEachPipeline(2),
      nodeExecutor: rendezvousExecutor(state),
      checkpointStore: store,
    });

    // Observe every persisted checkpoint rather than only the final one: the
    // frames are mid-item state and are retired once the ordered prefix covers
    // them, so the moment both are live is transient by design.
    const originalSave = store.save.bind(store);
    store.save = async (checkpoint) => {
      const frames = readItemFrames(
        (checkpoint as { loopState?: Record<string, unknown> }).loopState?.[
          "loop-items"
        ] as never
      );
      if (frames !== undefined) {
        seenFrameKeySets.push(Object.keys(frames).sort());
      }
      return originalSave(checkpoint);
    };

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("completed");
    // The rendezvous actually overlapped — without this the run may have
    // serialized and the frame assertion below would be vacuous.
    expect(state.sawBothInFlight).toBe(true);

    // THE PROOF: at least one durable checkpoint carried BOTH items' frames.
    // A mutant that replaces `...readItemFrames(previousBoundary)` with a bare
    // record keeps only the writing item's own frame, so every set here is a
    // singleton and this assertion fails.
    expect(seenFrameKeySets).toContainEqual(["0", "1"]);
  });

  it("resumes each concurrently-framed item at its own body node", async () => {
    // The preservation above matters only because a preserved frame is a
    // RESUMABLE one. This drives a two-frame checkpoint through a real resume
    // and proves neither item restarts at body node 0 — re-running committed
    // body work is the consequence an overwrite actually causes.
    //
    // HONEST SCOPE: this test does NOT kill the overwrite mutant, and it was
    // verified not to — it supplies the two-frame `loopState` directly rather
    // than letting the merge build one, so it never exercises
    // `stage-dispatch.ts:423`. It pins the CONSUMER half of the contract (a
    // keyed frame is honoured on the way back in); the test above is the sole
    // killing test for the producer half. Keeping the distinction explicit so
    // a later reader does not credit this one with strength it lacks.
    const store = new InMemoryPipelineCheckpointStore();
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: concurrentForEachPipeline(2),
      nodeExecutor: async (nodeId: string, _node: PipelineNode, ctx) => {
        const item = ctx.state["item"] as { id: string };
        runs.push(`${item.id}:${nodeId}`);
        ctx.state["itemStatus"] = `${item.id}:done`;
        return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
      },
      checkpointStore: store,
    });

    const resumed = await runtime.resume({
      pipelineRunId: "run-concurrent-frames",
      createdAt: "2026-08-17T00:00:00.000Z",
      pipelineId: "for-each-concurrent-frames",
      version: 1,
      schemaVersion: "1.0.0",
      state: { items: ITEMS },
      completedNodeIds: [],
      loopState: {
        "loop-items": {
          iteration: 0,
          itemFrames: {
            "0": {
              itemIndex: 0,
              nextBodyNodeIndex: 2,
              bodyResults: {
                "step-a": { nodeId: "step-a", output: "a:step-a", durationMs: 1 },
                "step-b": { nodeId: "step-b", output: "a:step-b", durationMs: 1 },
              },
            },
            "1": {
              itemIndex: 1,
              nextBodyNodeIndex: 1,
              bodyResults: {
                "step-a": { nodeId: "step-a", output: "b:step-a", durationMs: 1 },
              },
            },
          },
        },
      },
    } as never);

    expect(resumed.state).toBe("completed");
    // Item 'a' resumes at step-c and item 'b' at step-b. Neither re-runs
    // step-a: both frames survived the concurrent writes that produced them.
    expect(runs.sort()).toEqual(["a:step-c", "b:step-b", "b:step-c"]);
  });
});
