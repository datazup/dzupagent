import { describe, expect, it } from "vitest";
import type {
  PipelineCheckpoint,
  PipelineDefinition,
  PipelineNode,
} from "@dzupagent/core/pipeline";
import {
  createPipelineInteractionResumeV1,
  createPipelineInteractionSpecV1,
  createPipelinePendingInteractionV1,
  type PipelinePendingInteractionV1,
} from "@dzupagent/runtime-contracts";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";

function approvalDefinition(): PipelineDefinition {
  const interaction = createPipelineInteractionSpecV1({
    kind: "approval",
    authoredNodeId: "approval",
    authoredPath: "root.nodes[0]",
    question: "Proceed?",
    choices: ["standard"],
    outcomeToSuccessor: { approved: "approved", rejected: "rejected" },
    requestSchema: { kind: "approval", decisions: ["approved", "rejected"] },
  });
  return {
    id: "approval-pipeline",
    name: "approval",
    version: "1",
    schemaVersion: "1.1.0",
    entryNodeId: "gate",
    checkpointStrategy: "on_suspend",
    nodes: [
      { id: "gate", type: "gate", gateType: "approval", interaction },
      { id: "approved", type: "agent", agentId: "approved" },
      { id: "rejected", type: "agent", agentId: "rejected" },
    ],
    edges: [
      {
        type: "conditional",
        sourceNodeId: "gate",
        predicateName: "must-not-run",
        branches: { approved: "approved", rejected: "rejected" },
      },
    ],
  };
}

function sequentialApprovalDefinition(): PipelineDefinition {
  const first = createPipelineInteractionSpecV1({
    kind: "approval",
    authoredNodeId: "first-approval",
    authoredPath: "root.nodes[0]",
    question: "Proceed to the second review?",
    choices: [],
    outcomeToSuccessor: {
      approved: "second-gate",
      rejected: "first-rejected",
    },
    requestSchema: { kind: "approval", decisions: ["approved", "rejected"] },
  });
  const second = createPipelineInteractionSpecV1({
    kind: "approval",
    authoredNodeId: "second-approval",
    authoredPath: "root.nodes[1]",
    question: "Complete?",
    choices: [],
    outcomeToSuccessor: {
      approved: "second-approved",
      rejected: "second-rejected",
    },
    requestSchema: { kind: "approval", decisions: ["approved", "rejected"] },
  });
  return {
    id: "sequential-approval-pipeline",
    name: "sequential approval",
    version: "1",
    schemaVersion: "1.1.0",
    entryNodeId: "first-gate",
    checkpointStrategy: "on_suspend",
    nodes: [
      { id: "first-gate", type: "gate", gateType: "approval", interaction: first },
      { id: "second-gate", type: "gate", gateType: "approval", interaction: second },
      { id: "first-rejected", type: "agent", agentId: "first-rejected" },
      { id: "second-approved", type: "agent", agentId: "second-approved" },
      { id: "second-rejected", type: "agent", agentId: "second-rejected" },
    ],
    edges: [
      {
        type: "conditional",
        sourceNodeId: "first-gate",
        predicateName: "first-must-not-run",
        branches: {
          approved: "second-gate",
          rejected: "first-rejected",
        },
      },
      {
        type: "conditional",
        sourceNodeId: "second-gate",
        predicateName: "second-must-not-run",
        branches: {
          approved: "second-approved",
          rejected: "second-rejected",
        },
      },
    ],
  };
}

function receiptFor(
  pending: PipelinePendingInteractionV1,
  decision: "approved" | "rejected",
  receiptId = `receipt-${decision}`,
) {
  return createPipelineInteractionResumeV1({
    ...pending,
    receiptId,
    submittedAt: "2026-08-14T20:00:01.000Z",
    response: { kind: "approval", decision },
  });
}

function pendingWithOccurrence(
  pending: PipelinePendingInteractionV1,
  occurrence: number,
  expectedCheckpointVersion = pending.expectedCheckpointVersion,
): PipelinePendingInteractionV1 {
  return createPipelinePendingInteractionV1({
    kind: pending.kind,
    definitionDigest: pending.definitionDigest,
    pipelineId: pending.pipelineId,
    runId: pending.runId,
    nodeId: pending.nodeId,
    scope: pending.scope,
    occurrence,
    expectedCheckpointVersion,
    requestDigest: pending.requestDigest,
    expiresAt: pending.expiresAt,
  });
}

describe("PipelineRuntime checkpoint-bound interactions", () => {
  it.each(["approved", "rejected"] as const)(
    "routes %s directly, keeps ordinary resume inert, and makes replay idempotent",
    async (decision) => {
      const calls: string[] = [];
      const store = new InMemoryPipelineCheckpointStore();
      const runtime = new PipelineRuntime({
        definition: approvalDefinition(),
        checkpointStore: store,
        interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
        predicates: {
          "must-not-run": () => {
            throw new Error("approval predicate must not run");
          },
        },
        nodeExecutor: async (nodeId) => {
          calls.push(nodeId);
          return { nodeId, output: nodeId, durationMs: 1 };
        },
      });

      const suspended = await runtime.execute({}, { runId: `run-${decision}` });
      expect(suspended.state).toBe("suspended");
      const checkpoint = (await store.load(`run-${decision}`))!;
      const pending = checkpoint.pendingInteraction!;

      const ordinary = await runtime.resume(checkpoint, { injected: true });
      expect(ordinary.state).toBe("suspended");
      expect(ordinary.pendingInteraction).toEqual(pending);
      expect(calls).toEqual([]);

      const receipt = receiptFor(pending, decision);
      const completed = await runtime.resumeInteraction(checkpoint, receipt);
      expect(completed.state).toBe("completed");
      expect(calls).toEqual([decision]);

      const committed = (await store.load(`run-${decision}`))!;
      expect(committed.pendingInteraction).toBeUndefined();
      expect(committed.interactionReceipts?.[pending.interactionId]).toEqual(receipt);
      expect(committed.interactionResumeCursor).toBeUndefined();
      expect(committed.completedNodeIds).toEqual(["gate", decision]);
      expect(committed.state).not.toHaveProperty("injected");

      await expect(runtime.resumeInteraction(checkpoint, receipt)).resolves.toMatchObject({
        state: "completed",
      });
      expect(calls).toEqual([decision]);

      const conflict = receiptFor(
        pending,
        decision === "approved" ? "rejected" : "approved",
        "conflicting-receipt",
      );
      await expect(runtime.resumeInteraction(checkpoint, conflict)).rejects.toMatchObject({
        code: "INTERACTION_RECEIPT_CONFLICT",
      });
    },
  );

  it("validates clarification and writes only the authored output key", async () => {
    const observedStates: Record<string, unknown>[] = [];
    const store = new InMemoryPipelineCheckpointStore();
    const interaction = createPipelineInteractionSpecV1({
      kind: "clarification",
      authoredNodeId: "clarify",
      authoredPath: "root.nodes[0]",
      question: "Environment?",
      choices: ["staging", "preview"],
      outputKey: "environment",
      requestSchema: {
        kind: "clarification",
        response: "choice",
        minLength: 1,
        maxLength: 256,
      },
    });
    const definition: PipelineDefinition = {
      id: "clarification-pipeline",
      name: "clarification",
      version: "1",
      schemaVersion: "1.1.0",
      entryNodeId: "clarify",
      checkpointStrategy: "on_suspend",
      nodes: [
        { id: "clarify", type: "suspend", interaction },
        { id: "after", type: "agent", agentId: "after" },
      ],
      edges: [
        { type: "sequential", sourceNodeId: "clarify", targetNodeId: "after" },
      ],
    };
    const runtime = new PipelineRuntime({
      definition,
      checkpointStore: store,
      interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
      nodeExecutor: async (nodeId, _node: PipelineNode, context) => {
        observedStates.push(structuredClone(context.state));
        return { nodeId, output: null, durationMs: 1 };
      },
    });
    await runtime.execute({ retained: "yes" }, { runId: "clarification-run" });
    const checkpoint = (await store.load("clarification-run"))!;
    const pending = checkpoint.pendingInteraction!;
    const receipt = createPipelineInteractionResumeV1({
      ...pending,
      receiptId: "clarification-receipt",
      submittedAt: "2026-08-14T20:00:01.000Z",
      response: { kind: "clarification", value: "staging" },
    });
    await runtime.resumeInteraction(checkpoint, receipt);
    expect(observedStates).toEqual([{ retained: "yes", environment: "staging" }]);
    expect((await store.load("clarification-run"))?.state).toEqual({
      retained: "yes",
      environment: "staging",
    });
  });

  it("consumes a terminal clarification without inventing a successor", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const interaction = createPipelineInteractionSpecV1({
      kind: "clarification",
      authoredNodeId: "clarify",
      authoredPath: "root.nodes[0]",
      question: "Final note?",
      choices: [],
      outputKey: "finalNote",
      requestSchema: {
        kind: "clarification",
        response: "text",
        minLength: 1,
        maxLength: 256,
      },
    });
    const runtime = new PipelineRuntime({
      definition: {
        id: "terminal-clarification",
        name: "terminal clarification",
        version: "1",
        schemaVersion: "1.1.0",
        entryNodeId: "clarify",
        checkpointStrategy: "on_suspend",
        nodes: [{ id: "clarify", type: "suspend", interaction }],
        edges: [],
      },
      checkpointStore: store,
      interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
    });
    await runtime.execute({}, { runId: "terminal-clarification-run" });
    const checkpoint = (await store.load("terminal-clarification-run"))!;
    const pending = checkpoint.pendingInteraction!;
    const receipt = createPipelineInteractionResumeV1({
      ...pending,
      receiptId: "terminal-clarification-receipt",
      submittedAt: "2026-08-14T20:00:01.000Z",
      response: { kind: "clarification", value: "complete" },
    });

    await expect(
      runtime.resumeInteraction(checkpoint, receipt),
    ).resolves.toMatchObject({ state: "completed" });
    const completed = (await store.load("terminal-clarification-run"))!;
    expect(completed.completedNodeIds).toEqual(["clarify"]);
    expect(completed.state).toEqual({ finalNote: "complete" });
    expect(completed.interactionResumeCursor).toBeUndefined();
    await expect(
      runtime.resumeInteraction(checkpoint, receipt),
    ).resolves.toMatchObject({ state: "completed" });
  });

  it("replaying an older receipt preserves a newer pending interaction", async () => {
    const calls: string[] = [];
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: sequentialApprovalDefinition(),
      checkpointStore: store,
      interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
      predicates: {
        "first-must-not-run": () => {
          throw new Error("first approval predicate must not run");
        },
        "second-must-not-run": () => {
          throw new Error("second approval predicate must not run");
        },
      },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    });

    await runtime.execute({}, { runId: "sequential-approval-run" });
    const firstCheckpoint = (await store.load("sequential-approval-run"))!;
    const firstReceipt = receiptFor(
      firstCheckpoint.pendingInteraction!,
      "approved",
      "first-approved-receipt",
    );
    const secondSuspension = await runtime.resumeInteraction(
      firstCheckpoint,
      firstReceipt,
    );
    expect(secondSuspension.state).toBe("suspended");
    const secondCheckpoint = (await store.load("sequential-approval-run"))!;
    expect(secondCheckpoint.pendingInteraction?.nodeId).toBe("second-gate");
    expect(secondCheckpoint.interactionResumeCursor).toBeUndefined();

    const restarted = new PipelineRuntime({
      definition: sequentialApprovalDefinition(),
      checkpointStore: store,
      interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
      predicates: {
        "first-must-not-run": () => {
          throw new Error("first approval predicate must not run");
        },
        "second-must-not-run": () => {
          throw new Error("second approval predicate must not run");
        },
      },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    });
    expect(restarted.getRunState()).toBe("idle");
    const replayed = await restarted.resumeInteraction(
      firstCheckpoint,
      firstReceipt,
    );
    expect(replayed).toMatchObject({
      state: "suspended",
      pendingInteraction: secondCheckpoint.pendingInteraction,
    });
    expect(restarted.getRunState()).toBe("suspended");
    expect(calls).toEqual([]);
    expect((await store.load("sequential-approval-run"))?.pendingInteraction)
      .toEqual(secondCheckpoint.pendingInteraction);
  });

  it("rejects expired and mismatched receipts before dispatch", async () => {
    let now = new Date("2026-08-14T20:00:00.000Z");
    const calls: string[] = [];
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: approvalDefinition(),
      checkpointStore: store,
      interaction: { ttlMs: 1_000, now: () => now },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: null, durationMs: 1 };
      },
    });
    await runtime.execute({}, { runId: "expiry-run" });
    const checkpoint = (await store.load("expiry-run"))!;
    const pending = checkpoint.pendingInteraction!;
    const mismatched = createPipelineInteractionResumeV1({
      ...pending,
      runId: "other-run",
      receiptId: "mismatch",
      submittedAt: "2026-08-14T20:00:00.100Z",
      response: { kind: "approval", decision: "approved" },
    });
    await expect(runtime.resumeInteraction(checkpoint, mismatched)).rejects.toMatchObject({
      code: "INTERACTION_BINDING_MISMATCH",
    });
    now = new Date("2026-08-14T20:00:02.000Z");
    await expect(
      runtime.resumeInteraction(checkpoint, receiptFor(pending, "approved")),
    ).rejects.toMatchObject({ code: "INTERACTION_EXPIRED" });
    expect(calls).toEqual([]);
  });

  it("rejects a coherently re-identified nonzero pipeline occurrence before dispatch", async () => {
    const calls: string[] = [];
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: approvalDefinition(),
      checkpointStore: store,
      interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    });
    await runtime.execute({}, { runId: "pipeline-occurrence-drift" });
    const checkpoint = (await store.load("pipeline-occurrence-drift"))!;
    const forgedVersion = checkpoint.version + 1;
    const forgedPending = pendingWithOccurrence(
      checkpoint.pendingInteraction!,
      1,
      forgedVersion,
    );
    const forgedCheckpoint = {
      ...checkpoint,
      version: forgedVersion,
      pendingInteraction: forgedPending,
    };
    await store.save(forgedCheckpoint);

    expect(forgedPending.interactionId).not.toBe(
      checkpoint.pendingInteraction!.interactionId,
    );
    await expect(
      runtime.resumeInteraction(
        forgedCheckpoint,
        receiptFor(forgedPending, "approved", "forged-occurrence-receipt"),
      ),
    ).rejects.toMatchObject({ code: "INTERACTION_BINDING_MISMATCH" });
    expect(calls).toEqual([]);
  });

  it.each(["before-save", "save-then-throw"] as const)(
    "recovers exactly once when the consumed checkpoint fails %s",
    async (failureMode) => {
      const calls: string[] = [];
      const store = new InteractionCommitFailureStore(failureMode);
      const runtime = new PipelineRuntime({
        definition: approvalDefinition(),
        checkpointStore: store,
        interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
        nodeExecutor: async (nodeId) => {
          calls.push(nodeId);
          return { nodeId, output: nodeId, durationMs: 1 };
        },
      });
      await runtime.execute({}, { runId: `failure-${failureMode}` });
      const suspended = (await store.load(`failure-${failureMode}`))!;
      const receipt = receiptFor(suspended.pendingInteraction!, "approved");

      await expect(
        runtime.resumeInteraction(suspended, receipt),
      ).rejects.toThrow("injected interaction commit failure");
      expect(calls).toEqual([]);

      await expect(
        runtime.resumeInteraction(suspended, receipt),
      ).resolves.toMatchObject({ state: "completed" });
      expect(calls).toEqual(["approved"]);
      expect(
        (await store.load(`failure-${failureMode}`))?.interactionResumeCursor,
      ).toBeUndefined();

      await runtime.resumeInteraction(suspended, receipt);
      expect(calls).toEqual(["approved"]);
    },
  );

  it("rejects cursor corruption and same-id definition drift before dispatch", async () => {
    const calls: string[] = [];
    const store = new InteractionCommitFailureStore("save-then-throw");
    const definition = approvalDefinition();
    const runtime = new PipelineRuntime({
      definition,
      checkpointStore: store,
      interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    });
    await runtime.execute({}, { runId: "corrupt-cursor" });
    const suspended = (await store.load("corrupt-cursor"))!;
    const receipt = receiptFor(suspended.pendingInteraction!, "approved");
    await expect(runtime.resumeInteraction(suspended, receipt)).rejects.toThrow(
      "injected interaction commit failure",
    );
    const committed = (await store.load("corrupt-cursor"))!;
    expect(committed.interactionResumeCursor).toBeDefined();

    const corruptCursor = structuredClone(committed);
    corruptCursor.interactionResumeCursor = {
      ...corruptCursor.interactionResumeCursor!,
      nextNodeId: "rejected",
    };
    await expect(runtime.resume(corruptCursor)).rejects.toMatchObject({
      code: "INTERACTION_BINDING_MISMATCH",
    });

    const driftedRuntime = new PipelineRuntime({
      definition: { ...definition, version: "2" },
      checkpointStore: store,
      nodeExecutor: async (nodeId) => {
        calls.push(nodeId);
        return { nodeId, output: nodeId, durationMs: 1 };
      },
    });
    await expect(
      driftedRuntime.resumeInteraction(suspended, receipt),
    ).rejects.toMatchObject({ code: "INTERACTION_BINDING_MISMATCH" });
    expect(calls).toEqual([]);
  });
});

class InteractionCommitFailureStore extends InMemoryPipelineCheckpointStore {
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
      throw new Error("injected interaction commit failure");
    }
    await super.save(checkpoint);
  }
}
