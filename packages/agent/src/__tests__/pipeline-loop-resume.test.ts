/**
 * W3 — durable loop resume.
 *
 * Verifies that a loop node checkpoints both its iteration cursor and its
 * mid-iteration body-node cursor, and that resume never re-dispatches work
 * already represented by durable checkpoint evidence.
 */
import { describe, it, expect } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type { LoopCheckpointState } from "../pipeline/pipeline-runtime/executor-state-types.js";
import type { PipelineCheckpoint, PipelineDefinition } from "@dzupagent/core";
import type {
  NodeExecutor,
  PipelineRuntimeEvent,
} from "../pipeline/pipeline-runtime-types.js";

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
      belowTarget: (s: Record<string, unknown>) =>
        Number(s["counter"] ?? 0) < target,
    } as never,
  } as PipelineDefinition;
}

describe("durable loop resume (W3)", () => {
  it("checkpoints body progress before advancing the iteration cursor", async () => {
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

    // The first version is written after the body node succeeds, before the
    // iteration boundary advances. It retains the result required to resume
    // without dispatching the body again.
    const v1 = await store.loadVersion(result.runId, 1);
    expect(v1?.loopState?.["L"]).toMatchObject({
      iteration: 0,
      nextBodyNodeIndex: 1,
      bodyResults: {
        work: { nodeId: "work", output: 1, durationMs: 1 },
      },
    });

    // The following write records the fully-completed iteration and clears
    // the body cursor/results.
    const v2 = await store.loadVersion(result.runId, 2);
    expect(v2?.loopState?.["L"]).toEqual({
      iteration: 1,
      previousOutput: 1,
    });
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
    expect(checkpoint?.loopState?.["L"]).toEqual({
      iteration: 2,
      previousOutput: 2,
    });
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

  it("resumes at the next body node with retained previousResults", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const definition: PipelineDefinition = {
      id: "loop-body-resume",
      name: "LoopBodyResume",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      entryNodeId: "L",
      checkpointStrategy: "after_each_node",
      nodes: [
        {
          id: "L",
          type: "loop",
          bodyNodeIds: ["prepare", "consume"],
          maxIterations: 3,
          continuePredicateName: "notDone",
        },
        { id: "prepare", type: "agent", agentId: "prepare", timeoutMs: 5000 },
        { id: "consume", type: "agent", agentId: "consume", timeoutMs: 5000 },
      ],
      edges: [],
    };
    const firstRuns: string[] = [];
    const first = new PipelineRuntime({
      definition,
      checkpointStore: store,
      predicates: { notDone: (state) => state["done"] !== true },
      nodeExecutor: async (nodeId, _node, context) => {
        firstRuns.push(nodeId);
        if (nodeId === "prepare") {
          context.state["prepared"] = true;
          return {
            nodeId,
            output: { handoff: "retained" },
            durationMs: 1,
            providerSessionRefs: [
              { provider: "test", sessionId: "opaque-test-session" },
            ],
          };
        }
        throw new Error("simulated crash before consume completes");
      },
    });

    const failed = await first.execute();
    expect(failed.state).toBe("failed");
    expect(firstRuns).toEqual(["prepare", "consume"]);
    const checkpoint = await store.load(failed.runId);
    expect(checkpoint?.loopState?.["L"]).toMatchObject({
      iteration: 0,
      nextBodyNodeIndex: 1,
      bodyResults: {
        prepare: {
          nodeId: "prepare",
          output: { handoff: "retained" },
          durationMs: 1,
        },
      },
    });
    expect(checkpoint?.state["prepared"]).toBe(true);
    expect(checkpoint?.state["loop"]).toBeUndefined();
    const retainedPrepare = (
      checkpoint?.loopState?.["L"] as LoopCheckpointState | undefined
    )?.bodyResults?.["prepare"] as Record<string, unknown> | undefined;
    expect(retainedPrepare).not.toHaveProperty("providerSessionRefs");
    expect(checkpoint?.providerSessionRefs).toBeUndefined();

    const resumeRuns: string[] = [];
    let observedHandoff: unknown;
    const second = new PipelineRuntime({
      definition,
      checkpointStore: store,
      predicates: { notDone: (state) => state["done"] !== true },
      nodeExecutor: async (nodeId, _node, context) => {
        resumeRuns.push(nodeId);
        if (nodeId === "prepare") {
          throw new Error("prepare must not be re-dispatched");
        }
        observedHandoff = context.previousResults.get("prepare")?.output;
        context.state["done"] = true;
        return { nodeId, output: "consumed", durationMs: 1 };
      },
    });

    const resumed = await second.resume(checkpoint!);
    expect(resumed.state).toBe("completed");
    expect(resumeRuns).toEqual(["consume"]);
    expect(observedHandoff).toEqual({ handoff: "retained" });
    expect((await store.load(failed.runId))?.loopState?.["L"]).toBeUndefined();
  });

  it("does not re-dispatch the last body node when iteration advance fails", async () => {
    class FailFirstIterationAdvanceStore extends InMemoryPipelineCheckpointStore {
      private rejected = false;

      override async save(checkpoint: PipelineCheckpoint): Promise<void> {
        const cursor = checkpoint.loopState?.["L"] as
          | LoopCheckpointState
          | undefined;
        if (
          !this.rejected &&
          cursor?.iteration === 1 &&
          cursor.nextBodyNodeIndex === undefined
        ) {
          this.rejected = true;
          throw new Error("simulated iteration-advance checkpoint failure");
        }
        await super.save(checkpoint);
      }
    }

    const store = new FailFirstIterationAdvanceStore();
    const definition: PipelineDefinition = {
      id: "loop-last-body-resume",
      name: "LoopLastBodyResume",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      entryNodeId: "L",
      checkpointStrategy: "after_each_node",
      nodes: [
        {
          id: "L",
          type: "loop",
          bodyNodeIds: ["first", "last"],
          maxIterations: 3,
          continuePredicateName: "notDone",
        },
        { id: "first", type: "agent", agentId: "first", timeoutMs: 5000 },
        { id: "last", type: "agent", agentId: "last", timeoutMs: 5000 },
      ],
      edges: [],
    };
    const firstRuns: string[] = [];
    const first = new PipelineRuntime({
      definition,
      checkpointStore: store,
      predicates: { notDone: (state) => state["done"] !== true },
      nodeExecutor: async (nodeId, _node, context) => {
        firstRuns.push(nodeId);
        if (nodeId === "last") context.state["done"] = true;
        return { nodeId, output: `output:${nodeId}`, durationMs: 1 };
      },
    });

    const failed = await first.execute();
    expect(failed.state).toBe("failed");
    expect(firstRuns).toEqual(["first", "last"]);
    const checkpoint = await store.load(failed.runId);
    expect(checkpoint?.loopState?.["L"]).toMatchObject({
      iteration: 0,
      nextBodyNodeIndex: 2,
      bodyResults: {
        first: { nodeId: "first", output: "output:first", durationMs: 1 },
        last: { nodeId: "last", output: "output:last", durationMs: 1 },
      },
    });

    const resumeRuns: string[] = [];
    const second = new PipelineRuntime({
      definition,
      checkpointStore: store,
      predicates: { notDone: (state) => state["done"] !== true },
      nodeExecutor: async (nodeId) => {
        resumeRuns.push(nodeId);
        throw new Error(`body node ${nodeId} must not be re-dispatched`);
      },
    });

    const resumed = await second.resume(checkpoint!);
    expect(resumed.state).toBe("completed");
    expect(resumeRuns).toEqual([]);
    expect(resumed.nodeResults.get("L")?.output).toMatchObject({
      loopOutput: "output:last",
    });
  });

  it("retains progress evidence across restart and halts repeated output", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const definition: PipelineDefinition = {
      id: "loop-progress-resume",
      name: "LoopProgressResume",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      entryNodeId: "L",
      checkpointStrategy: "after_each_node",
      nodes: [
        {
          id: "L",
          type: "loop",
          bodyNodeIds: ["work"],
          maxIterations: 5,
          continuePredicateName: "always",
          typedWhile: {
            conditionSchema: "dzupagent.flowTypedCondition/v1",
            condition: { op: "literal", value: true },
            onExhausted: "continue",
            progressKey: "work",
          },
        },
        { id: "work", type: "agent", agentId: "work", timeoutMs: 5000 },
      ],
      edges: [],
    };
    let firstCalls = 0;
    const first = new PipelineRuntime({
      definition,
      checkpointStore: store,
      predicates: { always: () => true },
      nodeExecutor: async (nodeId) => {
        firstCalls++;
        if (firstCalls === 2) throw new Error("simulated process loss");
        return { nodeId, output: { revision: "same" }, durationMs: 1 };
      },
    });

    const failed = await first.execute();
    expect(failed.state).toBe("failed");
    const checkpoint = await store.load(failed.runId);
    const cursor = checkpoint?.loopState?.["L"] as
      | LoopCheckpointState
      | undefined;
    expect(cursor).toMatchObject({
      iteration: 1,
      previousOutput: { revision: "same" },
    });
    expect(cursor?.progressDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(checkpoint?.state["loop"]).toBeUndefined();

    const resumeRuns: string[] = [];
    const second = new PipelineRuntime({
      definition,
      checkpointStore: store,
      predicates: { always: () => true },
      nodeExecutor: async (nodeId) => {
        resumeRuns.push(nodeId);
        return { nodeId, output: { revision: "same" }, durationMs: 1 };
      },
    });

    const resumed = await second.resume(checkpoint!);
    expect(resumed.state).toBe("failed");
    expect(resumeRuns).toEqual(["work"]);
    expect(resumed.nodeResults.get("L")?.error).toMatch(/made no progress/);
  });

  it("restores predicate-loop cost and never re-charges a retained body result", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const definition: PipelineDefinition = {
      id: "loop-budget-resume",
      name: "LoopBudgetResume",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      entryNodeId: "L",
      checkpointStrategy: "after_each_node",
      nodes: [
        {
          id: "L",
          type: "loop",
          bodyNodeIds: ["prepare", "consume"],
          maxIterations: 2,
          continuePredicateName: "notDone",
        },
        { id: "prepare", type: "agent", agentId: "prepare", timeoutMs: 5000 },
        { id: "consume", type: "agent", agentId: "consume", timeoutMs: 5000 },
      ],
      edges: [],
    };
    const extractCost = (nodeId: string): number =>
      nodeId === "prepare" ? 6 : 5;

    const firstRuns: string[] = [];
    const first = new PipelineRuntime({
      definition,
      checkpointStore: store,
      predicates: { notDone: (state) => state["done"] !== true },
      iterationBudget: { maxCostCents: 10, extractCost },
      nodeExecutor: async (nodeId) => {
        firstRuns.push(nodeId);
        if (nodeId === "consume") throw new Error("simulated process loss");
        return { nodeId, output: "prepared", durationMs: 1 };
      },
    });

    const failed = await first.execute();
    expect(failed.state).toBe("failed");
    expect(firstRuns).toEqual(["prepare", "consume"]);
    const checkpoint = await store.load(failed.runId);
    expect(checkpoint?.budgetState).toEqual({ tokensUsed: 0, costCents: 6 });
    expect(checkpoint?.loopState?.["L"]).toMatchObject({
      iteration: 0,
      nextBodyNodeIndex: 1,
    });

    const resumeRuns: string[] = [];
    const events: PipelineRuntimeEvent[] = [];
    const second = new PipelineRuntime({
      definition,
      checkpointStore: store,
      predicates: { notDone: (state) => state["done"] !== true },
      iterationBudget: { maxCostCents: 10, extractCost },
      onEvent: (event) => events.push(event),
      nodeExecutor: async (nodeId, _node, context) => {
        resumeRuns.push(nodeId);
        if (nodeId === "prepare") {
          throw new Error("retained prepare result must not be re-dispatched");
        }
        context.state["done"] = true;
        return { nodeId, output: "consumed", durationMs: 1 };
      },
    });

    const resumed = await second.resume(checkpoint!);
    expect(resumed.state).toBe("failed");
    expect(resumeRuns).toEqual(["consume"]);
    expect(resumed.nodeResults.get("L")?.error).toMatch(
      /iteration budget exceeded: 11 of 10 cents spent/
    );
    expect(
      events.find(
        (event) =>
          event.type === "pipeline:iteration_budget_warning" &&
          event.level === "exceeded"
      )
    ).toMatchObject({ totalCost: 11, budgetCents: 10, iteration: 1 });
  });
});
