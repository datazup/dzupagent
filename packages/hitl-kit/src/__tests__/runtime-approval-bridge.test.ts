import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { RuntimeApprovalBridge, InMemoryApprovalStateStore } from "../index.js";

describe("RuntimeApprovalBridge (MPCO P6 / T10)", () => {
  let store: InMemoryApprovalStateStore;
  let bridge: RuntimeApprovalBridge;

  beforeEach(() => {
    store = new InMemoryApprovalStateStore();
    bridge = new RuntimeApprovalBridge({ store });
  });

  afterEach(() => {
    store.clear();
  });

  it("derives a deterministic approval id runId:nodeId:attempt", () => {
    expect(bridge.approvalId("run-1", "node-x", 2)).toBe("run-1:node-x:2");
  });

  // T10: ensurePending no-ops on duplicate
  it("T10a: ensurePending no-ops on a duplicate (does not throw)", async () => {
    const id = bridge.approvalId("run-1", "node-x", 1);
    await bridge.ensurePending("run-1", id, { question: "apply?" });
    // Second call (resume) must not throw, even though the underlying store may
    // throw DuplicateApprovalError — the bridge swallows it.
    await expect(
      bridge.ensurePending("run-1", id, { question: "apply?" })
    ).resolves.toBeUndefined();
  });

  it("maps granted/rejected outcomes to the CollabGateDecision vocabulary", () => {
    expect(bridge.mapOutcome({ decision: "granted" })).toBe("human_approved");
    expect(bridge.mapOutcome({ decision: "rejected", reason: "no" })).toBe(
      "human_rejected"
    );
  });

  it("pollTerminal returns human_approved after a grant", async () => {
    const id = bridge.approvalId("run-1", "node-x", 1);
    await bridge.ensurePending("run-1", id, null);
    const pending = bridge.pollTerminal("run-1", id, 5_000);
    await store.grant("run-1", id, { approvedBy: "alice" });
    await expect(pending).resolves.toBe("human_approved");
  });

  // T10: pollTerminal returns prior outcome on resume
  it("T10b: pollTerminal returns the PRIOR outcome on resume (re-ensure + re-poll)", async () => {
    const id = bridge.approvalId("run-1", "node-x", 1);
    await bridge.ensurePending("run-1", id, null);
    await store.reject("run-1", id, "blocked by operator");
    // Simulate process resume: re-ensure (no-op) then poll again. The store
    // already holds the terminal outcome, so poll returns it immediately.
    await bridge.ensurePending("run-1", id, null);
    await expect(bridge.pollTerminal("run-1", id, 1_000)).resolves.toBe(
      "human_rejected"
    );
  });

  it("maps a poll timeout to the timeout gate decision", async () => {
    const id = bridge.approvalId("run-1", "node-x", 1);
    await bridge.ensurePending("run-1", id, null);
    await expect(bridge.pollTerminal("run-1", id, 5)).resolves.toBe("timeout");
  });
});
