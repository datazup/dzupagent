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
 * is *capable* of N>1.
 *
 * 24-I RE-DATED. G1 shipped this shape without admitting N>1, so these tests
 * drove it directly through `resume()` — the runtime refused to run a
 * concurrent loop, and a hand-built checkpoint was the only way to construct a
 * multi-frame input. That is no longer true: `concurrency` admits any positive
 * integer and `for-each-loop.ts` spawns that many real workers.
 *
 * The resume-driven tests below are KEPT as-is. They pin the consumer half —
 * that a keyed frame written by any producer is honoured — and a hand-built
 * checkpoint remains the sharpest way to state exactly which frame is present.
 * What N>1 changed is that the RETIREMENT rule, which the comment at the end
 * of the first test correctly said could not be observed end-to-end at
 * concurrency 1, now can be. That test is at the bottom of this file.
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { PipelineCheckpointSchema } from "@dzupagent/core/pipeline";
import {
  readItemFrames,
  retainInFlightItemFrames,
} from "../pipeline/executor-internals/stage-dispatch.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
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
    //
    // 24-I: this debt is now PAID end-to-end, not just as a unit — see
    // "retires only the flushed frame" at the bottom of this file. Two items
    // in flight is the input the unit test had to hand-build, and N>1
    // produces it from a real run.
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

  // 24-I DELETED a test here that asserted `concurrency` was 1 in this file's
  // own fixture and was named "keeps concurrency pinned to 1 — G1 changes the
  // shape, not the admission". Its premise is now false: 24-I admits N>1.
  //
  // It is not re-pointed at the admission gate, because it never tested one.
  // It read the fixture this file constructs and asserted the value this file
  // had just written — it would have stayed green through the entire six-site
  // relaxation, which is exactly what it claimed to guard against. The real
  // admission gates are pinned in `pipeline-for-each-admission.test.ts` (agent),
  // `pipeline.test.ts` (core), `validate.test.ts` (flow-ast) and
  // `for-each-durability-admission.test.ts` (flow-compiler), all of which
  // assert against a validator rather than against a literal.
  //
  // `threeBodyForEachPipeline` stays at concurrency 1 deliberately: these
  // tests drive `resume()` with a hand-built frame set, and a concurrent
  // scheduler would add a second producer of frames and blur which write the
  // assertion is about.
});

describe("item-frame retirement and legacy normalisation (G1)", () => {
  // These were unit tests by necessity, not preference. Both helpers exist to
  // handle N>1 in-flight items, and when G1 shipped, `concurrency` was pinned
  // to 1 at every admission point — so an end-to-end run could not construct
  // the input that distinguishes correct behaviour from the pre-G1 behaviour.
  //
  // 24-I admitted N>1 and the necessity is gone: "retires only the flushed
  // frame" at the bottom of this file drives the same rule through a real
  // concurrent run. These unit tests are KEPT rather than replaced, because
  // they state the retention boundary as a table (at, above, and below the
  // prefix) far more sharply than a scheduled run can, and they cover the
  // legacy-normalisation input an end-to-end run cannot produce at all.

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

/**
 * 24-I — the retirement rule, end-to-end.
 *
 * `retainInFlightItemFrames` is covered as a unit above. That was the only
 * coverage available at G1, and the first test in this file carries a note
 * saying so: at `concurrency: 1` a flush and a live foreign frame cannot
 * coexist, because the single worker's flush is always about the only item it
 * was running. Dropping every frame and dropping only the flushed one are
 * observationally identical, so the filter was unkillable end-to-end.
 *
 * N>1 supplies the missing input. Item 0 completes and flushes the ordered
 * prefix to 1 while item 1 is parked mid-body holding a live frame. Under the
 * retention rule item 1's frame survives that flush; under the pre-G1
 * rebuild-from-scratch it is erased, and item 1 resumes at body node 0,
 * re-running committed side effects.
 *
 * This is the same class of debt as the one 24-I found UNPAYABLE in
 * `restoreLoopStateAfterLostCommit` — and the opposite outcome. There, failing
 * closed structurally prevented the observation at any concurrency. Here the
 * observation was blocked only by the admission, so admitting N>1 pays it.
 * Both were established by mutating first, not by reasoning from the comment.
 */
function twoItemForEachPipeline(concurrency: number): PipelineDefinition {
  const definition = threeBodyForEachPipeline();
  const loop = definition.nodes.find((n) => n.id === "loop-items");
  (loop as { forEach: { concurrency: number } }).forEach.concurrency =
    concurrency;
  return definition;
}

describe("for_each item-frame retirement under real concurrency (24-I)", () => {
  it("retires only the flushed frame and keeps a live one", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const runs: string[] = [];
    const flushCheckpoints: Array<{ iteration: number; keys: string[] }> = [];
    let lastIteration = 0;

    // THE RENDEZVOUS, and the whole difficulty of this test. Item 'b' must
    // have COMMITTED a body node before item 'a' flushes — a frame is written
    // by `onItemBodyNodeComplete`, so an item merely *started* has no frame at
    // all. A first draft parked 'b' inside its first node and the flush
    // checkpoint carried no foreign frame on correct source either, which made
    // retention and drop-everything identical and the test worthless.
    //
    // So: 'a' parks at its LAST node until 'b' has finished its first. Then
    // 'a' completes, the ordered prefix advances to 1, and at that instant 'b'
    // holds a live frame at index 1 that the retention rule must preserve.
    const itemBCommittedANode = (() => {
      let release = (): void => {};
      const promise = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      return { promise, release };
    })();

    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      const item = ctx.state["item"] as { id: string };
      runs.push(`${item.id}:${nodeId}`);
      if (item.id === "a" && nodeId === "step-c") {
        await itemBCommittedANode.promise;
      }
      if (item.id === "b" && nodeId === "step-a") {
        // Released AFTER this node's checkpoint is written, not on return, so
        // 'b' genuinely holds a persisted frame when 'a' flushes. Queued as a
        // microtask rather than a timer: real timers are banned in this suite
        // and fake ones would deadlock the rendezvous, since the release
        // depends on work the runtime does between now and then.
        void Promise.resolve().then(() => {
          itemBCommittedANode.release();
        });
      }
      // 'b' yields the microtask queue after its first node so 'a' can reach
      // and complete its flush while 'b's frame is still live, instead of
      // racing past it.
      if (item.id === "b" && nodeId === "step-b") {
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      }
      ctx.state["itemStatus"] = `${item.id}:done`;
      return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: twoItemForEachPipeline(2),
      nodeExecutor: executor,
      checkpointStore: store,
    });

    // Watch every persisted checkpoint: the state under test — a flushed
    // prefix coexisting with a live frame above it — is transient by design.
    const originalSave = store.save.bind(store);
    store.save = async (checkpoint) => {
      const cursor = (
        checkpoint as { loopState?: Record<string, { iteration?: number }> }
      ).loopState?.["loop-items"];
      const frames = readItemFrames(cursor as never);
      const iteration = cursor?.iteration ?? 0;
      // The state under test: the prefix has advanced past item 0, and item 1
      // is still mid-body. RETENTION and DROP-EVERYTHING differ here and
      // nowhere else.
      //
      // Asserting only "every surviving frame is at or above the prefix" is
      // NOT enough: it is vacuously true of an empty set, so the pre-G1
      // rebuild-from-scratch passes it. That exact draft survived the mutant.
      // The assertion has to be that the live frame IS STILL THERE.
      // ONLY the checkpoint written BY the flush can distinguish the two
      // behaviours, and identifying it took instrumenting the real save
      // sequence rather than reasoning about it.
      //
      // `retainInFlightItemFrames` runs once, at `onIterationComplete`. Every
      // subsequent `onItemBodyNodeComplete` re-adds the writing item's frame.
      // So a hook that looks at "any save while an item is in flight" sees the
      // frames RE-ADDED a moment later and passes under the drop-everything
      // mutant too — an earlier draft did exactly that and survived. The flush
      // is the save on which `iteration` INCREASES; that one checkpoint is the
      // whole observation.
      if (iteration > lastIteration) {
        flushCheckpoints.push({
          iteration,
          keys: Object.keys(frames ?? {}).sort(),
        });
        lastIteration = iteration;
      }
      return originalSave(checkpoint);
    };

    const result = await runtime.execute({
      items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });

    expect(result.state).toBe("completed");
    // ASSERT THE FIXTURE FIRED. Without this the test passes vacuously if the
    // runtime serializes the items: no flush ever coincides with a live
    // foreign frame, the collection stays empty, and a rebuild-from-scratch
    // mutant survives. This lane has shipped that mistake before; the guard is
    // the assertion, not the rendezvous.
    //
    // Note the assertions live HERE, not inside the save hook: an `expect`
    // that throws inside the hook surfaces to the runtime as a failed save and
    // fails the whole RUN, which masks the real assertion and would let a
    // mutant look "killed" for the wrong reason.
    // A flush that ADVANCED the prefix past a completed item must still have
    // been observed carrying a frame for a DIFFERENT, still-running item.
    // `length > 0` alone is not enough: under the drop-everything mutant the
    // collection is simply empty and a `for` loop over it vacuously passes.
    // An earlier draft asserted exactly that and survived the mutant.
    // At least one flush happened while another item was mid-body — otherwise
    // the run serialized and this test proves nothing.
    const flushCarryingAForeignFrame = flushCheckpoints.filter(
      ({ keys }) => keys.length > 0
    );
    expect(flushCarryingAForeignFrame.length).toBeGreaterThan(0);

    // THE KILLING ASSERTION. On the flush checkpoint itself, the frame of the
    // item still in flight survived. Under the pre-G1 rebuild-from-scratch it
    // is erased and `flushCarryingAForeignFrame` is empty, which is why the
    // count above is asserted before anything iterates it.
    //
    // Stated as a filter-to-length rather than `.every()` so it cannot pass
    // vacuously: a retained frame BELOW the prefix would resume an item that
    // is already complete.
    const retainedBelowPrefix = flushCarryingAForeignFrame.flatMap(
      ({ iteration, keys }) => keys.filter((k) => Number(k) < iteration)
    );
    expect(retainedBelowPrefix).toHaveLength(0);

    // No frame outlives the run.
    const checkpoint = await store.load(result.runId);
    expect(checkpoint?.loopState?.["loop-items"]?.itemFrames).toBeUndefined();
  });
});
