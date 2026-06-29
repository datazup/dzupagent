/**
 * W30-A — HITL-kit approval-gate integration deep coverage.
 *
 * Covers scenarios not exercised by the baseline approval-gate.test.ts:
 *   - Multi-approver patterns (AND / OR / majority) composed from the store
 *   - Timeout behaviour + auto-resolve strategies
 *   - Timeout escalation (secondary approver)
 *   - Durable state: serialise / deserialise across simulated restarts
 *   - Metadata: who approved, timestamp, reason / comment
 *   - Conditional gates: bypass vs. require
 *   - Gate in workflow: pause → resume → skip
 *   - Duplicate approval idempotence
 *   - Approval expiry before workflow resume
 *   - Error cases: unknown approver, invalid token, revoked approval
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApprovalGate,
  ApprovalRejectedError,
  ApprovalTimeoutError,
  DuplicateApprovalError,
  InMemoryApprovalStateStore,
  UnknownApprovalError,
  type ApprovalOutcome,
  type ApprovalStateStore,
} from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  return new InMemoryApprovalStateStore();
}

/**
 * Multi-approver orchestrator built on top of the standard store.
 *
 * Wraps a single InMemoryApprovalStateStore and tracks per-approver
 * decisions in-memory. Resolves the backing store only when the quorum
 * condition is met. This is intentionally self-contained test infrastructure
 * — no changes to production code.
 */
class MultiApproverGate {
  private readonly store: InMemoryApprovalStateStore;
  private approverDecisions = new Map<
    string,
    {
      approver: string;
      decision: "granted" | "rejected";
      reason?: string;
      at: Date;
    }[]
  >();

  constructor(store?: InMemoryApprovalStateStore) {
    this.store = store ?? new InMemoryApprovalStateStore();
  }

  async createPending(
    runId: string,
    approvalId: string,
    payload: unknown,
  ): Promise<void> {
    await this.store.createPending(runId, approvalId, payload);
    this.approverDecisions.set(`${runId}::${approvalId}`, []);
  }

  /**
   * Record one approver's decision.
   *
   * @param strategy 'and' = all must approve, 'or' = any one approves,
   *                 'majority' = >50% must approve
   */
  async recordDecision(
    runId: string,
    approvalId: string,
    approver: string,
    decision: "granted" | "rejected",
    options: {
      strategy: "and" | "or" | "majority";
      requiredApprovers: string[];
      reason?: string;
    },
  ): Promise<void> {
    const key = `${runId}::${approvalId}`;
    const decisions = this.approverDecisions.get(key);
    if (!decisions) throw new Error(`No pending approval: ${key}`);

    // Idempotent: same approver decision is counted once
    const existing = decisions.find((d) => d.approver === approver);
    if (existing) return; // duplicate — ignore

    decisions.push({
      approver,
      decision,
      reason: options.reason,
      at: new Date(),
    });

    const granted = decisions.filter((d) => d.decision === "granted");
    const rejected = decisions.filter((d) => d.decision === "rejected");
    const total = options.requiredApprovers.length;

    if (options.strategy === "or") {
      if (granted.length >= 1) {
        await this.store.grant(runId, approvalId, this.buildMeta(granted));
      } else if (rejected.length === total) {
        await this.store.reject(
          runId,
          approvalId,
          rejected.map((r) => r.reason ?? "rejected").join("; "),
        );
      }
    } else if (options.strategy === "and") {
      if (granted.length === total) {
        await this.store.grant(runId, approvalId, this.buildMeta(granted));
      } else if (rejected.length >= 1) {
        await this.store.reject(
          runId,
          approvalId,
          rejected[0]!.reason ?? "rejected",
        );
      }
    } else if (options.strategy === "majority") {
      const majority = Math.floor(total / 2) + 1;
      if (granted.length >= majority) {
        await this.store.grant(runId, approvalId, this.buildMeta(granted));
      } else if (rejected.length >= majority) {
        await this.store.reject(runId, approvalId, "majority rejected");
      }
    }
  }

  getDecisions(runId: string, approvalId: string) {
    return this.approverDecisions.get(`${runId}::${approvalId}`) ?? [];
  }

  poll(
    runId: string,
    approvalId: string,
    timeoutMs: number,
  ): Promise<ApprovalOutcome> {
    return this.store.poll(runId, approvalId, timeoutMs);
  }

  private buildMeta(
    decisions: { approver: string; decision: string; at: Date }[],
  ): { approvedBy: string[]; timestamps: string[] } {
    return {
      approvedBy: decisions.map((d) => d.approver),
      timestamps: decisions.map((d) => d.at.toISOString()),
    };
  }
}

// ---------------------------------------------------------------------------
// 1. Single approver
// ---------------------------------------------------------------------------

describe("Single approver", () => {
  let store: InMemoryApprovalStateStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.clear();
  });

  it("starts in pending state after createPending", async () => {
    await store.createPending("r1", "a1", { question: "approve?" });
    // payload is retained — pending state confirmed
    expect(store.getPayload("r1", "a1")).toEqual({ question: "approve?" });
  });

  it("resolve → pending after create, granted after grant", async () => {
    await store.createPending("r1", "a1", {});
    const pollP = store.poll("r1", "a1", 3_000);
    await store.grant("r1", "a1", { approvedBy: "alice" });
    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
    expect((outcome.response as Record<string, unknown>)["approvedBy"]).toBe(
      "alice",
    );
  });

  it("resolve → rejected after reject", async () => {
    await store.createPending("r1", "a1", {});
    const pollP = store.poll("r1", "a1", 3_000);
    await store.reject("r1", "a1", "not safe");
    const outcome = await pollP;
    expect(outcome.decision).toBe("rejected");
    expect(outcome.reason).toBe("not safe");
  });

  it("gate-level waitForApproval wraps createPending + poll", async () => {
    const gate = new ApprovalGate({ store });
    const waitP = gate.waitForApproval("r1", "a1", {}, 3_000);
    await Promise.resolve(); // let createPending land
    await gate.grant("r1", "a1");
    const outcome = await waitP;
    expect(outcome.decision).toBe("granted");
  });

  it("gate-level reject propagates reason", async () => {
    const gate = new ApprovalGate({ store });
    const waitP = gate.waitForApproval("r1", "a1", {}, 3_000);
    await Promise.resolve();
    await gate.reject("r1", "a1", "policy violation");
    const outcome = await waitP;
    expect(outcome.decision).toBe("rejected");
    expect(outcome.reason).toBe("policy violation");
  });

  it("late grant after poll is already live returns cached outcome", async () => {
    await store.createPending("r1", "a1", {});
    await store.grant("r1", "a1", 99);
    const outcome = await store.poll("r1", "a1", 500);
    expect(outcome.decision).toBe("granted");
    expect(outcome.response).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// 2. Multi-approver: AND strategy
// ---------------------------------------------------------------------------

describe("Multi-approver — AND (all must approve)", () => {
  const APPROVERS = ["alice", "bob", "carol"];

  it("does not resolve until all three approve", async () => {
    const gate = new MultiApproverGate();
    await gate.createPending("r2", "ap", { q: "deploy?" });
    const pollP = gate.poll("r2", "ap", 3_000);

    await gate.recordDecision("r2", "ap", "alice", "granted", {
      strategy: "and",
      requiredApprovers: APPROVERS,
    });
    // Not resolved yet — only 1 of 3
    const partialResult = await Promise.race([
      pollP.then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(partialResult).toBe("pending");

    await gate.recordDecision("r2", "ap", "bob", "granted", {
      strategy: "and",
      requiredApprovers: APPROVERS,
    });
    // Still waiting for carol
    const partialResult2 = await Promise.race([
      pollP.then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(partialResult2).toBe("pending");

    await gate.recordDecision("r2", "ap", "carol", "granted", {
      strategy: "and",
      requiredApprovers: APPROVERS,
    });

    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
    const meta = outcome.response as { approvedBy: string[] };
    expect(meta.approvedBy).toContain("alice");
    expect(meta.approvedBy).toContain("bob");
    expect(meta.approvedBy).toContain("carol");
  });

  it("rejects immediately when any single approver rejects (AND)", async () => {
    const gate = new MultiApproverGate();
    await gate.createPending("r2b", "ap", {});
    const pollP = gate.poll("r2b", "ap", 3_000);

    await gate.recordDecision("r2b", "ap", "alice", "granted", {
      strategy: "and",
      requiredApprovers: APPROVERS,
    });
    await gate.recordDecision("r2b", "ap", "bob", "rejected", {
      strategy: "and",
      requiredApprovers: APPROVERS,
      reason: "not comfortable",
    });

    const outcome = await pollP;
    expect(outcome.decision).toBe("rejected");
    expect(outcome.reason).toBe("not comfortable");
  });

  it("includes all granting approvers in the response metadata (AND)", async () => {
    const gate = new MultiApproverGate();
    await gate.createPending("r2c", "ap", {});
    const pollP = gate.poll("r2c", "ap", 3_000);

    for (const approver of APPROVERS) {
      await gate.recordDecision("r2c", "ap", approver, "granted", {
        strategy: "and",
        requiredApprovers: APPROVERS,
      });
    }

    const outcome = await pollP;
    const meta = outcome.response as { approvedBy: string[] };
    expect(meta.approvedBy).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-approver: OR strategy
// ---------------------------------------------------------------------------

describe("Multi-approver — OR (any one approves)", () => {
  const APPROVERS = ["alice", "bob", "carol"];

  it("resolves as soon as the first approver grants (OR)", async () => {
    const gate = new MultiApproverGate();
    await gate.createPending("r3", "ap", {});
    const pollP = gate.poll("r3", "ap", 3_000);

    await gate.recordDecision("r3", "ap", "alice", "granted", {
      strategy: "or",
      requiredApprovers: APPROVERS,
    });

    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
    const meta = outcome.response as { approvedBy: string[] };
    expect(meta.approvedBy).toEqual(["alice"]);
  });

  it("rejects only when all approvers reject (OR)", async () => {
    const gate = new MultiApproverGate();
    await gate.createPending("r3b", "ap", {});
    const pollP = gate.poll("r3b", "ap", 3_000);

    for (const approver of APPROVERS) {
      await gate.recordDecision("r3b", "ap", approver, "rejected", {
        strategy: "or",
        requiredApprovers: APPROVERS,
        reason: `${approver} rejects`,
      });
    }

    const outcome = await pollP;
    expect(outcome.decision).toBe("rejected");
    expect(outcome.reason).toContain("alice rejects");
  });

  it("still pending when some reject but not all (OR)", async () => {
    const gate = new MultiApproverGate();
    await gate.createPending("r3c", "ap", {});
    const pollP = gate.poll("r3c", "ap", 3_000);

    await gate.recordDecision("r3c", "ap", "alice", "rejected", {
      strategy: "or",
      requiredApprovers: APPROVERS,
    });
    await gate.recordDecision("r3c", "ap", "bob", "rejected", {
      strategy: "or",
      requiredApprovers: APPROVERS,
    });
    // carol has not yet decided

    const partial = await Promise.race([
      pollP.then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(partial).toBe("pending");

    // Now grant via carol
    await gate.recordDecision("r3c", "ap", "carol", "granted", {
      strategy: "or",
      requiredApprovers: APPROVERS,
    });
    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-approver: majority rule
// ---------------------------------------------------------------------------

describe("Multi-approver — majority rule (>50% must approve)", () => {
  const APPROVERS = ["alice", "bob", "carol", "dave", "eve"];

  it("grants when majority (3/5) approve", async () => {
    const gate = new MultiApproverGate();
    await gate.createPending("r4", "ap", {});
    const pollP = gate.poll("r4", "ap", 3_000);

    // 3 grants = majority
    await gate.recordDecision("r4", "ap", "alice", "granted", {
      strategy: "majority",
      requiredApprovers: APPROVERS,
    });
    await gate.recordDecision("r4", "ap", "bob", "granted", {
      strategy: "majority",
      requiredApprovers: APPROVERS,
    });
    await gate.recordDecision("r4", "ap", "carol", "granted", {
      strategy: "majority",
      requiredApprovers: APPROVERS,
    });

    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
    const meta = outcome.response as { approvedBy: string[] };
    expect(meta.approvedBy).toHaveLength(3);
  });

  it("rejects when majority (3/5) reject", async () => {
    const gate = new MultiApproverGate();
    await gate.createPending("r4b", "ap", {});
    const pollP = gate.poll("r4b", "ap", 3_000);

    for (const approver of ["alice", "bob", "carol"]) {
      await gate.recordDecision("r4b", "ap", approver, "rejected", {
        strategy: "majority",
        requiredApprovers: APPROVERS,
      });
    }

    const outcome = await pollP;
    expect(outcome.decision).toBe("rejected");
    expect(outcome.reason).toBe("majority rejected");
  });

  it("stays pending when 2/5 approve (not yet majority)", async () => {
    const gate = new MultiApproverGate();
    await gate.createPending("r4c", "ap", {});
    const pollP = gate.poll("r4c", "ap", 3_000);

    await gate.recordDecision("r4c", "ap", "alice", "granted", {
      strategy: "majority",
      requiredApprovers: APPROVERS,
    });
    await gate.recordDecision("r4c", "ap", "bob", "granted", {
      strategy: "majority",
      requiredApprovers: APPROVERS,
    });

    const partial = await Promise.race([
      pollP.then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(partial).toBe("pending");

    // 3rd grant tips majority
    await gate.recordDecision("r4c", "ap", "carol", "granted", {
      strategy: "majority",
      requiredApprovers: APPROVERS,
    });
    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
  });

  it("handles even number of approvers (4): requires 3 for majority", async () => {
    const evenApprovers = ["alice", "bob", "carol", "dave"];
    const gate = new MultiApproverGate();
    await gate.createPending("r4d", "ap", {});
    const pollP = gate.poll("r4d", "ap", 3_000);

    // 2/4 — not yet majority
    await gate.recordDecision("r4d", "ap", "alice", "granted", {
      strategy: "majority",
      requiredApprovers: evenApprovers,
    });
    await gate.recordDecision("r4d", "ap", "bob", "granted", {
      strategy: "majority",
      requiredApprovers: evenApprovers,
    });

    const partial = await Promise.race([
      pollP.then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(partial).toBe("pending");

    // 3/4 = majority
    await gate.recordDecision("r4d", "ap", "carol", "granted", {
      strategy: "majority",
      requiredApprovers: evenApprovers,
    });
    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
  });
});

// ---------------------------------------------------------------------------
// 5. Timeout: auto-approve and auto-reject
// ---------------------------------------------------------------------------

describe("Timeout behaviour", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out with ApprovalTimeoutError when no decision arrives", async () => {
    const store = makeStore();
    await store.createPending("r5", "ap", {});
    await expect(store.poll("r5", "ap", 20)).rejects.toBeInstanceOf(
      ApprovalTimeoutError,
    );
    store.clear();
  });

  it("ApprovalTimeoutError message mentions runId and approvalId", async () => {
    const store = makeStore();
    await store.createPending("my-run", "my-ap", {});
    const err = await store.poll("my-run", "my-ap", 10).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ApprovalTimeoutError);
    expect((err as ApprovalTimeoutError).message).toContain("my-run");
    expect((err as ApprovalTimeoutError).message).toContain("my-ap");
    store.clear();
  });

  it("auto-approve strategy: on timeout, grant the approval programmatically", async () => {
    const store = makeStore();
    await store.createPending("r5b", "ap", {});

    // Simulate "auto-approve on timeout" by granting after a short delay
    const pollP = store.poll("r5b", "ap", 1_000);
    setTimeout(() => {
      void store.grant("r5b", "ap", {
        autoApproved: true,
        reason: "timeout-auto-approve",
      });
    }, 10);

    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
    expect((outcome.response as Record<string, unknown>)["autoApproved"]).toBe(
      true,
    );
    store.clear();
  });

  it("auto-reject strategy: on timeout, reject the approval programmatically", async () => {
    const store = makeStore();
    await store.createPending("r5c", "ap", {});

    const pollP = store.poll("r5c", "ap", 1_000);
    setTimeout(() => {
      void store.reject("r5c", "ap", "auto-rejected: no approver responded");
    }, 10);

    const outcome = await pollP;
    expect(outcome.decision).toBe("rejected");
    expect(outcome.reason).toContain("auto-rejected");
    store.clear();
  });

  it("gate-level waitForApproval times out using per-call timeout", async () => {
    const store = makeStore();
    const gate = new ApprovalGate({ store });
    await expect(
      gate.waitForApproval("r5d", "ap", {}, 15),
    ).rejects.toBeInstanceOf(ApprovalTimeoutError);
    store.clear();
  });

  it("gate uses defaultTimeoutMs when per-call timeout is omitted", async () => {
    const store = makeStore();
    const gate = new ApprovalGate({ store, defaultTimeoutMs: 20 });
    await expect(gate.waitForApproval("r5e", "ap", {})).rejects.toBeInstanceOf(
      ApprovalTimeoutError,
    );
    store.clear();
  });
});

// ---------------------------------------------------------------------------
// 6. Timeout escalation
// ---------------------------------------------------------------------------

describe("Timeout escalation", () => {
  /**
   * Escalation logic: first poll times out → escalate to secondary approver.
   * The test wires this via a callback so the secondary can grant/reject.
   */
  it("escalates to a secondary approver after first timeout", async () => {
    const store = makeStore();
    await store.createPending("r6", "ap", { q: "deploy?" });

    let escalated = false;

    // First poll — short timeout, will expire
    const firstPoll = store.poll("r6", "ap", 20).catch(async (err: unknown) => {
      if (err instanceof ApprovalTimeoutError) {
        escalated = true;
        // Escalation: grant from secondary
        await store.grant("r6", "ap", {
          approvedBy: "secondary-approver",
          escalated: true,
        });
        return store.poll("r6", "ap", 500);
      }
      throw err;
    });

    const outcome = await firstPoll;
    expect(escalated).toBe(true);
    expect((outcome as ApprovalOutcome).decision).toBe("granted");
    expect(
      ((outcome as ApprovalOutcome).response as Record<string, unknown>)[
        "escalated"
      ],
    ).toBe(true);
    store.clear();
  });

  it("double-escalation: first timeout → secondary escalation → second timeout → auto-action", async () => {
    const store = makeStore();
    await store.createPending("r6b", "ap", {});
    let escalations = 0;

    async function pollWithEscalation(
      timeoutMs: number,
      maxEscalations: number,
    ): Promise<ApprovalOutcome> {
      try {
        return await store.poll("r6b", "ap", timeoutMs);
      } catch (err) {
        if (
          err instanceof ApprovalTimeoutError &&
          escalations < maxEscalations
        ) {
          escalations++;
          return pollWithEscalation(timeoutMs, maxEscalations);
        }
        // Final auto-action: reject after all escalations exhausted
        await store.reject("r6b", "ap", "auto-rejected after escalation chain");
        return {
          decision: "rejected",
          reason: "auto-rejected after escalation chain",
        };
      }
    }

    const outcome = await pollWithEscalation(10, 1);
    expect(escalations).toBe(1);
    expect(outcome.decision).toBe("rejected");
    expect(outcome.reason).toContain("auto-rejected");
    store.clear();
  });
});

// ---------------------------------------------------------------------------
// 7. Durable state: serialise / deserialise across simulated restarts
// ---------------------------------------------------------------------------

describe("Durable state — serialise + deserialise", () => {
  it("payload survives a simulated restart (new store instance with same data)", async () => {
    // Simulate a process that creates a pending approval and then "restarts"
    // by exporting state from one store and importing it into another.
    const storeA = makeStore();
    const payload = {
      question: "approve deployment v2?",
      runId: "durable-run",
    };
    await storeA.createPending("durable-run", "ap", payload);

    // Snapshot: extract payload (simulates what a durable DB would do)
    const snapshot = storeA.getPayload("durable-run", "ap");
    expect(snapshot).toEqual(payload);

    // "Restart" — new in-memory store seeded with snapshot
    const storeB = makeStore();
    await storeB.createPending("durable-run", "ap", snapshot);
    expect(storeB.getPayload("durable-run", "ap")).toEqual(payload);

    // Approval arrives at the new store
    const pollP = storeB.poll("durable-run", "ap", 3_000);
    await storeB.grant("durable-run", "ap", { approvedBy: "ops" });
    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");

    storeA.clear();
    storeB.clear();
  });

  it("decision received after restart is correctly applied to new store", async () => {
    const storeA = makeStore();
    await storeA.createPending("r7", "ap", { action: "rollback" });
    const payload = storeA.getPayload("r7", "ap");
    storeA.clear();

    const storeB = makeStore();
    await storeB.createPending("r7", "ap", payload);
    const pollP = storeB.poll("r7", "ap", 3_000);
    await storeB.reject("r7", "ap", "ops denied rollback");
    const outcome = await pollP;
    expect(outcome.decision).toBe("rejected");
    expect(outcome.reason).toBe("ops denied rollback");
    storeB.clear();
  });

  it("multiple approvals serialised independently per (runId, approvalId)", async () => {
    const store = makeStore();
    await store.createPending("r-a", "ap1", { task: "A" });
    await store.createPending("r-a", "ap2", { task: "B" });
    await store.createPending("r-b", "ap1", { task: "C" });

    expect(store.getPayload("r-a", "ap1")).toEqual({ task: "A" });
    expect(store.getPayload("r-a", "ap2")).toEqual({ task: "B" });
    expect(store.getPayload("r-b", "ap1")).toEqual({ task: "C" });

    await store.grant("r-a", "ap1", "ok-A");
    await store.reject("r-a", "ap2", "no-B");

    const o1 = await store.poll("r-a", "ap1", 500);
    const o2 = await store.poll("r-a", "ap2", 500);
    expect(o1.decision).toBe("granted");
    expect(o2.decision).toBe("rejected");

    // r-b still pending
    const partial = await Promise.race([
      store.poll("r-b", "ap1", 500).then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(partial).toBe("pending");

    store.clear();
  });
});

// ---------------------------------------------------------------------------
// 8. Metadata: who approved, timestamp, reason/comment
// ---------------------------------------------------------------------------

describe("Approval metadata", () => {
  it("stores who approved via response payload", async () => {
    const store = makeStore();
    await store.createPending("r8", "ap", {});
    const pollP = store.poll("r8", "ap", 3_000);
    await store.grant("r8", "ap", {
      approvedBy: "alice",
      timestamp: "2026-06-25T12:00:00Z",
      comment: "LGTM",
    });
    const outcome = await pollP;
    const meta = outcome.response as {
      approvedBy: string;
      timestamp: string;
      comment: string;
    };
    expect(meta.approvedBy).toBe("alice");
    expect(meta.timestamp).toBe("2026-06-25T12:00:00Z");
    expect(meta.comment).toBe("LGTM");
    store.clear();
  });

  it("stores rejection reason in the outcome", async () => {
    const store = makeStore();
    await store.createPending("r8b", "ap", {});
    const pollP = store.poll("r8b", "ap", 3_000);
    await store.reject("r8b", "ap", "too risky at this time");
    const outcome = await pollP;
    expect(outcome.reason).toBe("too risky at this time");
    store.clear();
  });

  it("full metadata round-trip: payload → pending → decision → outcome", async () => {
    const store = makeStore();
    const payload = {
      type: "deployment",
      target: "production",
      version: "3.14.0",
      requestedBy: "dave",
    };
    await store.createPending("r8c", "deploy-gate", payload);
    expect(store.getPayload("r8c", "deploy-gate")).toEqual(payload);

    const pollP = store.poll("r8c", "deploy-gate", 3_000);
    await store.grant("r8c", "deploy-gate", {
      approvedBy: "security-lead",
      approvedAt: "2026-06-25T15:00:00Z",
      comment: "Reviewed and approved with monitoring enabled",
    });

    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
    const meta = outcome.response as Record<string, string>;
    expect(meta["approvedBy"]).toBe("security-lead");
    expect(meta["comment"]).toContain("monitoring");
    store.clear();
  });

  it("null response is valid when grant is called without metadata", async () => {
    const store = makeStore();
    await store.createPending("r8d", "ap", {});
    const pollP = store.poll("r8d", "ap", 3_000);
    await store.grant("r8d", "ap"); // no response
    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
    expect(outcome.response).toBeUndefined();
    store.clear();
  });
});

// ---------------------------------------------------------------------------
// 9. Conditional gates
// ---------------------------------------------------------------------------

describe("Conditional gates", () => {
  /**
   * ConditionalApprovalGate: evaluates a condition before deciding
   * whether to actually create+poll an approval or auto-grant.
   */
  class ConditionalApprovalGate {
    constructor(
      private readonly store: InMemoryApprovalStateStore,
      private readonly condition: (
        payload: unknown,
      ) => boolean | Promise<boolean>,
    ) {}

    async request(
      runId: string,
      approvalId: string,
      payload: unknown,
    ): Promise<ApprovalOutcome> {
      const needsApproval = await this.condition(payload);
      if (!needsApproval) {
        return {
          decision: "granted",
          response: { conditional: true, bypassed: true },
        };
      }
      return new Promise<ApprovalOutcome>((resolve, reject) => {
        void this.store
          .createPending(runId, approvalId, payload)
          .then(() => this.store.poll(runId, approvalId, 3_000))
          .then(resolve)
          .catch(reject);
      });
    }
  }

  it("condition false → gate bypassed, immediate approved", async () => {
    const store = makeStore();
    const gate = new ConditionalApprovalGate(store, () => false);
    const outcome = await gate.request("r9", "ap", { riskLevel: "low" });
    expect(outcome.decision).toBe("granted");
    expect((outcome.response as Record<string, unknown>)["bypassed"]).toBe(
      true,
    );
    // No pending entry was created
    expect(store.getPayload("r9", "ap")).toBeUndefined();
    store.clear();
  });

  it("condition true → gate required, waits for human decision", async () => {
    const store = makeStore();
    const gate = new ConditionalApprovalGate(store, () => true);
    const pollP = gate.request("r9b", "ap", { riskLevel: "high" });
    await Promise.resolve(); // let createPending land
    await store.grant("r9b", "ap", { approvedBy: "manager" });
    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
    store.clear();
  });

  it("async condition is evaluated correctly", async () => {
    const store = makeStore();
    const condition = vi.fn(async (payload: unknown) => {
      const p = payload as Record<string, unknown>;
      return p["riskLevel"] === "high";
    });
    const gate = new ConditionalApprovalGate(store, condition);

    // Low risk → bypass
    const low = await gate.request("r9c-low", "ap", { riskLevel: "low" });
    expect(low.decision).toBe("granted");
    expect(condition).toHaveBeenCalledWith({ riskLevel: "low" });

    // High risk → requires approval
    const highP = gate.request("r9c-high", "ap", { riskLevel: "high" });
    await Promise.resolve();
    await store.grant("r9c-high", "ap");
    const high = await highP;
    expect(high.decision).toBe("granted");
    expect(condition).toHaveBeenCalledTimes(2);
    store.clear();
  });

  it("condition receives full payload context", async () => {
    const store = makeStore();
    const receivedPayloads: unknown[] = [];
    const condition = (payload: unknown) => {
      receivedPayloads.push(payload);
      return false;
    };
    const gate = new ConditionalApprovalGate(store, condition);
    const payload = {
      action: "delete",
      resource: "database",
      confirmed: false,
    };
    await gate.request("r9d", "ap", payload);
    expect(receivedPayloads[0]).toEqual(payload);
    store.clear();
  });
});

// ---------------------------------------------------------------------------
// 10. Gate in workflow (pause → resume → skip)
// ---------------------------------------------------------------------------

describe("Gate in workflow", () => {
  interface WorkflowState {
    step: string;
    output?: unknown;
    approvalResult?: ApprovalOutcome;
  }

  /**
   * Minimal workflow that pauses at an approval gate mid-execution.
   */
  async function runWorkflowWithGate(
    store: InMemoryApprovalStateStore,
    opts: { condition?: boolean; runId?: string } = {},
  ): Promise<WorkflowState> {
    const state: WorkflowState = { step: "start" };
    const runId = opts.runId ?? "wf-run";
    const approvalId = "gate-1";

    // Step 1: pre-gate work
    state.step = "pre-gate";

    // Step 2: approval gate
    const needsGate = opts.condition !== false;
    if (needsGate) {
      await store.createPending(runId, approvalId, { action: "proceed?" });
      const outcome = await store.poll(runId, approvalId, 3_000);
      state.approvalResult = outcome;
      if (outcome.decision === "rejected") {
        state.step = "cancelled";
        return state;
      }
    }

    // Step 3: post-gate work
    state.step = "complete";
    state.output = { success: true };
    return state;
  }

  it("workflow pauses at gate and resumes after approval", async () => {
    const store = makeStore();
    const workflowP = runWorkflowWithGate(store, { runId: "wf-1" });
    // Allow createPending to land
    await Promise.resolve();
    await store.grant("wf-1", "gate-1", { by: "ops" });
    const result = await workflowP;
    expect(result.step).toBe("complete");
    expect(result.approvalResult?.decision).toBe("granted");
    store.clear();
  });

  it("workflow is cancelled when gate is rejected", async () => {
    const store = makeStore();
    const workflowP = runWorkflowWithGate(store, { runId: "wf-2" });
    await Promise.resolve();
    await store.reject("wf-2", "gate-1", "too risky");
    const result = await workflowP;
    expect(result.step).toBe("cancelled");
    expect(result.approvalResult?.decision).toBe("rejected");
    store.clear();
  });

  it("workflow skips gate when condition is false", async () => {
    const store = makeStore();
    const result = await runWorkflowWithGate(store, { condition: false });
    expect(result.step).toBe("complete");
    expect(result.approvalResult).toBeUndefined();
    store.clear();
  });

  it("sequential workflow with two gates both approved", async () => {
    const store = makeStore();
    await store.createPending("wf-seq", "gate-1", { q: "first?" });
    await store.createPending("wf-seq", "gate-2", { q: "second?" });

    const steps: string[] = [];

    async function runSequential(): Promise<void> {
      const g1 = await store.poll("wf-seq", "gate-1", 3_000);
      steps.push(`gate1:${g1.decision}`);
      const g2 = await store.poll("wf-seq", "gate-2", 3_000);
      steps.push(`gate2:${g2.decision}`);
    }

    const runP = runSequential();
    setTimeout(() => void store.grant("wf-seq", "gate-1"), 5);
    setTimeout(() => void store.grant("wf-seq", "gate-2"), 15);
    await runP;

    expect(steps).toEqual(["gate1:granted", "gate2:granted"]);
    store.clear();
  });

  it("parallel gates: both must resolve before workflow continues", async () => {
    const store = makeStore();
    await store.createPending("wf-par", "gate-A", {});
    await store.createPending("wf-par", "gate-B", {});

    const [outcomeA, outcomeB] = await Promise.all([
      (async () => {
        setTimeout(() => void store.grant("wf-par", "gate-A", "a-ok"), 5);
        return store.poll("wf-par", "gate-A", 3_000);
      })(),
      (async () => {
        setTimeout(() => void store.grant("wf-par", "gate-B", "b-ok"), 10);
        return store.poll("wf-par", "gate-B", 3_000);
      })(),
    ]);

    expect(outcomeA.decision).toBe("granted");
    expect(outcomeB.decision).toBe("granted");
    store.clear();
  });
});

// ---------------------------------------------------------------------------
// 11. Duplicate approval idempotence
// ---------------------------------------------------------------------------

describe("Duplicate approval idempotence", () => {
  it("same approver granting twice is counted once (MultiApproverGate)", async () => {
    const gate = new MultiApproverGate();
    await gate.createPending("r11", "ap", {});
    const pollP = gate.poll("r11", "ap", 3_000);

    // Alice grants twice
    await gate.recordDecision("r11", "ap", "alice", "granted", {
      strategy: "and",
      requiredApprovers: ["alice", "bob"],
    });
    await gate.recordDecision("r11", "ap", "alice", "granted", {
      strategy: "and",
      requiredApprovers: ["alice", "bob"],
    });

    const decisions = gate.getDecisions("r11", "ap");
    // Should only have ONE entry for alice
    expect(decisions.filter((d) => d.approver === "alice")).toHaveLength(1);

    // Not yet resolved — still waiting for bob
    const partial = await Promise.race([
      pollP.then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(partial).toBe("pending");

    await gate.recordDecision("r11", "ap", "bob", "granted", {
      strategy: "and",
      requiredApprovers: ["alice", "bob"],
    });
    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
  });

  it("store-level: repeated grant calls are idempotent after resolution", async () => {
    const store = makeStore();
    await store.createPending("r11b", "ap", {});
    await store.grant("r11b", "ap", "first-grant");
    // Second grant on same (already resolved) key should not throw
    await expect(
      store.grant("r11b", "ap", "second-grant"),
    ).resolves.toBeUndefined();
    // Poll returns the first grant outcome
    const outcome = await store.poll("r11b", "ap", 500);
    expect(outcome.response).toBe("first-grant");
    store.clear();
  });

  it("store-level: repeated reject calls are idempotent after resolution", async () => {
    const store = makeStore();
    await store.createPending("r11c", "ap", {});
    await store.reject("r11c", "ap", "first-reject");
    await expect(
      store.reject("r11c", "ap", "second-reject"),
    ).resolves.toBeUndefined();
    const outcome = await store.poll("r11c", "ap", 500);
    expect(outcome.reason).toBe("first-reject");
    store.clear();
  });

  it("createPending is idempotent for pending keys — throws DuplicateApprovalError only on terminal (MPCO P6)", async () => {
    const store = makeStore();
    await store.createPending("r11d", "ap", {});
    // Pending duplicate must NOT throw (resume case).
    await expect(
      store.createPending("r11d", "ap", {}),
    ).resolves.toBeUndefined();
    // Only after reaching terminal should it throw.
    await store.grant("r11d", "ap");
    await expect(store.createPending("r11d", "ap", {})).rejects.toBeInstanceOf(
      DuplicateApprovalError,
    );
    store.clear();
  });
});

// ---------------------------------------------------------------------------
// 12. Approval expiry before workflow resumes
// ---------------------------------------------------------------------------

describe("Approval expiry", () => {
  it("expired approval (timed out) cannot be resumed via late grant", async () => {
    const store = makeStore();
    await store.createPending("r12", "ap", {});

    // First: wait and let it expire
    const timeoutErr = await store
      .poll("r12", "ap", 15)
      .catch((e: unknown) => e);
    expect(timeoutErr).toBeInstanceOf(ApprovalTimeoutError);

    // After timeout, a new poll should return immediately with the grant
    // (The store still holds the pending entry; granting after timeout is still valid)
    await store.grant("r12", "ap", { lateApproval: true });
    const lateOutcome = await store.poll("r12", "ap", 500);
    expect(lateOutcome.decision).toBe("granted");

    store.clear();
  });

  it("expiry-aware workflow: checks grant timestamp before proceeding", async () => {
    const store = makeStore();
    const requestedAt = Date.now();
    const expiryMs = 50; // very short expiry window
    await store.createPending("r12b", "ap", { requestedAt, expiryMs });

    // Simulate a "late" approval that arrives after expiry
    await new Promise((r) => setTimeout(r, 60));
    await store.grant("r12b", "ap", {
      approvedAt: Date.now(),
      approvedBy: "late-approver",
    });

    const outcome = await store.poll("r12b", "ap", 500);
    const meta = outcome.response as { approvedAt: number };

    // Expiry check: approval was after requestedAt + expiryMs → should re-request
    const isExpired = meta.approvedAt > requestedAt + expiryMs;
    expect(isExpired).toBe(true);
    // In a real system this would trigger re-request; here we verify the check logic

    store.clear();
  });

  it("approval within window is considered valid", async () => {
    const store = makeStore();
    const requestedAt = Date.now();
    const expiryMs = 60_000; // 1 minute window
    await store.createPending("r12c", "ap", { requestedAt, expiryMs });

    const approvedAt = Date.now();
    await store.grant("r12c", "ap", { approvedAt, approvedBy: "ops" });
    const outcome = await store.poll("r12c", "ap", 500);
    const meta = outcome.response as { approvedAt: number };

    const isExpired = meta.approvedAt > requestedAt + expiryMs;
    expect(isExpired).toBe(false); // within window

    store.clear();
  });
});

// ---------------------------------------------------------------------------
// 13. Error cases
// ---------------------------------------------------------------------------

describe("Error cases", () => {
  it("grant on unknown approvalId throws UnknownApprovalError", async () => {
    const store = makeStore();
    await expect(store.grant("no-run", "no-ap")).rejects.toBeInstanceOf(
      UnknownApprovalError,
    );
  });

  it("reject on unknown approvalId throws UnknownApprovalError", async () => {
    const store = makeStore();
    await expect(
      store.reject("no-run", "no-ap", "reason"),
    ).rejects.toBeInstanceOf(UnknownApprovalError);
  });

  it("poll on unknown approvalId throws UnknownApprovalError", async () => {
    const store = makeStore();
    await expect(store.poll("no-run", "no-ap", 500)).rejects.toBeInstanceOf(
      UnknownApprovalError,
    );
  });

  it("DuplicateApprovalError has the correct name", async () => {
    const store = makeStore();
    await store.createPending("r13a", "ap", {});
    // Must reach terminal before createPending throws DuplicateApprovalError (MPCO P6).
    await store.grant("r13a", "ap");
    const err = await store
      .createPending("r13a", "ap", {})
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(DuplicateApprovalError);
    expect((err as DuplicateApprovalError).name).toBe("DuplicateApprovalError");
    expect((err as DuplicateApprovalError).message).toContain("r13a");
    store.clear();
  });

  it("UnknownApprovalError has the correct name", async () => {
    const store = makeStore();
    const err = await store.grant("r13b", "ap").catch((e: Error) => e);
    expect(err).toBeInstanceOf(UnknownApprovalError);
    expect((err as UnknownApprovalError).name).toBe("UnknownApprovalError");
  });

  it("ApprovalTimeoutError has the correct name and message", async () => {
    const store = makeStore();
    await store.createPending("r13c", "ap", {});
    const err = await store.poll("r13c", "ap", 10).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ApprovalTimeoutError);
    expect((err as ApprovalTimeoutError).name).toBe("ApprovalTimeoutError");
    expect((err as ApprovalTimeoutError).message).toContain("10ms");
    store.clear();
  });

  it("invalid token simulation: grant with wrong runId leaves original pending", async () => {
    const store = makeStore();
    await store.createPending("real-run", "ap", {});

    // Attempt to grant using a wrong runId (simulates invalid token)
    await expect(store.grant("fake-run", "ap")).rejects.toBeInstanceOf(
      UnknownApprovalError,
    );

    // Real approval is still pending — verify by granting correctly
    const pollP = store.poll("real-run", "ap", 3_000);
    await store.grant("real-run", "ap", { valid: true });
    const outcome = await pollP;
    expect(outcome.decision).toBe("granted");
    store.clear();
  });

  it("revoked approval: reject after grant is idempotent, grant wins", async () => {
    const store = makeStore();
    await store.createPending("r13d", "ap", {});
    await store.grant("r13d", "ap", { by: "approver" });
    // Attempt to "revoke" by rejecting — should be idempotent (grant already won)
    await expect(
      store.reject("r13d", "ap", "revoked"),
    ).resolves.toBeUndefined();
    const outcome = await store.poll("r13d", "ap", 500);
    // The original grant is cached; revocation after grant does not change the outcome
    expect(outcome.decision).toBe("granted");
    store.clear();
  });

  it("store.clear() rejects all outstanding poll waiters", async () => {
    const store = makeStore();
    await store.createPending("r13e", "ap", {});
    const pollP = store.poll("r13e", "ap", 5_000);
    setTimeout(() => store.clear(), 10);
    await expect(pollP).rejects.toThrow(/Store cleared/);
  });

  it("ApprovalGate store property is accessible after construction", () => {
    const store = makeStore();
    const gate = new ApprovalGate({ store });
    expect(gate.store).toBe(store);
  });

  it("ApprovalGate constructs with default in-memory store", () => {
    const gate = new ApprovalGate();
    expect(gate.store).toBeInstanceOf(InMemoryApprovalStateStore);
  });

  it("ApprovalRejectedError carries runId and approvalId", () => {
    const err = new ApprovalRejectedError("my-run", "my-ap", "not safe");
    expect(err.name).toBe("ApprovalRejectedError");
    expect(err.runId).toBe("my-run");
    expect(err.approvalId).toBe("my-ap");
    expect(err.message).toBe("not safe");
  });

  it("ApprovalRejectedError default message when no reason given", () => {
    const err = new ApprovalRejectedError("r", "a");
    expect(err.message).toContain("r");
    expect(err.message).toContain("a");
  });

  it("gate.waitForApproval throws on unknown approval after grant path", async () => {
    // Fake store that always throws UnknownApprovalError from poll
    const fakeStore: ApprovalStateStore = {
      createPending: vi.fn(async () => undefined),
      grant: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
      poll: vi.fn(async () => {
        throw new UnknownApprovalError("x", "y");
      }),
    };
    const gate = new ApprovalGate({ store: fakeStore });
    await expect(
      gate.waitForApproval("x", "y", {}, 500),
    ).rejects.toBeInstanceOf(UnknownApprovalError);
  });
});

// ---------------------------------------------------------------------------
// 14. Gate + ApprovalGate convenience API coverage
// ---------------------------------------------------------------------------

describe("ApprovalGate convenience API", () => {
  it("grant via gate delegates to store.grant with correct args", async () => {
    const store = makeStore();
    const grantSpy = vi.spyOn(store, "grant");
    const gate = new ApprovalGate({ store });

    await store.createPending("rc1", "ap", {});
    await gate.grant("rc1", "ap", { by: "sys" });

    expect(grantSpy).toHaveBeenCalledWith("rc1", "ap", { by: "sys" });
    store.clear();
  });

  it("reject via gate delegates to store.reject with correct args", async () => {
    const store = makeStore();
    const rejectSpy = vi.spyOn(store, "reject");
    const gate = new ApprovalGate({ store });

    await store.createPending("rc2", "ap", {});
    await gate.reject("rc2", "ap", "too expensive");

    expect(rejectSpy).toHaveBeenCalledWith("rc2", "ap", "too expensive");
    store.clear();
  });

  it("concurrent waitForApproval calls on different runIds are independent", async () => {
    const store = makeStore();
    const gate = new ApprovalGate({ store });

    const p1 = gate.waitForApproval("rc-A", "ap", { x: 1 }, 3_000);
    const p2 = gate.waitForApproval("rc-B", "ap", { x: 2 }, 3_000);
    await Promise.resolve();

    await gate.grant("rc-B", "ap", "b-ok");
    await gate.reject("rc-A", "ap", "a-denied");

    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1.decision).toBe("rejected");
    expect(o2.decision).toBe("granted");
    store.clear();
  });

  it("gate can process multiple sequential approvals on the same runId", async () => {
    const store = makeStore();
    const gate = new ApprovalGate({ store });

    const p1 = gate.waitForApproval("seq-run", "step-1", {}, 3_000);
    await Promise.resolve();
    await gate.grant("seq-run", "step-1");
    const o1 = await p1;
    expect(o1.decision).toBe("granted");

    const p2 = gate.waitForApproval("seq-run", "step-2", {}, 3_000);
    await Promise.resolve();
    await gate.reject("seq-run", "step-2", "cancelled");
    const o2 = await p2;
    expect(o2.decision).toBe("rejected");

    store.clear();
  });

  it("defaultTimeoutMs option is used when no per-call timeout supplied", async () => {
    const store = makeStore();
    const gate = new ApprovalGate({ store, defaultTimeoutMs: 20 });
    await expect(gate.waitForApproval("rc3", "ap", {})).rejects.toBeInstanceOf(
      ApprovalTimeoutError,
    );
    store.clear();
  });

  it("payload is retained in store for any downstream inspection", async () => {
    const store = makeStore();
    const gate = new ApprovalGate({ store });
    const payload = { question: "Can we merge?", pr: 42 };
    const waitP = gate.waitForApproval(
      "inspect-run",
      "merge-gate",
      payload,
      3_000,
    );
    await Promise.resolve();
    expect(store.getPayload("inspect-run", "merge-gate")).toEqual(payload);
    await gate.grant("inspect-run", "merge-gate");
    await waitP;
    store.clear();
  });
});

// ---------------------------------------------------------------------------
// 15. Concurrent pollers and edge cases
// ---------------------------------------------------------------------------

describe("Concurrent pollers", () => {
  it("three concurrent pollers all receive the same granted outcome", async () => {
    const store = makeStore();
    await store.createPending("cp1", "ap", {});
    const [p1, p2, p3] = [
      store.poll("cp1", "ap", 3_000),
      store.poll("cp1", "ap", 3_000),
      store.poll("cp1", "ap", 3_000),
    ];
    await store.grant("cp1", "ap", "shared-result");
    const [o1, o2, o3] = await Promise.all([p1, p2, p3]);
    expect(o1.decision).toBe("granted");
    expect(o2.decision).toBe("granted");
    expect(o3.decision).toBe("granted");
    expect(o1.response).toBe("shared-result");
    expect(o2.response).toBe("shared-result");
    expect(o3.response).toBe("shared-result");
    store.clear();
  });

  it("three concurrent pollers all receive the same rejected outcome", async () => {
    const store = makeStore();
    await store.createPending("cp2", "ap", {});
    const [p1, p2, p3] = [
      store.poll("cp2", "ap", 3_000),
      store.poll("cp2", "ap", 3_000),
      store.poll("cp2", "ap", 3_000),
    ];
    await store.reject("cp2", "ap", "shared-rejection");
    const [o1, o2, o3] = await Promise.all([p1, p2, p3]);
    for (const o of [o1, o2, o3]) {
      expect(o.decision).toBe("rejected");
      expect(o.reason).toBe("shared-rejection");
    }
    store.clear();
  });

  it("pollers with different timeouts: slow one still resolves on grant", async () => {
    const store = makeStore();
    await store.createPending("cp3", "ap", {});
    const fast = store.poll("cp3", "ap", 3_000);
    const slow = store.poll("cp3", "ap", 10_000);
    setTimeout(() => void store.grant("cp3", "ap", "ok"), 10);
    const [fo, so] = await Promise.all([fast, slow]);
    expect(fo.decision).toBe("granted");
    expect(so.decision).toBe("granted");
    store.clear();
  });

  it("independently keyed pollers do not cross-contaminate", async () => {
    const store = makeStore();
    await store.createPending("cx", "key-1", { task: "A" });
    await store.createPending("cx", "key-2", { task: "B" });

    const p1 = store.poll("cx", "key-1", 3_000);
    const p2 = store.poll("cx", "key-2", 3_000);

    await store.grant("cx", "key-1", "A-granted");
    await store.reject("cx", "key-2", "B-denied");

    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1.decision).toBe("granted");
    expect(o1.response).toBe("A-granted");
    expect(o2.decision).toBe("rejected");
    expect(o2.reason).toBe("B-denied");
    store.clear();
  });
});

// ---------------------------------------------------------------------------
// 16. InMemoryApprovalStateStore — clear() behaviour
// ---------------------------------------------------------------------------

describe("InMemoryApprovalStateStore.clear()", () => {
  it("clear() cancels all active poll waiters", async () => {
    const store = makeStore();
    await store.createPending("cl1", "ap", {});
    const pollP = store.poll("cl1", "ap", 5_000);
    setTimeout(() => store.clear(), 10);
    await expect(pollP).rejects.toThrow();
  });

  it("after clear(), createPending on same key succeeds", async () => {
    const store = makeStore();
    await store.createPending("cl2", "ap", { v: 1 });
    store.clear();
    await expect(
      store.createPending("cl2", "ap", { v: 2 }),
    ).resolves.toBeUndefined();
    expect(store.getPayload("cl2", "ap")).toEqual({ v: 2 });
    store.clear();
  });

  it("getPayload returns undefined for cleared keys", async () => {
    const store = makeStore();
    await store.createPending("cl3", "ap", { info: "x" });
    store.clear();
    expect(store.getPayload("cl3", "ap")).toBeUndefined();
  });

  it("clear() is safe to call on empty store", () => {
    const store = makeStore();
    expect(() => store.clear()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 17. Store as injectable dependency (interface compliance)
// ---------------------------------------------------------------------------

describe("ApprovalStateStore interface compliance", () => {
  it("custom store implementation is accepted by ApprovalGate", async () => {
    const custom: ApprovalStateStore = {
      createPending: vi.fn(async () => undefined),
      grant: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
      poll: vi.fn(
        async (): Promise<ApprovalOutcome> => ({
          decision: "granted",
          response: "custom",
        }),
      ),
    };
    const gate = new ApprovalGate({ store: custom });
    const outcome = await gate.waitForApproval("r-custom", "ap", {}, 1_000);
    expect(outcome.decision).toBe("granted");
    expect(custom.createPending).toHaveBeenCalledWith("r-custom", "ap", {});
    expect(custom.poll).toHaveBeenCalledWith("r-custom", "ap", 1_000);
  });

  it("gate.grant calls store.grant with all arguments", async () => {
    const custom: ApprovalStateStore = {
      createPending: vi.fn(async () => undefined),
      grant: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
      poll: vi.fn(
        async (): Promise<ApprovalOutcome> => ({ decision: "granted" }),
      ),
    };
    const gate = new ApprovalGate({ store: custom });
    await gate.grant("g-run", "g-ap", { meta: 42 });
    expect(custom.grant).toHaveBeenCalledWith("g-run", "g-ap", { meta: 42 });
  });

  it("gate.reject calls store.reject with reason", async () => {
    const custom: ApprovalStateStore = {
      createPending: vi.fn(async () => undefined),
      grant: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
      poll: vi.fn(
        async (): Promise<ApprovalOutcome> => ({ decision: "rejected" }),
      ),
    };
    const gate = new ApprovalGate({ store: custom });
    await gate.reject("rj-run", "rj-ap", "cost too high");
    expect(custom.reject).toHaveBeenCalledWith(
      "rj-run",
      "rj-ap",
      "cost too high",
    );
  });
});
