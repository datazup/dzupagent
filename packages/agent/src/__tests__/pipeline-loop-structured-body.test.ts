/** F-R4 — compiler-bounded structured loop bodies use graph scheduling. */
import { describe, expect, it } from "vitest";
import type {
  LoopNode,
  PipelineCheckpoint,
  PipelineDefinition,
  PipelineEdge,
  PipelineNode,
} from "@dzupagent/core/pipeline";
import { PipelineCheckpointSchema } from "@dzupagent/core/pipeline";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";

const typedWhile: NonNullable<LoopNode["typedWhile"]> = {
  conditionSchema: "dzupagent.flowTypedCondition/v1",
  condition: { op: "literal", value: true },
  onExhausted: "fail",
};

function definition(input: {
  bodyNodes: PipelineNode[];
  bodyEdges?: PipelineEdge[];
  entryNodeId: string;
  normalExitNodeIds: string[];
  trailingNode?: PipelineNode;
}): PipelineDefinition {
  const loop: LoopNode = {
    id: "loop",
    type: "loop",
    bodyNodeIds: input.bodyNodes.map(({ id }) => id),
    bodyGraph: {
      entryNodeId: input.entryNodeId,
      normalExitNodeIds: input.normalExitNodeIds,
      suspendedExitNodeIds: [],
      terminalExitNodeIds: [],
      errorExitNodeIds: [],
    },
    maxIterations: 3,
    continuePredicateName: "continue-loop",
    typedWhile,
  };
  return {
    id: "structured-loop",
    name: "StructuredLoop",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: loop.id,
    nodes: [loop, ...input.bodyNodes, ...(input.trailingNode ? [input.trailingNode] : [])],
    edges: [
      ...(input.bodyEdges ?? []),
      ...(input.trailingNode
        ? [
            {
              type: "sequential" as const,
              sourceNodeId: loop.id,
              targetNodeId: input.trailingNode.id,
            },
          ]
        : []),
    ],
  };
}

describe("pipeline structured loop-body scheduler", () => {
  it("follows a different conditional branch on each iteration", async () => {
    const calls: string[] = [];
    const result = await new PipelineRuntime({
      definition: definition({
        bodyNodes: [
          { id: "choose", type: "gate", gateType: "quality" },
          { id: "then", type: "agent", agentId: "then" },
          { id: "else", type: "agent", agentId: "else" },
        ],
        bodyEdges: [
          {
            type: "conditional",
            sourceNodeId: "choose",
            predicateName: "choose-then",
            branches: { true: "then", false: "else" },
          },
        ],
        entryNodeId: "choose",
        normalExitNodeIds: ["then", "else"],
      }),
      predicates: {
        "choose-then": (state) => (state["iterations"] ?? 0) === 0,
        "continue-loop": (state) => (state["iterations"] ?? 0) < 2,
      },
      nodeExecutor: async (nodeId, _node, context) => {
        calls.push(nodeId);
        if (nodeId === "then" || nodeId === "else") {
          context.state["iterations"] =
            ((context.state["iterations"] as number | undefined) ?? 0) + 1;
        }
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    }).execute();

    expect(result.state).toBe("completed");
    expect(calls).toEqual(["choose", "then", "choose", "else"]);
    expect(result.nodeResults.get("loop")?.output).toMatchObject({
      metrics: { iterationCount: 2, terminationReason: "condition_met" },
    });
  });

  it("runs every parallel branch and rejoins on every iteration", async () => {
    const calls: string[] = [];
    const result = await new PipelineRuntime({
      definition: definition({
        bodyNodes: [
          { id: "fork", type: "fork", forkId: "parallel" },
          { id: "left", type: "agent", agentId: "left" },
          { id: "right", type: "agent", agentId: "right" },
          { id: "join", type: "join", forkId: "parallel" },
        ],
        bodyEdges: [
          { type: "sequential", sourceNodeId: "fork", targetNodeId: "left" },
          { type: "sequential", sourceNodeId: "fork", targetNodeId: "right" },
          { type: "sequential", sourceNodeId: "left", targetNodeId: "join" },
          { type: "sequential", sourceNodeId: "right", targetNodeId: "join" },
        ],
        entryNodeId: "fork",
        normalExitNodeIds: ["join"],
      }),
      predicates: {
        "continue-loop": (state) => (state["left"] ?? 0) < 2,
      },
      nodeExecutor: async (nodeId, _node, context) => {
        calls.push(nodeId);
        context.state[nodeId] =
          ((context.state[nodeId] as number | undefined) ?? 0) + 1;
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    }).execute();

    expect(result.state).toBe("completed");
    expect(calls.filter((id) => id === "left")).toHaveLength(2);
    expect(calls.filter((id) => id === "right")).toHaveLength(2);
  });

  it("routes a body failure through a try/catch error edge", async () => {
    let attempts = 0;
    let recoveries = 0;
    const result = await new PipelineRuntime({
      definition: definition({
        bodyNodes: [
          { id: "risky", type: "agent", agentId: "risky" },
          { id: "recover", type: "agent", agentId: "recover" },
        ],
        bodyEdges: [
          { type: "error", sourceNodeId: "risky", targetNodeId: "recover" },
        ],
        entryNodeId: "risky",
        normalExitNodeIds: ["risky", "recover"],
      }),
      predicates: {
        "continue-loop": () => recoveries < 2,
      },
      nodeExecutor: async (nodeId) => {
        if (nodeId === "risky") {
          attempts += 1;
          return { nodeId, output: null, durationMs: 1, error: "expected" };
        }
        recoveries += 1;
        return { nodeId, output: "recovered", durationMs: 1 };
      },
    }).execute();

    expect(result.state).toBe("completed");
    expect({ attempts, recoveries }).toEqual({ attempts: 2, recoveries: 2 });
  });

  it("propagates cancellation without dispatching the outer continuation", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const errors: string[] = [];
    const result = await new PipelineRuntime({
      definition: definition({
        bodyNodes: [{ id: "work", type: "agent", agentId: "work" }],
        entryNodeId: "work",
        normalExitNodeIds: ["work"],
        trailingNode: { id: "after", type: "agent", agentId: "after" },
      }),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "pipeline:failed") errors.push(event.error);
      },
      predicates: { "continue-loop": () => true },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        controller.abort();
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    }).execute();

    expect(
      result.state,
      JSON.stringify({ results: [...result.nodeResults.entries()], errors })
    ).toBe("cancelled");
    expect(calls).toEqual(["work"]);
  });

  it("fails the loop when an uncaught graph-body node fails", async () => {
    const result = await new PipelineRuntime({
      definition: definition({
        bodyNodes: [{ id: "bad", type: "agent", agentId: "bad" }],
        entryNodeId: "bad",
        normalExitNodeIds: ["bad"],
      }),
      predicates: { "continue-loop": () => true },
      nodeExecutor: async (nodeId) => ({
        nodeId,
        output: null,
        durationMs: 1,
        error: "body exploded",
      }),
    }).execute();

    expect(result.state).toBe("failed");
    expect(result.nodeResults.get("loop")?.error).toContain("body exploded");
  });

  it("resumes a conditional body at its exact graph cursor", async () => {
    class CrashAfterPrepareStore extends InMemoryPipelineCheckpointStore {
      private crashed = false;

      override async save(checkpoint: PipelineCheckpoint): Promise<void> {
        await super.save(checkpoint);
        const graph = checkpoint.loopState?.["loop"]?.bodyGraphState;
        if (!this.crashed && graph?.nextNodeId === "consume") {
          this.crashed = true;
          throw new Error("simulated process loss after graph checkpoint");
        }
      }
    }

    const store = new CrashAfterPrepareStore();
    const graphDefinition = definition({
      bodyNodes: [
        { id: "choose", type: "gate", gateType: "quality" },
        { id: "prepare", type: "agent", agentId: "prepare" },
        { id: "consume", type: "agent", agentId: "consume" },
      ],
      bodyEdges: [
        {
          type: "conditional",
          sourceNodeId: "choose",
          predicateName: "choose-prepare",
          branches: { true: "prepare" },
        },
        {
          type: "sequential",
          sourceNodeId: "prepare",
          targetNodeId: "consume",
        },
      ],
      entryNodeId: "choose",
      normalExitNodeIds: ["consume"],
    });
    graphDefinition.checkpointStrategy = "after_each_node";

    const firstCalls: string[] = [];
    const first = new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: {
        "choose-prepare": () => true,
        "continue-loop": (state) => state["done"] !== true,
      },
      nodeExecutor: async (nodeId, _node, context) => {
        firstCalls.push(nodeId);
        if (nodeId === "prepare") context.state["prepared"] = true;
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    });

    const failed = await first.execute();
    expect(failed.state).toBe("failed");
    expect(firstCalls).toEqual(["choose", "prepare"]);
    const checkpoint = await store.load(failed.runId);
    expect(PipelineCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(checkpoint?.loopState?.["loop"]?.bodyGraphState).toMatchObject({
      completed: false,
      nextNodeId: "consume",
      completedNodeIds: ["choose", "prepare"],
    });
    expect(checkpoint?.state["loop"]).toBeUndefined();

    const resumedCalls: string[] = [];
    const resumed = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: {
        "choose-prepare": () => true,
        "continue-loop": (state) => state["done"] !== true,
      },
      nodeExecutor: async (nodeId, _node, context) => {
        resumedCalls.push(nodeId);
        if (nodeId !== "consume") {
          throw new Error(`${nodeId} must not be re-dispatched`);
        }
        expect(context.previousResults.get("prepare")?.output).toBe("prepare");
        context.state["done"] = true;
        return { nodeId, output: "consumed", durationMs: 1 };
      },
    }).resume(checkpoint!);

    expect(resumed.state).toBe("completed");
    expect(resumedCalls).toEqual(["consume"]);
    expect((await store.load(failed.runId))?.loopState?.["loop"]).toBeUndefined();
  });

  it("restores completed parallel branches before the join", async () => {
    class PauseFirstForkCheckpointStore extends InMemoryPipelineCheckpointStore {
      private paused = false;
      private readyResolve!: () => void;
      readonly ready = new Promise<void>((resolve) => {
        this.readyResolve = resolve;
      });

      override async save(checkpoint: PipelineCheckpoint): Promise<void> {
        await super.save(checkpoint);
        const branches =
          checkpoint.loopState?.["loop"]?.bodyGraphState?.forkState?.[
            "parallel"
          ]?.branches ?? {};
        const count = Object.keys(branches).length;
        if (count >= 2) this.readyResolve();
        if (!this.paused && count === 1) {
          this.paused = true;
          await new Promise<void>(() => undefined);
        }
      }
    }

    const store = new PauseFirstForkCheckpointStore();
    const graphDefinition = definition({
      bodyNodes: [
        { id: "fork", type: "fork", forkId: "parallel" },
        { id: "left", type: "agent", agentId: "left" },
        { id: "right", type: "agent", agentId: "right" },
        { id: "join", type: "join", forkId: "parallel" },
      ],
      bodyEdges: [
        { type: "sequential", sourceNodeId: "fork", targetNodeId: "left" },
        { type: "sequential", sourceNodeId: "fork", targetNodeId: "right" },
        { type: "sequential", sourceNodeId: "left", targetNodeId: "join" },
        { type: "sequential", sourceNodeId: "right", targetNodeId: "join" },
      ],
      entryNodeId: "fork",
      normalExitNodeIds: ["join"],
    });
    graphDefinition.checkpointStrategy = "after_each_node";

    const firstCalls: string[] = [];
    const firstRun = new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: {
        "continue-loop": (state) =>
          state["leftDone"] !== true || state["rightDone"] !== true,
      },
      nodeExecutor: async (nodeId, _node, context) => {
        firstCalls.push(nodeId);
        context.state[`${nodeId}Done`] = true;
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    }).execute(undefined, { runId: "parallel-restart" });
    // Model process loss by leaving the first writer suspended after it has
    // durably saved one branch. The sibling persists the shared two-branch
    // frame, which a fresh runtime can join without redispatching either body.
    void firstRun.catch(() => undefined);
    await store.ready;

    const checkpoint = await store.load("parallel-restart");
    expect(PipelineCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(
      Object.keys(
        checkpoint?.loopState?.["loop"]?.bodyGraphState?.forkState?.[
          "parallel"
        ]?.branches ?? {}
      )
    ).toHaveLength(2);
    expect(firstCalls.sort()).toEqual(["left", "right"]);

    const resumedCalls: string[] = [];
    const resumed = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: {
        "continue-loop": (state) =>
          state["leftDone"] !== true || state["rightDone"] !== true,
      },
      nodeExecutor: async (nodeId) => {
        resumedCalls.push(nodeId);
        throw new Error(`${nodeId} must be restored, not re-dispatched`);
      },
    }).resume(checkpoint!);

    expect(resumed.state).toBe("completed");
    expect(resumedCalls).toEqual([]);
  });
});
