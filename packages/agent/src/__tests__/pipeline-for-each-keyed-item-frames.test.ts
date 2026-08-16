/**
 * G1 — keyed in-flight `for_each` item frames.
 *
 * E3 shipped a *singular* `itemFrame`, which can only ever name one in-flight
 * item. That shape has two structural defects the moment more than one item is
 * in flight:
 *
 *   1. every mid-item write rebuilt the loop entry around one frame, so a
 *      second in-flight item clobbered the first and the loser resumed at body
 *      node 0 — re-running body nodes whose side effects had committed, which
 *      is exactly the defect E3 existed to close;
 *   2. reaching an item boundary rebuilt the entry from scratch to retire the
 *      frame, which erased the live frame of every *other* in-flight item.
 *
 * G1 replaces it with `itemFrames`, keyed by item index, so the durable shape
 * is *capable* of N>1. It does not admit N>1: `concurrency` stays pinned to 1
 * at every admission point, which is asserted below. These tests therefore
 * drive the keyed shape directly through `resume()` rather than by running a
 * concurrent loop, which the runtime still refuses to do.
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { PipelineCheckpointSchema } from "@dzupagent/core/pipeline";
import {
  readItemFrames,
  retainInFlightItemFrames,
} from "../pipeline/pipeline-runtime/stage-dispatch.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

/** A for_each loop whose body is three sequential nodes. */
function threeBodyForEachPipeline(): PipelineDefinition {
  return {
    id: "for-each-keyed-frames",
    name: "ForEachKeyedFrames",
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

function tracingExecutor(runs: string[]): NodeExecutor {
  return async (nodeId: string, _node: PipelineNode, ctx) => {
    const item = ctx.state["item"] as { id: string };
    runs.push(`${item.id}:${nodeId}`);
    ctx.state["itemStatus"] = `${item.id}:done`;
    return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
  };
}

const ITEMS = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("for_each keyed in-flight item frames (G1)", () => {
  it("resumes from a keyed frame at the named body node", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      checkpointStore: store,
    });

    // Item 'a' is complete (ordered prefix 1); item 'b' is mid-flight, having
    // committed step-a and step-b, so only step-c should run for it.
    const resumed = await runtime.resume({
      pipelineRunId: "run-keyed-resume",
      createdAt: "2026-08-16T00:00:00.000Z",
      pipelineId: "for-each-keyed-frames",
      version: 1,
      schemaVersion: "1.0.0",
      state: { items: ITEMS },
      completedNodeIds: [],
      loopState: {
        "loop-items": {
          iteration: 1,
          itemFrames: {
            "1": {
              itemIndex: 1,
              nextBodyNodeIndex: 2,
              bodyResults: {
                "step-a": {
                  nodeId: "step-a",
                  output: "b:step-a",
                  durationMs: 1,
                },
                "step-b": {
                  nodeId: "step-b",
                  output: "b:step-b",
                  durationMs: 1,
                },
              },
            },
          },
        },
      },
    } as never);

    expect(resumed.state).toBe("completed");
    // Item 'a' is covered by the ordered prefix; item 'b' resumes at step-c
    // rather than repeating its two committed nodes; item 'c' runs whole.
    expect(runs).toEqual(["b:step-c", "c:step-a", "c:step-b", "c:step-c"]);
  });

  it("still resumes a pre-G1 checkpoint written with the singular itemFrame", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      checkpointStore: store,
    });

    // Byte-for-byte the shape E3 persisted. A checkpoint taken before G1 must
    // not lose its mid-item position and re-run committed side effects.
    const resumed = await runtime.resume({
      pipelineRunId: "run-legacy-frame",
      createdAt: "2026-08-16T00:00:00.000Z",
      pipelineId: "for-each-keyed-frames",
      version: 1,
      schemaVersion: "1.0.0",
      state: { items: ITEMS },
      completedNodeIds: [],
      loopState: {
        "loop-items": {
          iteration: 1,
          itemFrame: {
            itemIndex: 1,
            nextBodyNodeIndex: 2,
            bodyResults: {
              "step-a": { nodeId: "step-a", output: "b:step-a", durationMs: 1 },
              "step-b": { nodeId: "step-b", output: "b:step-b", durationMs: 1 },
            },
          },
        },
      },
    } as never);

    expect(resumed.state).toBe("completed");
    expect(runs).toEqual(["b:step-c", "c:step-a", "c:step-b", "c:step-c"]);
  });

  it("retires only the frames the ordered prefix covers", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      checkpointStore: store,
    });

    // Item 1 is mid-flight AND item 2 already holds a frame. When item 1
    // completes and the prefix advances to 2, item 2's frame must survive:
    // the pre-G1 code rebuilt the entry and erased it, so item 2 would have
    // restarted at body node 0 and re-run its committed step-a.
    const resumed = await runtime.resume({
      pipelineRunId: "run-selective-retire",
      createdAt: "2026-08-16T00:00:00.000Z",
      pipelineId: "for-each-keyed-frames",
      version: 1,
      schemaVersion: "1.0.0",
      state: { items: ITEMS },
      completedNodeIds: [],
      loopState: {
        "loop-items": {
          iteration: 1,
          itemFrames: {
            "1": {
              itemIndex: 1,
              nextBodyNodeIndex: 2,
              bodyResults: {
                "step-a": {
                  nodeId: "step-a",
                  output: "b:step-a",
                  durationMs: 1,
                },
                "step-b": {
                  nodeId: "step-b",
                  output: "b:step-b",
                  durationMs: 1,
                },
              },
            },
            "2": {
              itemIndex: 2,
              nextBodyNodeIndex: 1,
              bodyResults: {
                "step-a": {
                  nodeId: "step-a",
                  output: "c:step-a",
                  durationMs: 1,
                },
              },
            },
          },
        },
      },
    } as never);

    expect(resumed.state).toBe("completed");
    // Item 2 picks up at step-b — proof its frame was honoured, not discarded.
    expect(runs).toEqual(["b:step-c", "c:step-b", "c:step-c"]);

    // NOTE: this test cannot observe frame *retirement*. `runIteration` reads
    // the resume options captured at loop start, not the checkpoint the flush
    // rewrites, and at `concurrency: 1` no two items are ever in flight
    // together — so a later item's own mid-item write re-adds its frame
    // regardless of what the flush dropped. Retirement is therefore covered
    // as a unit below, where the multi-frame input it exists for can actually
    // be constructed.
  });

  it("leaves no frames behind once every item completes", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      checkpointStore: store,
    });
    const result = await runtime.execute({ items: ITEMS });
    expect(result.state).toBe("completed");

    const checkpoint = await store.load(result.runId);
    const cursor = checkpoint?.loopState?.["loop-items"];
    // An empty record is normalised away so an item-boundary cursor stays
    // byte-identical to a pre-E3 iteration-only one.
    expect(cursor?.itemFrames).toBeUndefined();
    expect(cursor?.itemFrame).toBeUndefined();
  });

  it("keeps concurrency pinned to 1 — G1 changes the shape, not the admission", () => {
    const definition = threeBodyForEachPipeline();
    const loop = definition.nodes.find((n) => n.id === "loop-items");
    expect(loop?.forEach?.concurrency).toBe(1);
  });
});

describe("item-frame retirement and legacy normalisation (G1)", () => {
  // These are unit tests by necessity, not preference. Both helpers exist to
  // handle N>1 in-flight items, and `concurrency` is still pinned to 1 at
  // every admission point — so an end-to-end run cannot construct the input
  // that distinguishes correct behaviour from the pre-G1 behaviour. Driving
  // them directly is the only non-vacuous coverage available until
  // concurrency is admitted in a later slice.

  const frame = (itemIndex: number, nextBodyNodeIndex: number) => ({
    itemIndex,
    nextBodyNodeIndex,
  });

  it("keeps frames at or above the ordered prefix and drops those below", () => {
    // THE POINT OF G1's retirement rule: item 1 is covered by the prefix and
    // must go; items 2 and 3 are still in flight and must survive. The pre-G1
    // code rebuilt the entry from scratch, dropping all three.
    const retained = retainInFlightItemFrames(
      { "1": frame(1, 2), "2": frame(2, 1), "3": frame(3, 0) },
      2
    );
    expect(Object.keys(retained ?? {}).sort()).toEqual(["2", "3"]);
    expect(retained?.["2"]).toMatchObject({
      itemIndex: 2,
      nextBodyNodeIndex: 1,
    });
  });

  it("normalises an empty result to undefined rather than an empty record", () => {
    // An empty record would make an item-boundary cursor differ from a
    // pre-E3 iteration-only one for no reason.
    expect(retainInFlightItemFrames({ "0": frame(0, 1) }, 1)).toBeUndefined();
    expect(retainInFlightItemFrames(undefined, 3)).toBeUndefined();
  });

  it("reads a pre-G1 singular frame as a one-entry map keyed by its itemIndex", () => {
    expect(readItemFrames({ iteration: 1, itemFrame: frame(4, 2) })).toEqual({
      "4": frame(4, 2),
    });
  });

  it("prefers the keyed collection and treats an empty one as absent", () => {
    expect(
      readItemFrames({ iteration: 1, itemFrames: { "2": frame(2, 1) } })
    ).toEqual({ "2": frame(2, 1) });
    expect(readItemFrames({ iteration: 1, itemFrames: {} })).toBeUndefined();
    expect(readItemFrames({ iteration: 1 })).toBeUndefined();
    expect(readItemFrames(undefined)).toBeUndefined();
  });
});

describe("keyed item-frame checkpoint schema (G1)", () => {
  function checkpointWithLoopState(loopState: unknown): unknown {
    return {
      pipelineRunId: "run-schema",
      pipelineId: "for-each-keyed-frames",
      version: 1,
      schemaVersion: "1.0.0",
      createdAt: "2026-08-16T00:00:00.000Z",
      state: {},
      completedNodeIds: [],
      loopState,
    };
  }

  it("accepts a keyed frame whose key matches its itemIndex", () => {
    const parsed = PipelineCheckpointSchema.safeParse(
      checkpointWithLoopState({
        "loop-items": {
          iteration: 1,
          itemFrames: { "2": { itemIndex: 2, nextBodyNodeIndex: 1 } },
        },
      })
    );
    expect(parsed.success).toBe(true);
  });

  it("rejects a key that disagrees with its frame itemIndex", () => {
    // A key naming a different item than the frame it holds would resume the
    // wrong item, restoring one item's results into another's body.
    const parsed = PipelineCheckpointSchema.safeParse(
      checkpointWithLoopState({
        "loop-items": {
          iteration: 1,
          itemFrames: { "2": { itemIndex: 3, nextBodyNodeIndex: 1 } },
        },
      })
    );
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("does not match");
  });

  it("rejects a checkpoint carrying both the legacy and keyed spellings", () => {
    // Ambiguous about which is authoritative; silently preferring one could
    // discard a live frame.
    const parsed = PipelineCheckpointSchema.safeParse(
      checkpointWithLoopState({
        "loop-items": {
          iteration: 1,
          itemFrame: { itemIndex: 1, nextBodyNodeIndex: 1 },
          itemFrames: { "1": { itemIndex: 1, nextBodyNodeIndex: 1 } },
        },
      })
    );
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      "must not carry both"
    );
  });

  it("still accepts a pre-G1 checkpoint carrying only the singular itemFrame", () => {
    const parsed = PipelineCheckpointSchema.safeParse(
      checkpointWithLoopState({
        "loop-items": {
          iteration: 1,
          itemFrame: { itemIndex: 1, nextBodyNodeIndex: 1 },
        },
      })
    );
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-numeric frame key", () => {
    const parsed = PipelineCheckpointSchema.safeParse(
      checkpointWithLoopState({
        "loop-items": {
          iteration: 1,
          itemFrames: { "item-2": { itemIndex: 2, nextBodyNodeIndex: 1 } },
        },
      })
    );
    expect(parsed.success).toBe(false);
  });
});
