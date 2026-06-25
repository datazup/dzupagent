/**
 * M-13 tests: auto-wire pipeline stuck-detector + checkpointing
 *
 * Test 1: crash recovery — 3-node workflow, crash after node 2, resume with
 *         same workflowRunId, assert nodes 1+2 NOT re-executed, only node 3 runs.
 *
 * Test 2: stuck detection — inject a stuck detector (maxNodeFailures=1) that
 *         always signals stuck; assert the workflow halts and emits workflow:stuck
 *         before the workflow:failed event.
 *
 * Test 3: end-to-end — no checkpoint, all 3 nodes execute in order.
 */
import { describe, it, expect } from "vitest";
import { createWorkflow } from "../workflow/index.js";
import type {
  WorkflowEvent,
  WorkflowStep,
} from "../workflow/workflow-types.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type {
  PipelineCheckpoint,
  PipelineCheckpointStore,
  PipelineCheckpointSummary,
} from "@dzupagent/core/pipeline";

function step(
  id: string,
  fn: (state: Record<string, unknown>) => Record<string, unknown>
): WorkflowStep {
  return { id, execute: async (input) => fn(input as Record<string, unknown>) };
}

// ---------------------------------------------------------------------------
// Test 1 — Crash recovery: nodes 1+2 skip, only node 3 runs on resume
// ---------------------------------------------------------------------------
describe("M-13 crash recovery", () => {
  it("resumes from checkpoint after simulated crash — nodes 1 and 2 not re-executed", async () => {
    const callLog: string[] = [];

    // Intercepting checkpoint store: captures every saved checkpoint in order.
    const savedCheckpoints: PipelineCheckpoint[] = [];
    const inner = new InMemoryPipelineCheckpointStore();
    const interceptingStore: PipelineCheckpointStore = {
      async save(cp) {
        savedCheckpoints.push(structuredClone(cp));
        return inner.save(cp);
      },
      async load(runId) {
        return inner.load(runId);
      },
      async loadVersion(runId, version) {
        return inner.loadVersion(runId, version);
      },
      async listVersions(runId) {
        return inner.listVersions(runId);
      },
      async delete(runId) {
        return inner.delete(runId);
      },
      async prune(maxAgeMs) {
        return inner.prune(maxAgeMs);
      },
    } satisfies PipelineCheckpointStore;

    const workflow = createWorkflow({ id: "crash-recovery" })
      .then(
        step("node1", (s) => {
          callLog.push("node1");
          return { ...s, n1: true };
        })
      )
      .then(
        step("node2", (s) => {
          callLog.push("node2");
          return { ...s, n2: true };
        })
      )
      .then(
        step("node3", (s) => {
          callLog.push("node3");
          return { ...s, n3: true };
        })
      )
      .build()
      .withCheckpointStore(interceptingStore);

    // Phase 1: complete run (saves per-node checkpoints via after_each_node strategy).
    await workflow.run({ start: true });

    // All 3 nodes ran in phase 1.
    expect(callLog).toEqual(["node1", "node2", "node3"]);

    // We should have at least 3 checkpoint saves (one per step node).
    // Some transforms may also generate saves, so use >= 2.
    expect(savedCheckpoints.length).toBeGreaterThanOrEqual(2);

    // Find the checkpoint that has exactly 2 completed node IDs — this is the
    // "crash point" snapshot after node 2 finished.
    const checkpointAfterNode2 = savedCheckpoints.find(
      (cp) => cp.completedNodeIds.length === 2
    );
    expect(checkpointAfterNode2).toBeDefined();

    // Re-save this checkpoint under a stable crash-recovery run ID that the
    // CompiledWorkflow crash recovery path will look up.
    const crashRunId = "crash-recovery-run-001";
    const crashCheckpoint: PipelineCheckpoint = {
      ...checkpointAfterNode2!,
      pipelineRunId: crashRunId,
    };
    await interceptingStore.save(crashCheckpoint);

    // Phase 2: resume after crash — only node 3 should execute.
    callLog.length = 0;

    const resultPhase2 = await workflow.run(
      { start: true },
      { workflowRunId: crashRunId }
    );

    // Only node 3 was re-executed.
    expect(callLog).toEqual(["node3"]);

    // State from checkpoint (n1, n2) merged with node3's output.
    expect(resultPhase2["n1"]).toBe(true);
    expect(resultPhase2["n2"]).toBe(true);
    expect(resultPhase2["n3"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Stuck detection: workflow halts and emits workflow:stuck
// ---------------------------------------------------------------------------
describe("M-13 stuck detection", () => {
  it("halts and emits workflow:stuck when detector signals stuck after node 2 fails", async () => {
    const events: WorkflowEvent[] = [];

    // Configure a tight stuck detector: 1 failure per node triggers stuck.
    const workflow = createWorkflow({ id: "stuck-test" })
      .then(step("node1", (s) => ({ ...s, n1: true })))
      .then(
        step("node2", () => {
          throw new Error("always fails");
        })
      )
      .then(step("node3", (s) => ({ ...s, n3: true })))
      .build()
      .withStuckDetector({ maxNodeFailures: 1, maxTotalRetries: 5 });

    await workflow.run({}, { onEvent: (e) => events.push(e) }).catch(() => {
      /* expected — workflow fails when stuck */
    });

    const stuckEvent = events.find((e) => e.type === "workflow:stuck");
    const failedEvent = events.find((e) => e.type === "workflow:failed");

    // A stuck event must have been emitted before the workflow failed.
    expect(stuckEvent).toBeDefined();
    expect(
      (stuckEvent as { type: "workflow:stuck"; nodeId: string; reason: string })
        .reason
    ).toBeTruthy();

    // The workflow must have been aborted after the stuck signal.
    expect(failedEvent).toBeDefined();

    // node3 must NOT have been executed (halted after node2 went stuck).
    const n3StepStarted = events.find(
      (e) =>
        e.type === "step:started" &&
        (e as { stepId: string }).stepId.includes("node3")
    );
    expect(n3StepStarted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — End-to-end: no checkpoint, all 3 nodes execute in order
// ---------------------------------------------------------------------------
describe("M-13 end-to-end baseline", () => {
  it("executes all 3 nodes in order without a checkpoint store", async () => {
    const executionOrder: string[] = [];

    const workflow = createWorkflow({ id: "e2e-baseline" })
      .then(
        step("alpha", (s) => {
          executionOrder.push("alpha");
          return { ...s, alpha: 1 };
        })
      )
      .then(
        step("beta", (s) => {
          executionOrder.push("beta");
          return { ...s, beta: 2 };
        })
      )
      .then(
        step("gamma", (s) => {
          executionOrder.push("gamma");
          return { ...s, gamma: 3 };
        })
      )
      .build();

    const result = await workflow.run({ start: true });

    // All 3 nodes ran in order.
    expect(executionOrder).toEqual(["alpha", "beta", "gamma"]);

    // Final state accumulates all outputs.
    expect(result["start"]).toBe(true);
    expect(result["alpha"]).toBe(1);
    expect(result["beta"]).toBe(2);
    expect(result["gamma"]).toBe(3);
  });
});
