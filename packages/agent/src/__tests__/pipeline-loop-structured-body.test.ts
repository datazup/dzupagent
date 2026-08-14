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

  it.each(["branch", "join"] as const)(
    "fails closed when a fork %s checkpoint cannot be acknowledged",
    async (failureBoundary) => {
      class ForkCheckpointFailureStore extends InMemoryPipelineCheckpointStore {
        private failed = false;

        override async save(checkpoint: PipelineCheckpoint): Promise<void> {
          await super.save(checkpoint);
          const graph = checkpoint.loopState?.["loop"]?.bodyGraphState;
          const shouldFail =
            failureBoundary === "branch"
              ? graph?.forkState?.["parallel"] !== undefined
              : graph?.completed === true &&
                graph.completedNodeIds.includes("join");
          if (!this.failed && shouldFail) {
            this.failed = true;
            throw new Error(`simulated ${failureBoundary} checkpoint loss`);
          }
        }
      }

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
      graphDefinition.nodes.push({
        id: "transport-catch",
        type: "agent",
        agentId: "transport-catch",
      });
      graphDefinition.edges.push({
        type: "error",
        sourceNodeId: "loop",
        targetNodeId: "transport-catch",
      });

      const calls: string[] = [];
      const errors: string[] = [];
      const failed = await new PipelineRuntime({
        definition: graphDefinition,
        checkpointStore: new ForkCheckpointFailureStore(),
        predicates: { "continue-loop": () => true },
        onEvent: (event) => {
          if (event.type === "pipeline:failed") errors.push(event.error);
        },
        nodeExecutor: async (nodeId) => {
          calls.push(nodeId);
          return { nodeId, output: nodeId, durationMs: 1 };
        },
      }).execute(undefined, { runId: `fork-${failureBoundary}-transport` });

      expect(failed.state).toBe("failed");
      expect(calls).not.toContain("transport-catch");
      expect(errors).toContainEqual(
        expect.stringContaining("checkpoint integrity failure")
      );
      expect(errors).toContainEqual(
        expect.stringContaining(`fork_${failureBoundary}_completion`)
      );
    }
  );

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

  it("resumes at catch after process loss before catch dispatch", async () => {
    class CrashAfterErrorCursorStore extends InMemoryPipelineCheckpointStore {
      private crashed = false;

      override async save(checkpoint: PipelineCheckpoint): Promise<void> {
        await super.save(checkpoint);
        const graph = checkpoint.loopState?.["loop"]?.bodyGraphState;
        if (!this.crashed && graph?.nextNodeId === "recover") {
          this.crashed = true;
          throw new Error("simulated process loss before catch dispatch");
        }
      }
    }

    const store = new CrashAfterErrorCursorStore();
    const graphDefinition = definition({
      bodyNodes: [
        { id: "risky", type: "agent", agentId: "risky" },
        { id: "recover", type: "agent", agentId: "recover" },
      ],
      bodyEdges: [
        { type: "error", sourceNodeId: "risky", targetNodeId: "recover" },
      ],
      entryNodeId: "risky",
      normalExitNodeIds: ["recover"],
    });
    graphDefinition.checkpointStrategy = "after_each_node";
    graphDefinition.resume = { onProcessRestart: "resume_from_checkpoint" };

    const firstCalls: string[] = [];
    const firstErrors: string[] = [];
    const failed = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: { "continue-loop": (state) => state["done"] !== true },
      onEvent: (event) => {
        if (event.type === "pipeline:failed") firstErrors.push(event.error);
      },
      nodeExecutor: async (nodeId) => {
        firstCalls.push(nodeId);
        if (nodeId === "risky") {
          return { nodeId, output: null, durationMs: 1, error: "expected" };
        }
        throw new Error("catch must not run after checkpoint transport loss");
      },
    }).execute(undefined, { runId: "try-before-catch-restart" });

    expect(failed.state).toBe("failed");
    expect(firstCalls).toEqual(["risky"]);
    expect(firstErrors).toContainEqual(
      expect.stringContaining("checkpoint integrity failure")
    );
    const checkpoint = await store.load(failed.runId);
    expect(checkpoint?.loopState?.["loop"]?.bodyGraphState).toMatchObject({
      completed: false,
      nextNodeId: "recover",
      completedNodeIds: [],
      nodeResults: {
        risky: { nodeId: "risky", error: "expected" },
      },
    });

    const resumedCalls: string[] = [];
    const resumed = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: { "continue-loop": (state) => state["done"] !== true },
      nodeExecutor: async (nodeId, _node, context) => {
        resumedCalls.push(nodeId);
        if (nodeId !== "recover") {
          throw new Error(`${nodeId} must not be re-dispatched`);
        }
        context.state["done"] = true;
        return { nodeId, output: "recovered", durationMs: 1 };
      },
    }).resume(checkpoint!);

    expect(resumed.state).toBe("completed");
    expect(resumedCalls).toEqual(["recover"]);
  });

  it("resumes a completed catch body after process loss at its checkpoint", async () => {
    class CrashAfterCatchCheckpointStore extends InMemoryPipelineCheckpointStore {
      private crashed = false;

      override async save(checkpoint: PipelineCheckpoint): Promise<void> {
        await super.save(checkpoint);
        const graph = checkpoint.loopState?.["loop"]?.bodyGraphState;
        if (
          !this.crashed &&
          graph?.completed === true &&
          graph.completedNodeIds.includes("recover")
        ) {
          this.crashed = true;
          throw new Error("simulated process loss after catch checkpoint");
        }
      }
    }

    const store = new CrashAfterCatchCheckpointStore();
    const graphDefinition = definition({
      bodyNodes: [
        { id: "risky", type: "agent", agentId: "risky" },
        { id: "recover", type: "agent", agentId: "recover" },
      ],
      bodyEdges: [
        { type: "error", sourceNodeId: "risky", targetNodeId: "recover" },
      ],
      entryNodeId: "risky",
      normalExitNodeIds: ["recover"],
    });
    graphDefinition.checkpointStrategy = "after_each_node";
    graphDefinition.resume = { onProcessRestart: "resume_from_checkpoint" };

    const firstCalls: string[] = [];
    const failed = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: { "continue-loop": (state) => state["done"] !== true },
      nodeExecutor: async (nodeId, _node, context) => {
        firstCalls.push(nodeId);
        if (nodeId === "risky") {
          return { nodeId, output: null, durationMs: 1, error: "expected" };
        }
        context.state["done"] = true;
        return { nodeId, output: "recovered", durationMs: 1 };
      },
    }).execute(undefined, { runId: "try-after-catch-restart" });

    expect(failed.state).toBe("failed");
    expect(firstCalls).toEqual(["risky", "recover"]);
    const checkpoint = await store.load(failed.runId);
    expect(checkpoint?.loopState?.["loop"]?.bodyGraphState).toMatchObject({
      completed: true,
      completedNodeIds: ["recover"],
    });

    const resumedCalls: string[] = [];
    const resumed = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: { "continue-loop": (state) => state["done"] !== true },
      nodeExecutor: async (nodeId) => {
        resumedCalls.push(nodeId);
        throw new Error(`${nodeId} must be restored, not re-dispatched`);
      },
    }).resume(checkpoint!);

    expect(resumed.state).toBe("completed");
    expect(resumedCalls).toEqual([]);
  });

  it("never routes a successful-node checkpoint failure into its catch edge", async () => {
    class CrashAfterSuccessCursorStore extends InMemoryPipelineCheckpointStore {
      private crashed = false;

      override async save(checkpoint: PipelineCheckpoint): Promise<void> {
        await super.save(checkpoint);
        const graph = checkpoint.loopState?.["loop"]?.bodyGraphState;
        if (
          !this.crashed &&
          graph?.nextNodeId === "finish" &&
          graph.completedNodeIds.includes("risky")
        ) {
          this.crashed = true;
          throw new Error("checkpoint transport unavailable");
        }
      }
    }

    const store = new CrashAfterSuccessCursorStore();
    const graphDefinition = definition({
      bodyNodes: [
        { id: "risky", type: "agent", agentId: "risky" },
        { id: "recover", type: "agent", agentId: "recover" },
        { id: "finish", type: "agent", agentId: "finish" },
      ],
      bodyEdges: [
        { type: "sequential", sourceNodeId: "risky", targetNodeId: "finish" },
        { type: "error", sourceNodeId: "risky", targetNodeId: "recover" },
        { type: "sequential", sourceNodeId: "recover", targetNodeId: "finish" },
      ],
      entryNodeId: "risky",
      normalExitNodeIds: ["finish"],
    });
    graphDefinition.checkpointStrategy = "after_each_node";

    const calls: string[] = [];
    const errors: string[] = [];
    const failed = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: { "continue-loop": () => true },
      onEvent: (event) => {
        if (event.type === "pipeline:failed") errors.push(event.error);
      },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        if (nodeId === "recover") {
          throw new Error("checkpoint failure was falsely caught");
        }
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    }).execute(undefined, { runId: "checkpoint-not-workflow-error" });

    expect(failed.state).toBe("failed");
    expect(calls).toEqual(["risky"]);
    expect(errors).toContainEqual(
      expect.stringContaining("checkpoint integrity failure")
    );
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

  const corruptDefinition = definition({
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

  const result = (nodeId: string) => ({
    nodeId,
    output: nodeId,
    durationMs: 1,
  });

  const incompleteCursor = () => ({
    completed: false,
    nextNodeId: "fork",
    completedNodeIds: [] as string[],
    nodeResults: {} as Record<string, unknown>,
    nodeIdempotencyKeys: {} as Record<string, string>,
  });

  it.each([
    {
      name: "unknown next node",
      fragment: 'next node "ghost" is outside bodyNodeIds',
      state: () => ({ ...incompleteCursor(), nextNodeId: "ghost" }),
    },
    {
      name: "unknown completed node",
      fragment: 'completed node "ghost" is outside bodyNodeIds',
      state: () => ({ ...incompleteCursor(), completedNodeIds: ["ghost"] }),
    },
    {
      name: "unknown result node",
      fragment: 'result "ghost" is outside bodyNodeIds',
      state: () => ({
        ...incompleteCursor(),
        nodeResults: { ghost: result("ghost") },
      }),
    },
    {
      name: "unknown idempotency node",
      fragment: 'idempotency node "ghost" is outside bodyNodeIds',
      state: () => ({
        ...incompleteCursor(),
        nodeIdempotencyKeys: { ghost: "key" },
      }),
    },
    {
      name: "unknown fork ID",
      fragment: 'fork ID "ghost" is not a unique body fork',
      state: () => ({
        ...incompleteCursor(),
        forkState: { ghost: { branches: { left: branch("left") } } },
      }),
    },
    {
      name: "unknown branch ID",
      fragment: 'branch ID "ghost" is not a branch of fork "parallel"',
      state: () => ({
        ...incompleteCursor(),
        completedNodeIds: ["fork"],
        forkState: { parallel: { branches: { ghost: branch("left") } } },
      }),
    },
    {
      name: "result key and node ID drift",
      fragment: 'result key/nodeId mismatch for "left"',
      state: () => ({
        ...incompleteCursor(),
        nodeResults: { left: result("right") },
      }),
    },
    {
      name: "duplicate completion",
      fragment: 'completedNodeIds contains duplicate "fork"',
      state: () => ({
        ...incompleteCursor(),
        completedNodeIds: ["fork", "fork"],
      }),
    },
    {
      name: "next node already completed",
      fragment: 'next node "left" is already completed',
      state: () => ({
        ...incompleteCursor(),
        nextNodeId: "left",
        completedNodeIds: ["left"],
        nodeResults: { left: result("left") },
      }),
    },
    {
      name: "completed node missing result",
      fragment: 'completed node "left" is missing its result',
      state: () => ({
        completed: true,
        completedNodeIds: ["left"],
        nodeResults: {},
        nodeIdempotencyKeys: {},
      }),
    },
    {
      name: "completed cursor with next node",
      fragment: "completed cursor must omit nextNodeId",
      state: () => ({
        ...incompleteCursor(),
        completed: true,
      }),
    },
    {
      name: "completed cursor without a normal exit",
      fragment: 'completed cursor did not reach a valid normal exit: "left"',
      state: () => ({
        completed: true,
        completedNodeIds: ["left"],
        nodeResults: { left: result("left") },
        nodeIdempotencyKeys: {},
      }),
    },
  ])("rejects a corrupt graph cursor with $name", async ({ fragment, state }) => {
    const errors: string[] = [];
    const calls: string[] = [];
    const checkpoint = corruptGraphCheckpoint(state());
    const resumed = await new PipelineRuntime({
      definition: corruptDefinition,
      predicates: { "continue-loop": () => true },
      onEvent: (event) => {
        if (event.type === "pipeline:failed") errors.push(event.error);
      },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return result(nodeId);
      },
    }).resume(checkpoint);

    expect(resumed.state).toBe("failed");
    expect(calls).toEqual([]);
    expect(errors).toContainEqual(expect.stringContaining(fragment));
  });
});

function branch(nodeId: string) {
  return {
    stateDelta: {},
    nodeResults: { [nodeId]: { nodeId, output: nodeId, durationMs: 1 } },
  };
}

function corruptGraphCheckpoint(bodyGraphState: unknown): PipelineCheckpoint {
  return {
    pipelineRunId: "corrupt-structured-loop-cursor",
    pipelineId: "structured-loop",
    version: 1,
    schemaVersion: "1.0.0",
    completedNodeIds: [],
    loopState: {
      loop: {
        iteration: 0,
        bodyGraphState,
      },
    },
    state: {},
  } as PipelineCheckpoint;
}
