/**
 * E3 — `for_each` mid-item durability and bound resume.
 *
 * Three defects are covered here:
 *
 *  - **2**: a crash part-way through an item re-ran every body node in it.
 *    The loop's ordered-prefix cursor (`iteration`) only advances on a
 *    *completed* item, so "item 2 finished 1 of its 2 body nodes" had nowhere
 *    to live. `itemFrames[itemIndex]` is that missing frame.
 *  - **4 (runtime half)**: body nodes are dispatched straight from the loop
 *    executor and never reach `PipelineExecutor.keyFor`, so an idempotency key
 *    derived from `(runId, nodeId)` repeated across every item. The execution
 *    scope now rides on `NodeExecutionContext` to key derivation.
 *  - **1 / 3**: resume overlaid checkpoint state with no re-validation, so
 *    swapping the definition or reordering the item source was admissible.
 *
 * The tests below drive the real `PipelineRuntime` and crash it by throwing
 * from the node executor, rather than hand-assembling a checkpoint. A
 * synthetic checkpoint would pass even if nothing ever wrote the frame.
 */
import { describe, it, expect } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { PipelineSourceBindingMismatchError } from "../pipeline/pipeline-runtime-lifecycle/resume-context.js";
import type { PipelineDefinition } from "@dzupagent/core";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

/**
 * A `for_each` over `$.items` whose body is two sequential nodes. Two body
 * nodes is the minimum that can express "stopped between them", which is the
 * whole point of the frame.
 */
function twoBodyForEachPipeline(): PipelineDefinition {
  return {
    id: "for-each-mid-item",
    name: "ForEachMidItem",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "loop-items",
    checkpointStrategy: "after_each_node",
    nodes: [
      {
        id: "loop-items",
        type: "loop",
        bodyNodeIds: ["step-a", "step-b"],
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
    ],
    edges: [],
  } as unknown as PipelineDefinition;
}

/** Records every `(nodeId, item)` dispatch so re-execution is observable. */
function recordingExecutor(dispatches: string[]): NodeExecutor {
  return async (nodeId, _node, ctx) => {
    dispatches.push(`${nodeId}:${String(ctx.state["item"])}`);
    return { nodeId, output: `${nodeId}-${String(ctx.state["item"])}`, durationMs: 1 };
  };
}

describe("for_each mid-item durability (E3)", () => {
  it("checkpoints an item frame between body nodes and omits it on an item boundary", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: twoBodyForEachPipeline(),
      nodeExecutor: recordingExecutor([]),
      checkpointStore: store,
    });

    const result = await runtime.execute({ items: ["x", "y"] });
    expect(result.state).toBe("completed");

    // Walk every persisted version and classify its loop cursor. A frame must
    // appear only while an item is genuinely in flight.
    const frames: Array<{
      version: number;
      iteration: number;
      itemIndex?: number;
      nextBodyNodeIndex?: number;
    }> = [];
    // Walk versions until the store runs out. `PipelineRunResult` carries no
    // version count, so bounding the walk by one would silently iterate zero
    // times and make every assertion below vacuous.
    for (let v = 1; ; v++) {
      const cp = await store.loadVersion(result.runId, v);
      if (cp === undefined || cp === null) break;
      const cursor = cp.loopState?.["loop-items"];
      if (cursor === undefined) continue;
      // G1: frames are keyed by item index. 24-I RE-DATED: `concurrency` is no
      // longer pinned to 1 globally, but THIS pipeline's fixture sets it to 1
      // (see the definition above), so at most one frame is in flight at any
      // version. The bound holds because of the fixture, not the admission.
      const inFlight = Object.values(cursor.itemFrames ?? {});
      expect(inFlight.length).toBeLessThanOrEqual(1);
      frames.push({
        version: v,
        iteration: cursor.iteration,
        ...(inFlight[0] === undefined
          ? {}
          : {
              itemIndex: inFlight[0].itemIndex,
              nextBodyNodeIndex: inFlight[0].nextBodyNodeIndex,
            }),
      });
    }

    // Mid-item writes exist, and each one names the item it is inside and the
    // body node to resume at.
    const midItem = frames.filter((f) => f.itemIndex !== undefined);
    expect(midItem.length).toBeGreaterThan(0);
    for (const f of midItem) {
      expect(f.nextBodyNodeIndex).toBe(1);
      // The ordered-prefix cursor must NOT advance mid-item: it still counts
      // fully-completed items, so it equals the in-flight item's index.
      expect(f.iteration).toBe(f.itemIndex);
    }

    // An item-boundary write carries no frame — a retained one would resume
    // into an item that is already complete.
    const boundary = frames.filter((f) => f.itemIndex === undefined);
    expect(boundary.length).toBeGreaterThan(0);
  });

  it("resumes at the next body node instead of re-running the completed one", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const firstPass: string[] = [];

    // Crash inside item 1 (`"y"`), after `step-a` has committed but before
    // `step-b`. That is precisely the window the frame exists to describe.
    const crashing: NodeExecutor = async (nodeId, _node, ctx) => {
      const item = String(ctx.state["item"]);
      if (nodeId === "step-b" && item === "y") {
        throw new Error("crash mid-item");
      }
      firstPass.push(`${nodeId}:${item}`);
      return { nodeId, output: `${nodeId}-${item}`, durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: twoBodyForEachPipeline(),
      nodeExecutor: crashing,
      checkpointStore: store,
    });
    const failed = await runtime.execute({ items: ["x", "y"] });
    expect(failed.state).toBe("failed");
    expect(firstPass).toContain("step-a:y");

    const checkpoint = await store.load(failed.runId);
    const cursor = checkpoint?.loopState?.["loop-items"];
    // The crash left a frame pinned to item 1, resuming at body node 1.
    expect(cursor?.itemFrames?.["1"]).toMatchObject({
      itemIndex: 1,
      nextBodyNodeIndex: 1,
    });
    // `step-a`'s result is retained so the resume does not re-execute it to
    // rebuild what `step-b` reads.
    expect(Object.keys(cursor?.itemFrames?.["1"]?.bodyResults ?? {})).toContain(
      "step-a"
    );

    const secondPass: string[] = [];
    const resumed = new PipelineRuntime({
      definition: twoBodyForEachPipeline(),
      nodeExecutor: recordingExecutor(secondPass),
      checkpointStore: store,
    });
    const done = await resumed.resume(checkpoint!);
    expect(done.state).toBe("completed");

    // The heart of defect 2: `step-a` for item "y" already committed, so the
    // resume must not dispatch it again.
    expect(secondPass).not.toContain("step-a:y");
    expect(secondPass).toContain("step-b:y");
    // Item 0 completed before the crash and must not be revisited at all.
    expect(secondPass).not.toContain("step-a:x");
    expect(secondPass).not.toContain("step-b:x");
  });

  it("derives a distinct idempotency key per item for the same body node", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const keys: string[] = [];
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      if (nodeId === "step-a") keys.push(String(ctx.idempotencyKey));
      return { nodeId, output: nodeId, durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: twoBodyForEachPipeline(),
      nodeExecutor: executor,
      checkpointStore: store,
    });
    const result = await runtime.execute({ items: ["x", "y", "z"] });
    expect(result.state).toBe("completed");

    // Before E3 the scope never reached key derivation, so one key repeated
    // three times and a per-item ledger could not tell the items apart.
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).not.toBe("undefined");
  });
});

describe("bound resume (E3 defects 1 and 3)", () => {
  it("rejects a resume whose definition digest disagrees", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const crashing: NodeExecutor = async (nodeId, _node, ctx) => {
      if (nodeId === "step-b" && String(ctx.state["item"]) === "y") {
        throw new Error("crash");
      }
      return { nodeId, output: nodeId, durationMs: 1 };
    };
    const runtime = new PipelineRuntime({
      definition: twoBodyForEachPipeline(),
      nodeExecutor: crashing,
      checkpointStore: store,
    });
    const failed = await runtime.execute({ items: ["x", "y"] });
    expect(failed.state).toBe("failed");

    // Resume against a *different* compiled artifact. Fail-closed: replaying a
    // retained prefix against another definition is never safe, and a stranded
    // run is operator-recoverable where a double-executed item is not.
    const mutated = twoBodyForEachPipeline();
    mutated.nodes.push({
      id: "extra",
      type: "agent",
      agentId: "extra",
      timeoutMs: 5000,
    } as never);

    const checkpoint = await store.load(failed.runId);
    const resumed = new PipelineRuntime({
      definition: mutated,
      nodeExecutor: recordingExecutor([]),
      checkpointStore: store,
    });
    await expect(resumed.resume(checkpoint!)).rejects.toThrow(
      PipelineSourceBindingMismatchError
    );
  });

  it("rejects a resume whose for_each item source was reordered", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const crashing: NodeExecutor = async (nodeId, _node, ctx) => {
      if (nodeId === "step-b" && String(ctx.state["item"]) === "y") {
        throw new Error("crash");
      }
      return { nodeId, output: nodeId, durationMs: 1 };
    };
    const runtime = new PipelineRuntime({
      definition: twoBodyForEachPipeline(),
      nodeExecutor: crashing,
      checkpointStore: store,
    });
    const failed = await runtime.execute({ items: ["x", "y", "z"] });
    expect(failed.state).toBe("failed");

    // Same definition, but the resolved source now lists the same items in a
    // different order. The retained ordered prefix ("item 0 is done") would
    // silently name a different item.
    const checkpoint = await store.load(failed.runId);
    const reordered: string[] = [];
    const resumed = new PipelineRuntime({
      definition: twoBodyForEachPipeline(),
      nodeExecutor: recordingExecutor(reordered),
      checkpointStore: store,
    });
    // The per-loop guard fires inside the run rather than at the resume
    // boundary (the loop re-resolves its source from live state), so the
    // runtime surfaces it as a failed run carrying the mismatch, not a throw.
    const outcome = await resumed.resume(checkpoint!, {
      items: ["z", "y", "x"],
    });
    expect(outcome.state).toBe("failed");
    // No body node may run against the swapped source.
    expect(reordered).toHaveLength(0);
  });

  it("admits a resume of a pre-E3 checkpoint that carries no binding", async () => {
    // Absence must stay *unprovable*, not *agreement*: checkpoints written
    // before this packet have no binding and must keep resuming rather than
    // start hard-failing on upgrade.
    const store = new InMemoryPipelineCheckpointStore();
    const crashing: NodeExecutor = async (nodeId, _node, ctx) => {
      if (nodeId === "step-b" && String(ctx.state["item"]) === "y") {
        throw new Error("crash");
      }
      return { nodeId, output: nodeId, durationMs: 1 };
    };
    const runtime = new PipelineRuntime({
      definition: twoBodyForEachPipeline(),
      nodeExecutor: crashing,
      checkpointStore: store,
    });
    const failed = await runtime.execute({ items: ["x", "y"] });
    expect(failed.state).toBe("failed");

    // Strip the binding to emulate a checkpoint written before E3.
    const latest = await store.load(failed.runId);
    const downgraded = { ...latest! };
    delete (downgraded as { sourceBinding?: unknown }).sourceBinding;
    delete (downgraded as { loopState?: unknown }).loopState;
    await store.save(downgraded);

    const resumed = new PipelineRuntime({
      definition: twoBodyForEachPipeline(),
      nodeExecutor: recordingExecutor([]),
      checkpointStore: store,
    });
    const done = await resumed.resume(downgraded);
    expect(done.state).toBe("completed");
  });
});
