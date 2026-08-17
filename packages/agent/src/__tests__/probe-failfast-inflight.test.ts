/** TEMPORARY PROBE — not a deliverable. Prints the real failFast N>1 behaviour. */
import { describe, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";

function pipeline(concurrency: number, failFast: boolean): PipelineDefinition {
  return {
    id: "probe-failfast",
    name: "ProbeFailFast",
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
          concurrency,
          failFast,
          collect: { from: "$.item.id", into: "$.gathered" },
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

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

const ITEMS = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

describe("PROBE failFast in-flight", () => {
  it("CONTROL: prints the dispatch sequence at N=1 with failFast true", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: pipeline(1, true),
      nodeExecutor: async (nodeId: string, _node: PipelineNode, ctx) => {
        const item = ctx.state["item"] as { id: string };
        runs.push(`${item.id}:${nodeId}`);
        if (item.id === "a" && nodeId === "step-a") {
          return { nodeId, output: null, durationMs: 1, error: "a fails" };
        }
        return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
      },
      checkpointStore: store,
    });
    const result = await runtime.execute({ items: ITEMS });
    const checkpoint = await store.load(result.runId);
    console.log("CONTROL N=1 runs     =", JSON.stringify(runs));
    console.log(
      "CONTROL N=1 outcomes =",
      JSON.stringify(checkpoint?.loopState?.["loop-items"]?.itemOutcomes ?? {})
    );
  });

  it("prints the dispatch sequence at N=2 with failFast true", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const runs: string[] = [];
    let sawOverlap = false;
    // item 'a' fails at step-a; item 'b' is parked mid-body until that happens.
    const aFailed = deferred();

    const runtime = new PipelineRuntime({
      definition: pipeline(2, true),
      nodeExecutor: async (nodeId: string, _node: PipelineNode, ctx) => {
        const item = ctx.state["item"] as { id: string };
        runs.push(`${item.id}:${nodeId}`);

        if (item.id === "b" && nodeId === "step-a") {
          // hold item b in flight until a has failed
          await aFailed.promise;
          sawOverlap = true;
        }
        if (item.id === "a" && nodeId === "step-a") {
          aFailed.release();
          return {
            nodeId,
            output: null,
            durationMs: 1,
            error: "a fails at step-a",
          };
        }
        return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
      },
      checkpointStore: store,
    });

    const result = await runtime.execute({ items: ITEMS });
    const checkpoint = await store.load(result.runId);
    const loopState = checkpoint?.loopState?.["loop-items"];

    console.log("PROBE state       =", result.state);
    console.log("PROBE sawOverlap  =", sawOverlap);
    console.log("PROBE runs        =", JSON.stringify(runs));
    console.log(
      "PROBE outcomes    =",
      JSON.stringify(loopState?.itemOutcomes ?? {}, null, 0)
    );
    console.log("PROBE iteration   =", loopState?.iteration);
  });
});
