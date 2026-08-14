import { describe, expect, it } from "vitest";
import type {
  LoopNode,
  PipelineCheckpoint,
  PipelineDefinition,
  PipelineNode,
} from "@dzupagent/core/pipeline";
import {
  createPipelineInteractionResumeV1,
  createPipelineInteractionSpecV1,
} from "@dzupagent/runtime-contracts";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";

function loopDefinition(): PipelineDefinition {
  const interaction = createPipelineInteractionSpecV1({
    kind: "approval",
    authoredNodeId: "review",
    authoredPath: "root.body[1]",
    question: "Continue iteration?",
    choices: [],
    outcomeToSuccessor: { approved: "approved", rejected: "rejected" },
    requestSchema: { kind: "approval", decisions: ["approved", "rejected"] },
  });
  const loop: LoopNode = {
    id: "loop",
    type: "loop",
    bodyNodeIds: ["prefix", "review", "approved", "rejected"],
    bodyGraph: {
      entryNodeId: "prefix",
      normalExitNodeIds: ["approved", "rejected"],
      suspendedExitNodeIds: [],
      suspensionSiteNodeIds: ["review"],
      terminalExitNodeIds: [],
      errorExitNodeIds: [],
    },
    maxIterations: 3,
    continuePredicateName: "continue-loop",
    typedWhile: {
      conditionSchema: "dzupagent.flowTypedCondition/v1",
      condition: { op: "literal", value: true },
      onExhausted: "fail",
    },
  };
  return {
    id: "loop-interaction",
    name: "loop interaction",
    version: "1",
    schemaVersion: "1.1.0",
    entryNodeId: "loop",
    checkpointStrategy: "after_each_node",
    nodes: [
      loop,
      { id: "prefix", type: "agent", agentId: "prefix" },
      { id: "review", type: "gate", gateType: "approval", interaction },
      { id: "approved", type: "agent", agentId: "approved" },
      { id: "rejected", type: "agent", agentId: "rejected" },
      { id: "after", type: "agent", agentId: "after" },
    ],
    edges: [
      { type: "sequential", sourceNodeId: "prefix", targetNodeId: "review" },
      {
        type: "conditional",
        sourceNodeId: "review",
        predicateName: "must-not-run",
        branches: { approved: "approved", rejected: "rejected" },
      },
      { type: "sequential", sourceNodeId: "loop", targetNodeId: "after" },
    ],
  };
}

function terminalLoopDefinition(): PipelineDefinition {
  const interaction = createPipelineInteractionSpecV1({
    kind: "approval",
    authoredNodeId: "review",
    authoredPath: "root.body[1]",
    question: "Finish the run?",
    choices: [],
    outcomeToSuccessor: { approved: "complete", rejected: "rejected" },
    requestSchema: { kind: "approval", decisions: ["approved", "rejected"] },
  });
  const loop: LoopNode = {
    id: "loop",
    type: "loop",
    bodyNodeIds: ["prefix", "review", "complete", "rejected"],
    bodyGraph: {
      entryNodeId: "prefix",
      normalExitNodeIds: ["rejected"],
      suspendedExitNodeIds: [],
      suspensionSiteNodeIds: ["review"],
      terminalExitNodeIds: ["complete"],
      errorExitNodeIds: [],
    },
    maxIterations: 1,
    continuePredicateName: "continue-loop",
  };
  return {
    id: "terminal-loop-interaction",
    name: "terminal loop interaction",
    version: "1",
    schemaVersion: "1.1.0",
    entryNodeId: "loop",
    checkpointStrategy: "after_each_node",
    nodes: [
      loop,
      { id: "prefix", type: "agent", agentId: "prefix" },
      { id: "review", type: "gate", gateType: "approval", interaction },
      { id: "complete", type: "suspend", description: "done" },
      { id: "rejected", type: "agent", agentId: "rejected" },
      { id: "after", type: "agent", agentId: "after" },
    ],
    edges: [
      { type: "sequential", sourceNodeId: "prefix", targetNodeId: "review" },
      {
        type: "conditional",
        sourceNodeId: "review",
        predicateName: "must-not-run",
        branches: { approved: "complete", rejected: "rejected" },
      },
      { type: "sequential", sourceNodeId: "loop", targetNodeId: "after" },
    ],
  };
}

function compositeLoopDefinition(
  shape: "branch" | "catch",
): PipelineDefinition {
  const branchInteraction = createPipelineInteractionSpecV1({
    kind: "approval",
    authoredNodeId: "review",
    authoredPath: "root.body[0].then[0]",
    question: "Approve branch?",
    choices: [],
    outcomeToSuccessor: { approved: "approved", rejected: "rejected" },
    requestSchema: { kind: "approval", decisions: ["approved", "rejected"] },
  });
  const catchInteraction = createPipelineInteractionSpecV1({
    kind: "clarification",
    authoredNodeId: "clarify",
    authoredPath: "root.body[0].catch[0]",
    question: "How should the failure be handled?",
    choices: [],
    outputKey: "recoveryAnswer",
    requestSchema: {
      kind: "clarification",
      response: "text",
      minLength: 1,
      maxLength: 256,
    },
  });
  const loop: LoopNode = shape === "branch"
    ? {
        id: "loop",
        type: "loop",
        bodyNodeIds: ["decision", "review", "approved", "rejected", "skip"],
        bodyGraph: {
          entryNodeId: "decision",
          normalExitNodeIds: ["approved", "rejected", "skip"],
          suspendedExitNodeIds: [],
          suspensionSiteNodeIds: ["review"],
          terminalExitNodeIds: [],
          errorExitNodeIds: [],
        },
        maxIterations: 1,
        continuePredicateName: "stop-loop",
      }
    : {
        id: "loop",
        type: "loop",
        bodyNodeIds: ["fail", "clarify", "handled"],
        bodyGraph: {
          entryNodeId: "fail",
          normalExitNodeIds: ["handled"],
          suspendedExitNodeIds: [],
          suspensionSiteNodeIds: ["clarify"],
          terminalExitNodeIds: [],
          errorExitNodeIds: [],
        },
        maxIterations: 1,
        continuePredicateName: "stop-loop",
      };
  const nodes: PipelineNode[] = shape === "branch"
    ? [
        loop,
        { id: "decision", type: "gate", gateType: "quality" },
        {
          id: "review",
          type: "gate",
          gateType: "approval",
          interaction: branchInteraction,
        },
        { id: "approved", type: "agent", agentId: "approved" },
        { id: "rejected", type: "agent", agentId: "rejected" },
        { id: "skip", type: "agent", agentId: "skip" },
        { id: "after", type: "agent", agentId: "after" },
      ]
    : [
        loop,
        { id: "fail", type: "agent", agentId: "fail" },
        { id: "clarify", type: "suspend", interaction: catchInteraction },
        { id: "handled", type: "agent", agentId: "handled" },
        { id: "after", type: "agent", agentId: "after" },
      ];
  return {
    id: `loop-${shape}-interaction`,
    name: `loop ${shape} interaction`,
    version: "1",
    schemaVersion: "1.1.0",
    entryNodeId: "loop",
    checkpointStrategy: "after_each_node",
    nodes,
    edges: shape === "branch"
      ? [
          {
            type: "conditional",
            sourceNodeId: "decision",
            predicateName: "choose-review",
            branches: { true: "review", false: "skip" },
          },
          {
            type: "conditional",
            sourceNodeId: "review",
            predicateName: "must-not-run",
            branches: { approved: "approved", rejected: "rejected" },
          },
          { type: "sequential", sourceNodeId: "loop", targetNodeId: "after" },
        ]
      : [
          { type: "error", sourceNodeId: "fail", targetNodeId: "clarify" },
          { type: "sequential", sourceNodeId: "clarify", targetNodeId: "handled" },
          { type: "sequential", sourceNodeId: "loop", targetNodeId: "after" },
        ],
  };
}

function tryBodyLoopDefinition(): PipelineDefinition {
  const interaction = createPipelineInteractionSpecV1({
    kind: "clarification",
    authoredNodeId: "clarify",
    authoredPath: "root.body[0].body[0]",
    question: "How should the try body continue?",
    choices: [],
    outputKey: "tryAnswer",
    requestSchema: {
      kind: "clarification",
      response: "text",
      minLength: 1,
      maxLength: 256,
    },
  });
  const loop: LoopNode = {
    id: "loop",
    type: "loop",
    bodyNodeIds: ["clarify", "handled", "recovered"],
    bodyGraph: {
      entryNodeId: "clarify",
      normalExitNodeIds: ["handled", "recovered"],
      suspendedExitNodeIds: [],
      suspensionSiteNodeIds: ["clarify"],
      terminalExitNodeIds: [],
      errorExitNodeIds: ["recovered"],
    },
    maxIterations: 1,
    continuePredicateName: "stop-loop",
  };
  return {
    id: "loop-try-interaction",
    name: "loop try interaction",
    version: "1",
    schemaVersion: "1.1.0",
    entryNodeId: "loop",
    checkpointStrategy: "after_each_node",
    nodes: [
      loop,
      { id: "clarify", type: "suspend", interaction },
      { id: "handled", type: "agent", agentId: "handled" },
      { id: "recovered", type: "agent", agentId: "recovered" },
      { id: "after", type: "agent", agentId: "after" },
    ],
    edges: [
      { type: "sequential", sourceNodeId: "clarify", targetNodeId: "handled" },
      { type: "error", sourceNodeId: "clarify", targetNodeId: "recovered" },
      { type: "error", sourceNodeId: "handled", targetNodeId: "recovered" },
      { type: "sequential", sourceNodeId: "loop", targetNodeId: "after" },
    ],
  };
}

describe("structured loop interaction resume", () => {
  it("binds each iteration uniquely and resumes from the exact successor without repeating its prefix", async () => {
    const calls: string[] = [];
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: loopDefinition(),
      checkpointStore: store,
      interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
      predicates: {
        "must-not-run": () => {
          throw new Error("approval predicate must not run");
        },
        "continue-loop": (state) =>
          ((state["accepted"] as number | undefined) ?? 0) < 2,
      },
      nodeExecutor: async (nodeId, _node: PipelineNode, context) => {
        calls.push(nodeId);
        if (nodeId === "approved") {
          context.state["accepted"] =
            ((context.state["accepted"] as number | undefined) ?? 0) + 1;
        }
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    });

    const first = await runtime.execute({}, { runId: "loop-run" });
    expect(first.state).toBe("suspended");
    expect(calls).toEqual(["prefix"]);
    const checkpoint1 = (await store.load("loop-run"))!;
    const pending1 = checkpoint1.pendingInteraction!;
    expect(pending1.scope).toEqual({
      kind: "loop",
      loopNodeId: "loop",
      iteration: 0,
    });

    await runtime.resume(checkpoint1, { accepted: 999 });
    expect(calls).toEqual(["prefix"]);

    const receipt1 = createPipelineInteractionResumeV1({
      ...pending1,
      receiptId: "iteration-0",
      submittedAt: "2026-08-14T20:00:01.000Z",
      response: { kind: "approval", decision: "approved" },
    });
    const second = await runtime.resumeInteraction(checkpoint1, receipt1);
    expect(calls).toEqual(["prefix", "approved", "prefix"]);
    expect(second.state).toBe("suspended");
    const checkpoint2 = (await store.load("loop-run"))!;
    const pending2 = checkpoint2.pendingInteraction!;
    expect(pending2.scope).toEqual({
      kind: "loop",
      loopNodeId: "loop",
      iteration: 1,
    });
    expect(pending2.interactionId).not.toBe(pending1.interactionId);
    expect(checkpoint2.interactionReceipts?.[pending1.interactionId]).toEqual(receipt1);

    await expect(runtime.resumeInteraction(checkpoint1, receipt1)).resolves.toMatchObject({
      state: "suspended",
      pendingInteraction: pending2,
    });
    expect(calls).toEqual(["prefix", "approved", "prefix"]);

    const receipt2 = createPipelineInteractionResumeV1({
      ...pending2,
      receiptId: "iteration-1",
      submittedAt: "2026-08-14T20:00:02.000Z",
      response: { kind: "approval", decision: "approved" },
    });
    const completed = await runtime.resumeInteraction(checkpoint2, receipt2);
    expect(completed.state).toBe("completed");
    expect(calls).toEqual([
      "prefix",
      "approved",
      "prefix",
      "approved",
      "after",
    ]);
    const final = (await store.load("loop-run"))!;
    expect(final.pendingInteraction).toBeUndefined();
    expect(final.completedNodeIds).toEqual(["loop", "after"]);
  });

  it.each(["branch", "catch"] as const)(
    "resumes an interaction nested in a %s body through its exact successor",
    async (shape) => {
      const calls: string[] = [];
      const store = new InMemoryPipelineCheckpointStore();
      const runtime = new PipelineRuntime({
        definition: compositeLoopDefinition(shape),
        checkpointStore: store,
        interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
        predicates: {
          "choose-review": () => true,
          "must-not-run": () => {
            throw new Error("approval predicate must not run");
          },
          "stop-loop": () => false,
        },
        nodeExecutor: async (nodeId) => {
          calls.push(nodeId);
          return {
            nodeId,
            output: nodeId,
            durationMs: 1,
            ...(nodeId === "fail" ? { error: "expected failure" } : {}),
          };
        },
      });
      const runId = `loop-${shape}-run`;
      await expect(runtime.execute({}, { runId })).resolves.toMatchObject({
        state: "suspended",
      });
      const checkpoint = (await store.load(runId))!;
      const pending = checkpoint.pendingInteraction!;
      expect(pending.scope).toMatchObject({
        kind: "loop",
        loopNodeId: "loop",
        iteration: 0,
      });
      const receipt = createPipelineInteractionResumeV1({
        ...pending,
        receiptId: `${shape}-receipt`,
        submittedAt: "2026-08-14T20:00:01.000Z",
        response: shape === "branch"
          ? { kind: "approval", decision: "approved" }
          : { kind: "clarification", value: "retry safely" },
      });

      await expect(
        runtime.resumeInteraction(checkpoint, receipt),
      ).resolves.toMatchObject({ state: "completed" });
      expect(calls).toEqual(
        shape === "branch"
          ? ["decision", "approved", "after"]
          : ["fail", "handled", "after"],
      );
      if (shape === "catch") {
        expect((await store.load(runId))?.state).toMatchObject({
          recoveryAnswer: "retry safely",
        });
      }
    },
  );

  it("resumes an interaction in a try body without entering its catch path", async () => {
    const calls: string[] = [];
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: tryBodyLoopDefinition(),
      checkpointStore: store,
      interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
      predicates: { "stop-loop": () => false },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    });
    await runtime.execute({}, { runId: "loop-try-run" });
    const checkpoint = (await store.load("loop-try-run"))!;
    const receipt = createPipelineInteractionResumeV1({
      ...checkpoint.pendingInteraction!,
      receiptId: "try-receipt",
      submittedAt: "2026-08-14T20:00:01.000Z",
      response: { kind: "clarification", value: "continue normally" },
    });

    await expect(
      runtime.resumeInteraction(checkpoint, receipt),
    ).resolves.toMatchObject({ state: "completed" });
    expect(calls).toEqual(["handled", "after"]);
    expect((await store.load("loop-try-run"))?.state).toMatchObject({
      tryAnswer: "continue normally",
    });
  });

  it("rejects a corrupt retained loop binding before successor dispatch", async () => {
    const calls: string[] = [];
    const store = new CorruptLoopInteractionStore();
    const runtime = new PipelineRuntime({
      definition: loopDefinition(),
      checkpointStore: store,
      interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
      predicates: { "continue-loop": () => false },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    });
    await runtime.execute({}, { runId: "corrupt-loop-run" });
    const checkpoint = (await store.load("corrupt-loop-run"))!;
    const pending = checkpoint.pendingInteraction!;
    const receipt = createPipelineInteractionResumeV1({
      ...pending,
      receiptId: "corrupt-loop-receipt",
      submittedAt: "2026-08-14T20:00:01.000Z",
      response: { kind: "approval", decision: "approved" },
    });
    store.corruptReads = true;

    await expect(
      runtime.resumeInteraction(checkpoint, receipt),
    ).rejects.toMatchObject({ code: "INVALID_PENDING_INTERACTION" });
    expect(calls).toEqual(["prefix"]);
  });

  it("rejects nested successor-cursor drift from the committed decision", async () => {
    const calls: string[] = [];
    const store = new LoopInteractionCommitFailureStore("save-then-throw");
    const runtime = new PipelineRuntime({
      definition: loopDefinition(),
      checkpointStore: store,
      interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
      predicates: { "continue-loop": () => false },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    });
    await runtime.execute({}, { runId: "nested-cursor-drift" });
    const suspended = (await store.load("nested-cursor-drift"))!;
    const receipt = createPipelineInteractionResumeV1({
      ...suspended.pendingInteraction!,
      receiptId: "nested-cursor-receipt",
      submittedAt: "2026-08-14T20:00:01.000Z",
      response: { kind: "approval", decision: "approved" },
    });
    await expect(
      runtime.resumeInteraction(suspended, receipt),
    ).rejects.toThrow("injected loop interaction commit failure");
    const corrupt = structuredClone(
      (await store.load("nested-cursor-drift"))!,
    );
    const graph = corrupt.loopState?.["loop"]?.bodyGraphState;
    if (graph === undefined) throw new Error("expected retained loop graph");
    graph.nextNodeId = "rejected";

    await expect(runtime.resume(corrupt)).rejects.toMatchObject({
      code: "INTERACTION_BINDING_MISMATCH",
    });
    expect(calls).toEqual(["prefix"]);
  });

  it.each(["before-save", "save-then-throw"] as const)(
    "recovers the exact loop successor once when the consumed checkpoint fails %s",
    async (failureMode) => {
      const calls: string[] = [];
      const store = new LoopInteractionCommitFailureStore(failureMode);
      const runtime = new PipelineRuntime({
        definition: loopDefinition(),
        checkpointStore: store,
        interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
        predicates: {
          "continue-loop": (state) =>
            ((state["accepted"] as number | undefined) ?? 0) < 1,
        },
        nodeExecutor: async (nodeId, _node: PipelineNode, context) => {
          calls.push(nodeId);
          if (nodeId === "approved") {
            context.state["accepted"] = 1;
          }
          return { nodeId, output: nodeId, durationMs: 1 };
        },
      });
      const runId = `loop-failure-${failureMode}`;
      await runtime.execute({}, { runId });
      const suspended = (await store.load(runId))!;
      const pending = suspended.pendingInteraction!;
      const receipt = createPipelineInteractionResumeV1({
        ...pending,
        receiptId: "loop-receipt",
        submittedAt: "2026-08-14T20:00:01.000Z",
        response: { kind: "approval", decision: "approved" },
      });

      await expect(
        runtime.resumeInteraction(suspended, receipt),
      ).rejects.toThrow("injected loop interaction commit failure");
      expect(calls).toEqual(["prefix"]);

      await expect(
        runtime.resumeInteraction(suspended, receipt),
      ).resolves.toMatchObject({ state: "completed" });
      expect(calls).toEqual(["prefix", "approved", "after"]);
      expect((await store.load(runId))?.interactionResumeCursor).toBeUndefined();

      await runtime.resumeInteraction(suspended, receipt);
      expect(calls).toEqual(["prefix", "approved", "after"]);
    },
  );

  it("keeps a committed terminal outcome authoritative when its save then throws", async () => {
    const calls: string[] = [];
    const store = new TerminalLoopSaveThenThrowStore();
    const definition = terminalLoopDefinition();
    const runtime = new PipelineRuntime({
      definition,
      checkpointStore: store,
      interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
      predicates: {
        "continue-loop": () => true,
        "must-not-run": () => {
          throw new Error("approval predicate must not run");
        },
      },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    });
    await runtime.execute({}, { runId: "terminal-save-then-throw" });
    const suspended = (await store.load("terminal-save-then-throw"))!;
    const receipt = createPipelineInteractionResumeV1({
      ...suspended.pendingInteraction!,
      receiptId: "terminal-receipt",
      submittedAt: "2026-08-14T20:00:01.000Z",
      response: { kind: "approval", decision: "approved" },
    });

    await expect(
      runtime.resumeInteraction(suspended, receipt),
    ).resolves.toMatchObject({ state: "failed" });
    expect(calls).toEqual(["prefix"]);
    const committedTerminal = (await store.load("terminal-save-then-throw"))!;
    expect(committedTerminal.interactionResumeCursor).toBeUndefined();
    expect(committedTerminal.completedNodeIds).toContain("loop");
    expect(
      committedTerminal.loopState?.["loop"]?.bodyGraphState?.outcome,
    ).toEqual({ kind: "terminal", exitNodeId: "complete" });

    const restarted = new PipelineRuntime({
      definition,
      checkpointStore: store,
      predicates: { "continue-loop": () => true },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    });
    await expect(restarted.resume(committedTerminal)).resolves.toMatchObject({
      state: "completed",
    });
    await expect(
      restarted.resumeInteraction(suspended, receipt),
    ).resolves.toMatchObject({ state: "completed" });
    expect(calls).toEqual(["prefix"]);
  });
});

class LoopInteractionCommitFailureStore extends InMemoryPipelineCheckpointStore {
  private failed = false;

  constructor(private readonly failureMode: "before-save" | "save-then-throw") {
    super();
  }

  override async save(checkpoint: PipelineCheckpoint): Promise<void> {
    if (!this.failed && checkpoint.interactionResumeCursor !== undefined) {
      this.failed = true;
      if (this.failureMode === "save-then-throw") {
        await super.save(checkpoint);
      }
      throw new Error("injected loop interaction commit failure");
    }
    await super.save(checkpoint);
  }
}

class CorruptLoopInteractionStore extends InMemoryPipelineCheckpointStore {
  corruptReads = false;

  override async load(runId: string): Promise<PipelineCheckpoint | undefined> {
    const checkpoint = await super.load(runId);
    if (
      !this.corruptReads ||
      checkpoint?.pendingInteraction?.scope.kind !== "loop"
    ) {
      return checkpoint;
    }
    return {
      ...checkpoint,
      pendingInteraction: {
        ...checkpoint.pendingInteraction,
        scope: {
          ...checkpoint.pendingInteraction.scope,
          iteration: checkpoint.pendingInteraction.scope.iteration + 1,
        },
      },
    };
  }
}

class TerminalLoopSaveThenThrowStore extends InMemoryPipelineCheckpointStore {
  private failed = false;

  override async save(checkpoint: PipelineCheckpoint): Promise<void> {
    const outcome = checkpoint.loopState?.["loop"]?.bodyGraphState?.outcome;
    if (!this.failed && outcome?.kind === "terminal") {
      this.failed = true;
      await super.save(checkpoint);
      throw new Error("injected committed terminal transport failure");
    }
    await super.save(checkpoint);
  }
}
