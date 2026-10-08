/**
 * DZA-HITL-gate-wiring-20261008-R1 — opt-in quorum and escalation on
 * ApprovalGate. The default gate behaviour is covered by approval-gate.test.ts
 * and must stay unchanged; this file covers only the new members.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalGate,
  ApproverNotActiveError,
  InMemoryApprovalStateStore,
  InMemoryQuorumVoteStore,
  InvalidEscalationPolicyError,
  UnknownApprovalError,
  UnknownApproverError,
  type EscalationEvent,
  type EscalationPolicy,
  type QuorumPolicy,
} from "../index.js";

const majority: QuorumPolicy = {
  strategy: "majority",
  approvers: ["alice", "bob", "carol"],
};

describe("ApprovalGate — opt-in quorum", () => {
  let store: InMemoryApprovalStateStore;
  let gate: ApprovalGate;

  beforeEach(() => {
    store = new InMemoryApprovalStateStore();
    gate = new ApprovalGate({ store });
  });

  afterEach(() => {
    store.clear();
  });

  it("defaults to an in-memory vote store", () => {
    expect(gate.voteStore).toBeInstanceOf(InMemoryQuorumVoteStore);
  });

  it("uses the vote store passed in options", () => {
    const voteStore = new InMemoryQuorumVoteStore();
    expect(new ApprovalGate({ voteStore }).voteStore).toBe(voteStore);
  });

  it("leaves the approval pending until the tally is terminal", async () => {
    await store.createPending("run-1", "ap-1", null);
    const tally = await gate.vote("run-1", "ap-1", majority, {
      approverId: "alice",
      decision: "granted",
    });
    expect(tally.status).toBe("pending");
    await expect(store.poll("run-1", "ap-1", 10)).rejects.toThrow(/timed out/);
  });

  it("grants the approval with the tally once quorum is reached", async () => {
    const outcome = gate.waitForApproval("run-1", "ap-1", { q: "ship?" }, 5_000);
    await gate.vote("run-1", "ap-1", majority, { approverId: "alice", decision: "granted" });
    const tally = await gate.vote("run-1", "ap-1", majority, {
      approverId: "carol",
      decision: "granted",
    });
    expect(tally.status).toBe("granted");
    await expect(outcome).resolves.toEqual({
      decision: "granted",
      response: { quorum: tally },
    });
  });

  it("rejects the approval once quorum becomes unreachable", async () => {
    const outcome = gate.waitForApproval("run-1", "ap-1", null, 5_000);
    await gate.vote("run-1", "ap-1", majority, { approverId: "alice", decision: "rejected" });
    const tally = await gate.vote("run-1", "ap-1", majority, {
      approverId: "bob",
      decision: "rejected",
    });
    expect(tally.status).toBe("rejected");
    await expect(outcome).resolves.toEqual({
      decision: "rejected",
      reason: "Quorum not reached: 2 of 3 approvers rejected",
    });
  });

  it("does not store votes after the tally is terminal", async () => {
    await store.createPending("run-1", "ap-1", null);
    const any: QuorumPolicy = { strategy: "any", approvers: ["alice", "bob"] };
    await gate.vote("run-1", "ap-1", any, { approverId: "alice", decision: "granted" });
    const tally = await gate.vote("run-1", "ap-1", any, {
      approverId: "bob",
      decision: "rejected",
    });
    expect(tally).toMatchObject({ status: "granted", granted: ["alice"], rejected: [] });
    expect(await gate.voteStore.listVotes("run-1", "ap-1")).toHaveLength(1);
    expect(await store.poll("run-1", "ap-1", 10)).toMatchObject({ decision: "granted" });
  });

  it("rejects a vote from a non-member without storing it", async () => {
    await store.createPending("run-1", "ap-1", null);
    await expect(
      gate.vote("run-1", "ap-1", majority, { approverId: "mallory", decision: "granted" }),
    ).rejects.toBeInstanceOf(UnknownApproverError);
    expect(await gate.voteStore.listVotes("run-1", "ap-1")).toEqual([]);
  });

  it("surfaces UnknownApprovalError when a terminal tally has no pending approval, and heals on retry", async () => {
    const any: QuorumPolicy = { strategy: "any", approvers: ["alice"] };
    await expect(
      gate.vote("run-1", "ap-1", any, { approverId: "alice", decision: "granted" }),
    ).rejects.toBeInstanceOf(UnknownApprovalError);
    await store.createPending("run-1", "ap-1", null);
    const tally = await gate.vote("run-1", "ap-1", any, {
      approverId: "alice",
      decision: "granted",
    });
    expect(tally.status).toBe("granted");
    expect(await store.poll("run-1", "ap-1", 10)).toMatchObject({ decision: "granted" });
  });
});

const chain: EscalationPolicy = {
  levels: [
    { approvers: ["lead"], timeoutMs: 1_000 },
    { approvers: ["manager", "director"], timeoutMs: 2_000 },
  ],
};

describe("ApprovalGate — opt-in escalation", () => {
  let store: InMemoryApprovalStateStore;
  let gate: ApprovalGate;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    store = new InMemoryApprovalStateStore();
    gate = new ApprovalGate({ store });
  });

  afterEach(() => {
    store.clear();
    vi.useRealTimers();
  });

  it("validates the policy before creating the pending approval", async () => {
    await expect(
      gate.waitForEscalation("run-1", "ap-1", null, { levels: [] }),
    ).rejects.toBeInstanceOf(InvalidEscalationPolicyError);
    expect(store.getPayload("run-1", "ap-1")).toBeUndefined();
  });

  it("grants when an active-level approver grants, and stores the payload", async () => {
    const events: EscalationEvent[] = [];
    const outcome = gate.waitForEscalation("run-1", "ap-1", { q: "deploy?" }, chain, {
      onEvent: (e) => events.push(e),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(store.getPayload("run-1", "ap-1")).toEqual({ q: "deploy?" });
    const state = await gate.decideEscalation("run-1", "ap-1", "lead", "granted");
    expect(state).toMatchObject({ status: "granted", level: 0 });
    await expect(outcome).resolves.toEqual({
      decision: "granted",
      response: { approverId: "lead", level: 0 },
    });
    expect(events.map((e) => e.type)).toEqual(["level_started", "decided"]);
  });

  it("escalates on timeout; only the active level may decide", async () => {
    const events: EscalationEvent[] = [];
    const outcome = gate.waitForEscalation("run-1", "ap-1", null, chain, {
      onEvent: (e) => events.push(e),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.map((e) => e.type)).toEqual([
      "level_started",
      "level_timed_out",
      "level_started",
    ]);
    await expect(
      gate.decideEscalation("run-1", "ap-1", "lead", "granted"),
    ).rejects.toBeInstanceOf(ApproverNotActiveError);
    await gate.decideEscalation("run-1", "ap-1", "director", "rejected", "too risky");
    await expect(outcome).resolves.toEqual({ decision: "rejected", reason: "too risky" });
  });

  it("uses a default rejection reason naming the approver and level", async () => {
    const outcome = gate.waitForEscalation("run-1", "ap-1", null, chain);
    await vi.advanceTimersByTimeAsync(10);
    await gate.decideEscalation("run-1", "ap-1", "lead", "rejected");
    await expect(outcome).resolves.toEqual({
      decision: "rejected",
      reason: "Rejected by lead at escalation level 0",
    });
  });

  it("includes the reason in a granted response when given", async () => {
    const outcome = gate.waitForEscalation("run-1", "ap-1", null, chain);
    await vi.advanceTimersByTimeAsync(10);
    await gate.decideEscalation("run-1", "ap-1", "lead", "granted", "looks good");
    await expect(outcome).resolves.toEqual({
      decision: "granted",
      response: { approverId: "lead", level: 0, reason: "looks good" },
    });
  });

  it("rejects by default when the chain is exhausted", async () => {
    const events: EscalationEvent[] = [];
    const outcome = gate.waitForEscalation("run-1", "ap-1", null, chain, {
      onEvent: (e) => events.push(e),
    });
    const settled = vi.fn();
    void outcome.then(settled);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toEqual({
      decision: "rejected",
      reason: "Escalation exhausted: no decision before the last level timed out",
    });
    expect(events.at(-1)).toEqual({
      type: "exhausted",
      action: "reject",
      decision: "rejected",
      at: 3_000,
    });
  });

  it("grants on exhaustion when onExhausted is 'approve'", async () => {
    const outcome = gate.waitForEscalation("run-1", "ap-1", null, {
      ...chain,
      onExhausted: "approve",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(outcome).resolves.toEqual({
      decision: "granted",
      response: { escalation: "exhausted" },
    });
  });

  it("a second wait for the same key reuses the running engine", async () => {
    const first = gate.waitForEscalation("run-1", "ap-1", null, chain);
    await vi.advanceTimersByTimeAsync(1_500);
    const events: EscalationEvent[] = [];
    const second = gate.waitForEscalation("run-1", "ap-1", null, chain, {
      onEvent: (e) => events.push(e),
    });
    await vi.advanceTimersByTimeAsync(10);
    // Still on level 1: level 0's approver has lost authority.
    await expect(
      gate.decideEscalation("run-1", "ap-1", "lead", "granted"),
    ).rejects.toBeInstanceOf(ApproverNotActiveError);
    await gate.decideEscalation("run-1", "ap-1", "manager", "granted");
    const expected = { decision: "granted", response: { approverId: "manager", level: 1 } };
    await expect(first).resolves.toEqual(expected);
    await expect(second).resolves.toEqual(expected);
    expect(events).toEqual([]);
  });

  it("a direct grant ends the wait as an operator override", async () => {
    const outcome = gate.waitForEscalation("run-1", "ap-1", null, chain);
    await vi.advanceTimersByTimeAsync(10);
    await gate.grant("run-1", "ap-1", { by: "ops" });
    await expect(outcome).resolves.toEqual({ decision: "granted", response: { by: "ops" } });
  });

  it("decideEscalation throws UnknownApprovalError when no escalation is waiting", async () => {
    await expect(
      gate.decideEscalation("run-1", "ap-1", "lead", "granted"),
    ).rejects.toBeInstanceOf(UnknownApprovalError);
    const outcome = gate.waitForEscalation("run-1", "ap-1", null, chain);
    await vi.advanceTimersByTimeAsync(10);
    await gate.decideEscalation("run-1", "ap-1", "lead", "granted");
    await outcome;
    await expect(
      gate.decideEscalation("run-1", "ap-1", "lead", "rejected"),
    ).rejects.toBeInstanceOf(UnknownApprovalError);
  });
});
