/**
 * Doc 27 §8 minimum proof 5, contract and cursor sub-parts: a `for_each`
 * resume whose aggregation CONTRACT or item COUNT drifted is refused before
 * any body node dispatches.
 *
 * WHY THERE IS NO NEW BINDING FIELD HERE. Prereq 1 lists a "normalized
 * `forEach` contract digest" and an "item count" alongside the definition and
 * source digests. Implementing them as separate checkpoint fields was
 * attempted and REVERTED: both are already subsumed, and the guards that
 * subsume them are strictly stronger.
 *
 *  - The `forEach` contract lives INSIDE the pipeline definition, so any
 *    contract change necessarily changes `sourceBinding.definitionDigest` —
 *    which `assertCheckpointSourceBinding` checks at the resume boundary,
 *    BEFORE checkpoint state is overlaid and before the loop stage runs. A
 *    separate contract digest could therefore never fire: every input that
 *    would trip it trips the definition digest first. Verified directly —
 *    `digestPipelineDefinition` over two definitions differing only in
 *    `collect.into` yields different digests (pinned below).
 *  - The item count is subsumed by `loopSourceDigests`, which digests the
 *    whole resolved array. Any length change alters the array digest, so a
 *    count check can only ever agree with a comparison that already failed.
 *
 * Shipping either field would have added a guard no input can reach — dead
 * code that reads as protection. These tests pin the coverage that genuinely
 * exists instead, and pin the SUBSUMPTION so a future change that weakens
 * either digest (e.g. digesting only item identity, or excluding the loop
 * contract from the definition digest) fails here rather than silently
 * reopening the gap.
 */
import { describe, it, expect } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { PipelineSourceBindingMismatchError } from "../pipeline/pipeline-runtime-lifecycle/resume-context.js";
import {
  digestPipelineDefinition,
  digestPipelineInteractionValue,
} from "@dzupagent/runtime-contracts";
import type {
  PipelineDefinition,
  LoopNode,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

type ForEachContract = NonNullable<LoopNode["forEach"]>;

/** A `for_each` with an authored `collect`, so the contract has rules to drift. */
function collectingPipeline(
  overrides: Partial<ForEachContract> = {},
): PipelineDefinition {
  return {
    id: "for-each-contract-drift",
    name: "ForEachContractDrift",
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
          collect: { from: "out", into: "results", order: "input" },
          concurrency: 1,
          empty: { body: "skip", aggregate: "empty-array" },
          ...overrides,
        },
      },
      { id: "step-a", type: "agent", agentId: "a", timeoutMs: 5000 },
      { id: "step-b", type: "agent", agentId: "b", timeoutMs: 5000 },
    ],
    edges: [],
  } as unknown as PipelineDefinition;
}

/** Crashes inside item "y", leaving a retained ordered prefix of one item. */
const crashingExecutor: NodeExecutor = async (nodeId, _node, ctx) => {
  if (nodeId === "step-b" && String(ctx.state["item"]) === "y") {
    throw new Error("crash");
  }
  return { nodeId, output: nodeId, durationMs: 1 };
};

function recordingExecutor(dispatches: string[]): NodeExecutor {
  return async (nodeId, _node, ctx) => {
    dispatches.push(`${nodeId}:${String(ctx.state["item"])}`);
    return { nodeId, output: nodeId, durationMs: 1 };
  };
}

/** Run until the seeded crash so a real checkpoint with a real binding exists. */
async function runUntilCrash(
  definition: PipelineDefinition,
  items: string[] = ["x", "y"],
) {
  const store = new InMemoryPipelineCheckpointStore();
  const runtime = new PipelineRuntime({
    definition,
    nodeExecutor: crashingExecutor,
    checkpointStore: store,
  });
  const failed = await runtime.execute({ items });
  expect(failed.state).toBe("failed");
  return { store, runId: failed.runId };
}

describe("for_each contract drift is subsumed by the definition digest", () => {
  it("the definition digest changes when only the collect target changes", () => {
    // This is the load-bearing subsumption fact. If this ever becomes `toBe`,
    // a contract drift would stop being caught at the resume boundary and the
    // separate contract digest prereq 1 describes would become necessary.
    expect(digestPipelineDefinition(collectingPipeline())).not.toBe(
      digestPipelineDefinition(
        collectingPipeline({
          collect: { from: "out", into: "moved", order: "input" },
        }),
      ),
    );
  });

  it.each([
    [
      "collect.into",
      { collect: { from: "out", into: "moved", order: "input" } },
    ],
    ["as", { as: "element" }],
    ["attachAs", { attachAs: "enriched" }],
    ["accumulator", { accumulator: { key: "acc" } }],
  ])(
    "refuses a resume whose %s drifted, before any body node runs",
    async (_label, override) => {
      const { store, runId } = await runUntilCrash(collectingPipeline());
      const checkpoint = await store.load(runId);

      const dispatches: string[] = [];
      const resumed = new PipelineRuntime({
        definition: collectingPipeline(override as Partial<ForEachContract>),
        nodeExecutor: recordingExecutor(dispatches),
        checkpointStore: store,
      });

      await expect(resumed.resume(checkpoint!)).rejects.toThrow(
        PipelineSourceBindingMismatchError,
      );
      // Fail closed: the retained prefix was aggregated under the old rules,
      // so nothing may execute under the new ones.
      expect(dispatches).toHaveLength(0);
    },
  );

  it("admits a resume whose contract is unchanged", async () => {
    // The negative control for this whole block. Without it, an enforcement
    // that refused EVERY resume would pass every test above.
    const { store, runId } = await runUntilCrash(collectingPipeline());
    const checkpoint = await store.load(runId);

    const dispatches: string[] = [];
    const resumed = new PipelineRuntime({
      definition: collectingPipeline(),
      nodeExecutor: recordingExecutor(dispatches),
      checkpointStore: store,
    });
    const outcome = await resumed.resume(checkpoint!);

    expect(outcome.state).toBe("completed");
    // It genuinely resumed rather than restarting: the crashed item is
    // re-attempted, and the committed one is not.
    expect(dispatches.some((entry) => entry.endsWith(":y"))).toBe(true);
    expect(dispatches.some((entry) => entry.endsWith(":x"))).toBe(false);
  });
});

describe("for_each item-count drift is subsumed by the source digest", () => {
  it("the source digest distinguishes arrays of different length", () => {
    // The subsumption fact for the item count. A digest that ignored length
    // would make a separate count check necessary.
    expect(digestPipelineInteractionValue(["x"])).not.toBe(
      digestPipelineInteractionValue(["x", "x"]),
    );
  });

  it("refuses a resume whose item source was truncated", async () => {
    const { store, runId } = await runUntilCrash(collectingPipeline(), [
      "x",
      "y",
      "z",
    ]);
    const checkpoint = await store.load(runId);

    // Same definition, and the surviving items are a genuine PREFIX of the
    // original in the same order — so an index-only cursor check would admit
    // this. The retained prefix nonetheless refers to a different item set.
    const dispatches: string[] = [];
    const resumed = new PipelineRuntime({
      definition: collectingPipeline(),
      nodeExecutor: recordingExecutor(dispatches),
      checkpointStore: store,
    });
    const outcome = await resumed.resume(checkpoint!, { items: ["x"] });

    // The per-loop guard fires inside the run (the loop re-resolves its source
    // from live state), so it surfaces as a failed run rather than a throw.
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("loop-items");
    expect(dispatches).toHaveLength(0);
  });

  it("refuses a resume whose item source grew", async () => {
    const { store, runId } = await runUntilCrash(collectingPipeline());
    const checkpoint = await store.load(runId);

    const dispatches: string[] = [];
    const resumed = new PipelineRuntime({
      definition: collectingPipeline(),
      nodeExecutor: recordingExecutor(dispatches),
      checkpointStore: store,
    });
    const outcome = await resumed.resume(checkpoint!, {
      items: ["x", "y", "z"],
    });

    expect(outcome.state).toBe("failed");
    expect(dispatches).toHaveLength(0);
  });

  it("admits a resume whose item source is unchanged", async () => {
    // Negative control: proves the two refusals above depend on the source
    // changing, not on `additionalState` being supplied at all.
    const { store, runId } = await runUntilCrash(collectingPipeline());
    const checkpoint = await store.load(runId);

    const resumed = new PipelineRuntime({
      definition: collectingPipeline(),
      nodeExecutor: recordingExecutor([]),
      checkpointStore: store,
    });
    const outcome = await resumed.resume(checkpoint!, { items: ["x", "y"] });

    expect(outcome.state).toBe("completed");
  });
});
