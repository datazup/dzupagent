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
  suspendedExitNodeIds?: string[];
  terminalExitNodeIds?: string[];
  errorExitNodeIds?: string[];
  trailingNode?: PipelineNode;
}): PipelineDefinition {
  const loop: LoopNode = {
    id: "loop",
    type: "loop",
    bodyNodeIds: input.bodyNodes.map(({ id }) => id),
    bodyGraph: {
      entryNodeId: input.entryNodeId,
      normalExitNodeIds: input.normalExitNodeIds,
      suspendedExitNodeIds: input.suspendedExitNodeIds ?? [],
      terminalExitNodeIds: input.terminalExitNodeIds ?? [],
      errorExitNodeIds: input.errorExitNodeIds ?? [],
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

function terminalDefinition(): PipelineDefinition {
  const graphDefinition = definition({
    bodyNodes: [
      { id: "prepare", type: "agent", agentId: "prepare" },
      { id: "complete", type: "suspend", description: "done" },
    ],
    bodyEdges: [
      {
        type: "sequential",
        sourceNodeId: "prepare",
        targetNodeId: "complete",
      },
    ],
    entryNodeId: "prepare",
    normalExitNodeIds: [],
    terminalExitNodeIds: ["complete"],
    trailingNode: { id: "after", type: "agent", agentId: "after" },
  });
  graphDefinition.checkpointStrategy = "after_each_node";
  return graphDefinition;
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

  it("requires scoped completion to end at a declared normal exit", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const result = await new PipelineRuntime({
      definition: definition({
        bodyNodes: [
          { id: "declared", type: "agent", agentId: "declared" },
          { id: "actual", type: "agent", agentId: "actual" },
        ],
        bodyEdges: [
          {
            type: "sequential",
            sourceNodeId: "declared",
            targetNodeId: "actual",
          },
        ],
        entryNodeId: "declared",
        normalExitNodeIds: ["declared"],
      }),
      predicates: { "continue-loop": () => true },
      onEvent: (event) => {
        if (event.type === "pipeline:failed") errors.push(event.error);
      },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    }).execute();

    expect(result.state).toBe("failed");
    expect(calls).toEqual(["declared", "actual"]);
    expect(errors).toContainEqual(
      expect.stringContaining("outside a declared normal exit")
    );
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

  it("suspends the outer run at its loop and resumes the exact body cursor", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const graphDefinition = definition({
      bodyNodes: [
        { id: "prepare", type: "agent", agentId: "prepare" },
        { id: "approval", type: "gate", gateType: "approval" },
        { id: "work", type: "agent", agentId: "work" },
      ],
      bodyEdges: [
        {
          type: "sequential",
          sourceNodeId: "prepare",
          targetNodeId: "approval",
        },
        {
          type: "sequential",
          sourceNodeId: "approval",
          targetNodeId: "work",
        },
      ],
      entryNodeId: "prepare",
      normalExitNodeIds: ["work"],
      suspendedExitNodeIds: ["approval"],
      trailingNode: { id: "after", type: "agent", agentId: "after" },
    });
    graphDefinition.checkpointStrategy = "after_each_node";

    const firstCalls: string[] = [];
    const suspended = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: { "continue-loop": (state) => state["done"] !== true },
      nodeExecutor: async (nodeId) => {
        firstCalls.push(nodeId);
        return {
          nodeId,
          output: nodeId,
          durationMs: 1,
          providerSessionRefs: [{ provider: "private", sessionId: "hidden" }],
        };
      },
    }).execute(undefined, { runId: "nested-suspension" });

    expect(
      suspended.state,
      JSON.stringify([...suspended.nodeResults.entries()])
    ).toBe("suspended");
    expect(firstCalls).toEqual(["prepare"]);
    const checkpoint = await store.load(suspended.runId);
    expect(PipelineCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(checkpoint).toMatchObject({
      suspendedAtNodeId: "loop",
      completedNodeIds: [],
      loopState: {
        loop: {
          iteration: 0,
          bodyGraphState: {
            completed: false,
            outcome: { kind: "suspended", exitNodeId: "approval" },
            completedNodeIds: ["prepare"],
          },
        },
      },
    });
    expect(
      checkpoint?.loopState?.["loop"]?.bodyGraphState?.nodeResults["prepare"]
    ).not.toHaveProperty("providerSessionRefs");

    const resumedCalls: string[] = [];
    const resumed = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: { "continue-loop": (state) => state["done"] !== true },
      nodeExecutor: async (nodeId, _node, context) => {
        resumedCalls.push(nodeId);
        if (nodeId === "prepare") throw new Error("prepare was redispatched");
        if (nodeId === "work") context.state["done"] = true;
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    }).resume(checkpoint!);

    expect(resumed.state).toBe("completed");
    expect(resumedCalls).toEqual(["work", "after"]);
  });

  it.each(["before-save", "save-then-throw"] as const)(
    "keeps a nested suspension fail-closed after a %s checkpoint failure",
    async (failureMode) => {
      class SuspensionCheckpointFailureStore extends InMemoryPipelineCheckpointStore {
        private failed = false;

        override async save(checkpoint: PipelineCheckpoint): Promise<void> {
          const suspended =
            checkpoint.loopState?.["loop"]?.bodyGraphState?.outcome?.kind ===
            "suspended";
          if (!this.failed && suspended) {
            this.failed = true;
            if (failureMode === "save-then-throw") {
              await super.save(checkpoint);
            }
            throw new Error(`simulated suspension ${failureMode}`);
          }
          await super.save(checkpoint);
        }
      }

      const store = new SuspensionCheckpointFailureStore();
      const graphDefinition = definition({
        bodyNodes: [
          { id: "approval", type: "gate", gateType: "approval" },
          { id: "work", type: "agent", agentId: "work" },
        ],
        bodyEdges: [
          {
            type: "sequential",
            sourceNodeId: "approval",
            targetNodeId: "work",
          },
        ],
        entryNodeId: "approval",
        normalExitNodeIds: ["work"],
        suspendedExitNodeIds: ["approval"],
        trailingNode: { id: "after", type: "agent", agentId: "after" },
      });
      graphDefinition.checkpointStrategy = "after_each_node";

      const firstCalls: string[] = [];
      const failed = await new PipelineRuntime({
        definition: graphDefinition,
        checkpointStore: store,
        predicates: { "continue-loop": () => true },
        nodeExecutor: async (nodeId) => {
          firstCalls.push(nodeId);
          return { nodeId, output: nodeId, durationMs: 1 };
        },
      }).execute(undefined, { runId: `nested-suspension-${failureMode}` });

      expect(failed.state).toBe("failed");
      expect(firstCalls).toEqual([]);
      const checkpoint = await store.load(failed.runId);
      if (failureMode === "before-save") {
        expect(checkpoint).toBeUndefined();
        return;
      }

      expect(checkpoint).toMatchObject({
        suspendedAtNodeId: "loop",
        completedNodeIds: [],
      });
      const resumedCalls: string[] = [];
      const resumed = await new PipelineRuntime({
        definition: graphDefinition,
        checkpointStore: store,
        predicates: { "continue-loop": (state) => state["done"] !== true },
        nodeExecutor: async (nodeId, _node, context) => {
          resumedCalls.push(nodeId);
          if (nodeId === "work") context.state["done"] = true;
          return { nodeId, output: nodeId, durationMs: 1 };
        },
      }).resume(checkpoint!);
      expect(resumed.state).toBe("completed");
      expect(resumedCalls).toEqual(["work", "after"]);
    }
  );

  it("persists the post-suspension cursor before dispatch and survives acknowledgement loss", async () => {
    class ResumeCursorAckLossStore extends InMemoryPipelineCheckpointStore {
      private sawSuspension = false;
      private failed = false;

      override async save(checkpoint: PipelineCheckpoint): Promise<void> {
        await super.save(checkpoint);
        const graph = checkpoint.loopState?.["loop"]?.bodyGraphState;
        if (graph?.outcome?.kind === "suspended") this.sawSuspension = true;
        if (
          this.sawSuspension &&
          !this.failed &&
          checkpoint.suspendedAtNodeId === undefined &&
          graph?.nextNodeId === "work"
        ) {
          this.failed = true;
          throw new Error("simulated acknowledgement loss for resume cursor");
        }
      }
    }

    const store = new ResumeCursorAckLossStore();
    const graphDefinition = definition({
      bodyNodes: [
        { id: "approval", type: "gate", gateType: "approval" },
        { id: "work", type: "agent", agentId: "work" },
      ],
      bodyEdges: [
        {
          type: "sequential",
          sourceNodeId: "approval",
          targetNodeId: "work",
        },
      ],
      entryNodeId: "approval",
      normalExitNodeIds: ["work"],
      suspendedExitNodeIds: ["approval"],
    });
    graphDefinition.checkpointStrategy = "after_each_node";

    const first = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: { "continue-loop": (state) => state["done"] !== true },
      nodeExecutor: async (nodeId) => ({ nodeId, output: nodeId, durationMs: 1 }),
    }).execute(undefined, { runId: "nested-suspension-resume-cursor" });
    expect(first.state, JSON.stringify([...first.nodeResults.entries()])).toBe(
      "suspended"
    );

    const suspendedCheckpoint = await store.load(first.runId);
    const failedResumeCalls: string[] = [];
    const failedResume = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: { "continue-loop": () => true },
      nodeExecutor: async (nodeId) => {
        failedResumeCalls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    }).resume(suspendedCheckpoint!);
    expect(failedResume.state).toBe("failed");
    expect(failedResumeCalls).toEqual([]);

    const exactCursor = await store.load(first.runId);
    expect(exactCursor?.suspendedAtNodeId).toBeUndefined();
    expect(exactCursor?.loopState?.["loop"]?.bodyGraphState).toMatchObject({
      completed: false,
      nextNodeId: "work",
    });
    expect(
      exactCursor?.loopState?.["loop"]?.bodyGraphState?.outcome
    ).toBeUndefined();

    const finalCalls: string[] = [];
    const completed = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: { "continue-loop": (state) => state["done"] !== true },
      nodeExecutor: async (nodeId, _node, context) => {
        finalCalls.push(nodeId);
        context.state["done"] = true;
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    }).resume(exactCursor!);
    expect(
      completed.state,
      JSON.stringify([...completed.nodeResults.entries()])
    ).toBe("completed");
    expect(finalCalls).toEqual(["work"]);
  });

  it("completes at a terminal body outcome and suppresses every outer continuation", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const graphDefinition = terminalDefinition();
    const calls: string[] = [];
    const completed = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: { "continue-loop": () => true },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    }).execute(undefined, { runId: "nested-terminal" });

    expect(completed.state).toBe("completed");
    expect(calls).toEqual(["prepare"]);
    expect(completed.nodeResults.get("loop")?.output).toMatchObject({
      loopOutput: "done",
      metrics: { terminationReason: "terminal" },
    });
    const checkpoint = await store.load(completed.runId);
    expect(PipelineCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(checkpoint).toMatchObject({
      suspendedAtNodeId: "complete",
      completedNodeIds: ["loop"],
      loopState: {
        loop: {
          bodyGraphState: {
            completed: true,
            outcome: { kind: "terminal", exitNodeId: "complete" },
          },
        },
      },
    });

    const resumedCalls: string[] = [];
    const resumed = await new PipelineRuntime({
      definition: graphDefinition,
      checkpointStore: store,
      predicates: { "continue-loop": () => true },
      nodeExecutor: async (nodeId) => {
        resumedCalls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    }).resume(checkpoint!);
    expect(resumed.state).toBe("completed");
    expect(resumedCalls).toEqual([]);
  });

  it("propagates a terminal outcome selected by a conditional body path", async () => {
    const graphDefinition = definition({
      bodyNodes: [
        { id: "choose", type: "gate", gateType: "quality" },
        { id: "complete", type: "suspend", description: "branch done" },
        { id: "normal", type: "agent", agentId: "normal" },
      ],
      bodyEdges: [
        {
          type: "conditional",
          sourceNodeId: "choose",
          predicateName: "choose-terminal",
          branches: { true: "complete", false: "normal" },
        },
      ],
      entryNodeId: "choose",
      normalExitNodeIds: ["normal"],
      terminalExitNodeIds: ["complete"],
      trailingNode: { id: "after", type: "agent", agentId: "after" },
    });
    const calls: string[] = [];
    const result = await new PipelineRuntime({
      definition: graphDefinition,
      predicates: {
        "choose-terminal": () => true,
        "continue-loop": () => true,
      },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    }).execute();

    expect(result.state).toBe("completed");
    expect(calls).toEqual(["choose"]);
    expect(result.nodeResults.get("loop")?.output).toMatchObject({
      loopOutput: "branch done",
      metrics: { terminationReason: "terminal" },
    });
  });

  it("rejects nested control outcomes whose outer marker was corrupted", async () => {
    const suspendedDefinition = definition({
      bodyNodes: [
        { id: "approval", type: "gate", gateType: "approval" },
        { id: "work", type: "agent", agentId: "work" },
      ],
      bodyEdges: [
        {
          type: "sequential",
          sourceNodeId: "approval",
          targetNodeId: "work",
        },
      ],
      entryNodeId: "approval",
      normalExitNodeIds: ["work"],
      suspendedExitNodeIds: ["approval"],
    });
    const cases: Array<{
      name: string;
      definition: PipelineDefinition;
      checkpoint: PipelineCheckpoint;
    }> = [
      {
        name: "suspended",
        definition: suspendedDefinition,
        checkpoint: {
          pipelineRunId: "corrupt-suspended-marker",
          pipelineId: suspendedDefinition.id,
          version: 1,
          schemaVersion: "1.0.0",
          completedNodeIds: [],
          suspendedAtNodeId: "approval",
          loopState: {
            loop: {
              iteration: 0,
              bodyGraphState: {
                completed: false,
                outcome: { kind: "suspended", exitNodeId: "approval" },
                completedNodeIds: [],
                nodeResults: {},
                nodeIdempotencyKeys: {},
              },
            },
          },
          state: {},
          createdAt: "2026-08-14T00:00:00.000Z",
        },
      },
      {
        name: "terminal",
        definition: terminalDefinition(),
        checkpoint: {
          pipelineRunId: "corrupt-terminal-marker",
          pipelineId: "structured-loop",
          version: 1,
          schemaVersion: "1.0.0",
          completedNodeIds: ["loop"],
          suspendedAtNodeId: "loop",
          loopState: {
            loop: {
              iteration: 0,
              bodyGraphState: {
                completed: true,
                outcome: { kind: "terminal", exitNodeId: "complete" },
                completedNodeIds: ["prepare"],
                nodeResults: {
                  prepare: {
                    nodeId: "prepare",
                    output: "prepare",
                    durationMs: 1,
                  },
                },
                nodeIdempotencyKeys: {},
              },
            },
          },
          state: {},
          createdAt: "2026-08-14T00:00:00.000Z",
        },
      },
    ];

    for (const testCase of cases) {
      const calls: string[] = [];
      const errors: string[] = [];
      const result = await new PipelineRuntime({
        definition: testCase.definition,
        predicates: { "continue-loop": () => true },
        onEvent: (event) => {
          if (event.type === "pipeline:failed") errors.push(event.error);
        },
        nodeExecutor: async (nodeId) => {
          calls.push(nodeId);
          return { nodeId, output: nodeId, durationMs: 1 };
        },
      }).resume(testCase.checkpoint);

      expect(result.state, testCase.name).toBe("failed");
      expect(calls, testCase.name).toEqual([]);
      expect(errors, testCase.name).toContainEqual(
        expect.stringContaining("invalid outer checkpoint marker")
      );
    }
  });

  it.each(["before-save", "save-then-throw"] as const)(
    "recovers a terminal outcome after a %s checkpoint failure",
    async (failureMode) => {
      class TerminalCheckpointFailureStore extends InMemoryPipelineCheckpointStore {
        private failed = false;

        override async save(checkpoint: PipelineCheckpoint): Promise<void> {
          const terminal =
            checkpoint.loopState?.["loop"]?.bodyGraphState?.outcome?.kind ===
            "terminal";
          if (!this.failed && terminal) {
            this.failed = true;
            if (failureMode === "save-then-throw") {
              await super.save(checkpoint);
            }
            throw new Error(`simulated terminal ${failureMode}`);
          }
          await super.save(checkpoint);
        }
      }

      const store = new TerminalCheckpointFailureStore();
      const graphDefinition = terminalDefinition();
      const firstCalls: string[] = [];
      const failed = await new PipelineRuntime({
        definition: graphDefinition,
        checkpointStore: store,
        predicates: { "continue-loop": () => true },
        nodeExecutor: async (nodeId) => {
          firstCalls.push(nodeId);
          return { nodeId, output: nodeId, durationMs: 1 };
        },
      }).execute(undefined, { runId: `nested-terminal-${failureMode}` });

      expect(failed.state).toBe("failed");
      expect(firstCalls).toEqual(["prepare"]);
      const checkpoint = await store.load(failed.runId);
      expect(checkpoint).toBeDefined();
      if (failureMode === "save-then-throw") {
        expect(checkpoint).toMatchObject({
          suspendedAtNodeId: "complete",
          completedNodeIds: ["loop"],
        });
      } else {
        expect(checkpoint?.suspendedAtNodeId).toBeUndefined();
        expect(checkpoint?.loopState?.["loop"]?.bodyGraphState).toMatchObject({
          completed: false,
          nextNodeId: "complete",
        });
      }

      const resumedCalls: string[] = [];
      const resumed = await new PipelineRuntime({
        definition: graphDefinition,
        checkpointStore: store,
        predicates: { "continue-loop": () => true },
        nodeExecutor: async (nodeId) => {
          resumedCalls.push(nodeId);
          return { nodeId, output: nodeId, durationMs: 1 };
        },
      }).resume(checkpoint!);
      expect(resumed.state).toBe("completed");
      expect(resumedCalls).toEqual([]);
    }
  );

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
      name: "unknown outcome kind",
      fragment: 'outcome kind "paused" is invalid',
      schemaFragment: "Invalid discriminator value",
      state: () => ({
        ...incompleteCursor(),
        nextNodeId: undefined,
        outcome: { kind: "paused", exitNodeId: "fork" },
      }),
    },
    {
      name: "outcome classified in the wrong inventory",
      fragment:
        'terminal outcome exit "join" must have exactly one matching declared classification',
      state: () => ({
        completed: true,
        outcome: { kind: "terminal", exitNodeId: "join" },
        completedNodeIds: ["fork", "join"],
        nodeResults: {},
        nodeIdempotencyKeys: {},
      }),
    },
    {
      name: "suspended outcome with a dispatch cursor",
      fragment:
        "suspended outcome requires completed=false and must omit nextNodeId",
      schemaFragment: "classified outcomes omit nextNodeId",
      state: () => ({
        ...incompleteCursor(),
        outcome: { kind: "suspended", exitNodeId: "fork" },
      }),
    },
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
      schemaFragment: 'completedNodeIds contains duplicate node ID "fork"',
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
      schemaFragment: "completed graph cursors omit nextNodeId",
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
  ])("rejects a corrupt graph cursor with $name", async (testCase) => {
    const { fragment, state } = testCase;
    const schemaFragment = "schemaFragment" in testCase
      ? testCase.schemaFragment
      : undefined;
    const errors: string[] = [];
    const calls: string[] = [];
    const checkpoint = corruptGraphCheckpoint(state());
    const runtime = new PipelineRuntime({
      definition: corruptDefinition,
      predicates: { "continue-loop": () => true },
      onEvent: (event) => {
        if (event.type === "pipeline:failed") errors.push(event.error);
      },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return result(nodeId);
      },
    });

    if (schemaFragment !== undefined) {
      await expect(runtime.resume(checkpoint)).rejects.toMatchObject({
        code: "INTERACTION_BINDING_MISMATCH",
        message: expect.stringContaining(schemaFragment),
      });
      expect(calls).toEqual([]);
      expect(errors).toEqual([]);
      return;
    }

    const resumed = await runtime.resume(checkpoint);

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
    createdAt: "2026-08-14T00:00:00.000Z",
  } as PipelineCheckpoint;
}
