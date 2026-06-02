/**
 * W3 — durable loop resume.
 *
 * Verifies that a loop node checkpoints its iteration cursor after each
 * iteration, and that a mid-loop crash resumes from the next iteration rather
 * than restarting the loop body from zero.
 */
import { describe, it, expect } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type { PipelineDefinition } from "@dzupagent/core";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

/**
 * Pipeline: entry loop `L` whose body is node `work`. The loop continues while
 * `state.counter < target`. `work` increments `state.counter` each iteration.
 */
function loopPipeline(target: number): PipelineDefinition {
  return {
    id: "loop-resume",
    name: "LoopResume",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "L",
    checkpointStrategy: "after_each_node",
    nodes: [
      {
        id: "L",
        type: "loop",
        bodyNodeIds: ["work"],
        maxIterations: target + 5,
        continuePredicateName: "belowTarget",
      },
      { id: "work", type: "agent", agentId: "w", timeoutMs: 5000 },
    ],
    edges: [],
    predicates: {
      belowTarget: (s) => Number(s["counter"] ?? 0) < target,
    } as never,
  } as PipelineDefinition;
}

describe("durable loop resume (W3)", () => {
  it("checkpoints the loop iteration cursor after each iteration", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const target = 3;
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      const next = Number(ctx.state["counter"] ?? 0) + 1;
      ctx.state["counter"] = next;
      return { nodeId, output: next, durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: loopPipeline(target),
      nodeExecutor: executor,
      checkpointStore: store,
      predicates: { belowTarget: (s) => Number(s["counter"] ?? 0) < target },
    });

    const result = await runtime.execute();
    expect(result.state).toBe("completed");

    // After completion the loop cursor is cleared (loop no longer mid-flight).
    const finalCheckpoint = await store.load(result.runId);
    expect(finalCheckpoint?.loopState?.["L"]).toBeUndefined();

    // But a mid-run version recorded the cursor — version 1 = after iteration 1.
    const v1 = await store.loadVersion(result.runId, 1);
    expect(v1?.loopState?.["L"]).toEqual({ iteration: 1 });
  });

  it("resumes a mid-loop crash from the next iteration without re-running completed iterations", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const target = 4;
    const bodyRuns: number[] = [];

    // First runtime: crash on the 3rd body execution to simulate a mid-loop crash.
    const crashingExecutor: NodeExecutor = async (nodeId, _node, ctx) => {
      const next = Number(ctx.state["counter"] ?? 0) + 1;
      bodyRuns.push(next);
      if (next === 3) throw new Error("simulated crash mid-loop");
      ctx.state["counter"] = next;
      return { nodeId, output: next, durationMs: 1 };
    };

    const first = new PipelineRuntime({
      definition: loopPipeline(target),
      nodeExecutor: crashingExecutor,
      checkpointStore: store,
      predicates: { belowTarget: (s) => Number(s["counter"] ?? 0) < target },
    });

    const firstResult = await first.execute();
    expect(firstResult.state).toBe("failed");
    // Two iterations completed (counter=1, counter=2) before the crash on the 3rd.
    expect(bodyRuns).toEqual([1, 2, 3]);

    const checkpoint = await store.load(firstResult.runId);
    expect(checkpoint?.loopState?.["L"]).toEqual({ iteration: 2 });
    expect(checkpoint?.state?.["counter"]).toBe(2);

    // Second runtime resumes; the body must NOT re-run for iterations 1 and 2.
    const resumeRuns: number[] = [];
    const healthyExecutor: NodeExecutor = async (nodeId, _node, ctx) => {
      const next = Number(ctx.state["counter"] ?? 0) + 1;
      resumeRuns.push(next);
      ctx.state["counter"] = next;
      return { nodeId, output: next, durationMs: 1 };
    };

    const second = new PipelineRuntime({
      definition: loopPipeline(target),
      nodeExecutor: healthyExecutor,
      checkpointStore: store,
      predicates: { belowTarget: (s) => Number(s["counter"] ?? 0) < target },
    });

    const resumed = await second.resume(checkpoint!);
    expect(resumed.state).toBe("completed");

    // Resume picks up at counter=2 and runs iterations 3 and 4 only.
    expect(resumeRuns).toEqual([3, 4]);
  });
});
