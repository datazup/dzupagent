/**
 * Focused tests for the delegation finalize seams extracted in
 * DZUPAGENT-CODE-M-11 (SimpleDelegationTracker.delegate decomposition).
 *
 * These pin behaviors of the `finalizeSuccess` path that the broader
 * delegation.test.ts suite exercises only indirectly:
 *  - a non-`completed` terminal run state produces a failed (not thrown)
 *    DelegationResult carrying the run's error, and
 *  - duration metadata is always attached/overwritten while the store's
 *    tokenUsage flows through into result metadata.
 *
 * Behavior here is IDENTICAL to pre-refactor delegate(); the refactor was a
 * pure structural extraction into private methods.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryRunStore, createEventBus } from "@dzupagent/core";
import type { DzupEventBus, DzupEvent } from "@dzupagent/core";
import {
  SimpleDelegationTracker,
  type DelegationRequest,
  type DelegationExecutor,
} from "../orchestration/delegation.js";

function makeRequest(
  overrides: Partial<DelegationRequest> = {}
): DelegationRequest {
  return {
    targetAgentId: "specialist-x",
    task: "do work",
    input: { k: "v" },
    context: {
      parentRunId: "parent-1",
      decisions: [],
      constraints: [],
      relevantFiles: [],
    },
    ...overrides,
  };
}

describe("SimpleDelegationTracker finalize seams (CODE-M-11)", () => {
  let store: InMemoryRunStore;
  let eventBus: DzupEventBus;
  let events: DzupEvent[];

  beforeEach(() => {
    store = new InMemoryRunStore();
    eventBus = createEventBus();
    events = [];
    eventBus.onAny((e) => events.push(e));
  });

  it("finalizeSuccess: executor that leaves run non-completed yields failed result with the run error", async () => {
    // Executor returns cleanly but marks the run as failed (as a real worker
    // would when the specialist errored but still reported terminal state).
    const executor: DelegationExecutor = async (runId) => {
      await store.update(runId, {
        status: "failed",
        error: "specialist reported failure",
        completedAt: new Date(),
      });
    };
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor,
    });

    const result = await tracker.delegate(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toBe("specialist reported failure");
    // Duration metadata is always attached on the success-finalize path.
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);

    // Completed-with-success=false still emits delegation:completed (not :failed),
    // because the executor returned normally rather than throwing.
    await new Promise((r) => setTimeout(r, 10));
    const completed = events.find((e) => e.type === "delegation:completed");
    expect(completed).toBeDefined();
    expect((completed as { success: boolean }).success).toBe(false);
  });

  it("finalizeSuccess: overwrites durationMs while preserving store tokenUsage in metadata", async () => {
    const executor: DelegationExecutor = async (runId) => {
      await store.update(runId, {
        status: "completed",
        output: "ok",
        completedAt: new Date(),
        tokenUsage: { input: 111, output: 222 },
      });
    };
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor,
    });

    const result = await tracker.delegate(makeRequest());

    expect(result.success).toBe(true);
    expect(result.metadata).toBeDefined();
    // durationMs is computed by finalizeSuccess (not a fixed sentinel).
    expect(result.metadata!.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata!.tokenUsage).toEqual({ input: 111, output: 222 });
  });

  it("startDelegation: registers exactly one active entry that clears on completion", async () => {
    let observedActive = -1;
    const executor: DelegationExecutor = async (runId) => {
      // At this point startDelegation has already registered the entry.
      observedActive = tracker.getActiveDelegations().length;
      await store.update(runId, {
        status: "completed",
        output: "ok",
        completedAt: new Date(),
      });
    };
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor,
    });

    await tracker.delegate(makeRequest());

    expect(observedActive).toBe(1);
    expect(tracker.getActiveDelegations()).toHaveLength(0);
  });
});
