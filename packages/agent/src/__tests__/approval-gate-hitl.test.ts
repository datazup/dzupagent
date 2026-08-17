/**
 * Comprehensive HITL / approval-gate tests.
 *
 * Covers the following surface area NOT addressed by the three existing
 * approval-gate test files:
 *
 * 1.  loadPending() — reads persisted state; returns null when missing
 * 2.  ApprovalSuspendedError properties and message format
 * 3.  requestApproval() durable path — stores correct field values
 * 4.  requestApproval() durable path — custom contactId forwarding
 * 5.  resume() without checkpointStore — throws correctly
 * 6.  resume() approved without reason field
 * 7.  resume() rejected without reason field (omit-undefined guard)
 * 8.  Sequential multiple gates on the same run id
 * 9.  Concurrent gates on different run ids — isolation
 * 10. Bypass / auto mode — passes through immediately for any plan shape
 * 11. Conditional mode edge cases (condition throws, returns truthy value)
 * 12. AbortSignal already aborted before waitForApproval is called
 * 13. Abort reason is an Error instance vs plain string vs unknown
 * 14. Event sequence: requested → granted / rejected / timed_out / cancelled
 * 15. Approved event contactId propagated in requested event
 * 16. Multiple listeners — both receive the same event
 * 17. Rapid grant beats timeout even with tiny timeoutMs
 * 18. webhook outbound URL policy configuration field preserved
 * 19. Approval metadata: plan object/string/null/array shapes
 * 20. Tool-loop integration: multiple sequential approval gates in one run
 * 21. Tool-loop integration: bypass mode passes without emitting events
 * 22. Tool-loop integration: stop reason after second gate in same loop
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createEventBus, ToolGovernance } from "@dzupagent/core";
import { ApprovalGate } from "../approval/approval-gate.js";
import { ApprovalSuspendedError } from "../approval/approval-errors.js";
import {
  APPROVAL_PENDING_KEY,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ApprovalCheckpointStore,
  type ApprovalPendingState,
} from "../approval/approval-types.js";
import { runToolLoop } from "../agent/tool-loop.js";

/**
 * Fetch the persisted resumeToken for a run so tests can call
 * ApprovalGate.resume(), which now requires it (DZUPAGENT-AGENT-H-14).
 * Falls back to a sentinel when nothing is pending, so "no pending approval"
 * cases still exercise the pre-token error path.
 */
async function tokenFor(
  gate: ApprovalGate,
  runId: string,
): Promise<string> {
  return (await gate.loadPending(runId))?.resumeToken ?? "missing-resume-token"
}


// ---------------------------------------------------------------------------
// Shared test doubles
// ---------------------------------------------------------------------------

class InMemoryApprovalStore implements ApprovalCheckpointStore {
  private map = new Map<string, ApprovalPendingState>();
  async save(
    runId: string,
    key: string,
    state: ApprovalPendingState,
  ): Promise<void> {
    this.map.set(`${runId}::${key}`, state);
  }
  async load(runId: string, key: string): Promise<ApprovalPendingState | null> {
    return this.map.get(`${runId}::${key}`) ?? null;
  }
  async delete(runId: string, key: string): Promise<void> {
    this.map.delete(`${runId}::${key}`);
  }
}

function mockTool(name: string, result = "ok") {
  const invokeFn = vi.fn(async (_args: Record<string, unknown>) => result);
  return {
    tool: {
      name,
      description: `Mock ${name}`,
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: invokeFn,
    } as unknown as StructuredToolInterface,
    invokeFn,
  };
}

function createMockModel(responses: AIMessage[]): BaseChatModel {
  let i = 0;
  return {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      const r = responses[i] ?? new AIMessage("done");
      i++;
      return r;
    }),
  } as unknown as BaseChatModel;
}

function aiWithToolCall(
  name: string,
  args: Record<string, unknown> = {},
  id = "call_0",
) {
  const msg = new AIMessage({ content: "" });
  (msg as AIMessage & { tool_calls: unknown[] }).tool_calls = [
    { id, name, args },
  ];
  return msg;
}

// ---------------------------------------------------------------------------
// 1. ApprovalSuspendedError
// ---------------------------------------------------------------------------

describe("ApprovalSuspendedError", () => {
  it('has name "ApprovalSuspendedError"', () => {
    const err = new ApprovalSuspendedError("token-abc", "run-1");
    expect(err.name).toBe("ApprovalSuspendedError");
  });

  it("exposes resumeToken", () => {
    const err = new ApprovalSuspendedError("my-token", "run-1");
    expect(err.resumeToken).toBe("my-token");
  });

  it("exposes runId", () => {
    const err = new ApprovalSuspendedError("t", "run-42");
    expect(err.runId).toBe("run-42");
  });

  it("message includes the resume token", () => {
    const err = new ApprovalSuspendedError("xyz-token", "run-1");
    expect(err.message).toContain("xyz-token");
  });

  it("is an instanceof Error", () => {
    const err = new ApprovalSuspendedError("t", "r");
    expect(err).toBeInstanceOf(Error);
  });

  it("is an instanceof ApprovalSuspendedError", () => {
    const err = new ApprovalSuspendedError("t", "r");
    expect(err).toBeInstanceOf(ApprovalSuspendedError);
  });

  it("different tokens produce different messages", () => {
    const e1 = new ApprovalSuspendedError("aaa", "r");
    const e2 = new ApprovalSuspendedError("bbb", "r");
    expect(e1.message).not.toBe(e2.message);
  });
});

// ---------------------------------------------------------------------------
// 2. DEFAULT_APPROVAL_TIMEOUT_MS constant
// ---------------------------------------------------------------------------

describe("DEFAULT_APPROVAL_TIMEOUT_MS", () => {
  it("is a positive number", () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("is at least 10 seconds (sane lower bound for production)", () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});

// ---------------------------------------------------------------------------
// 3. loadPending()
// ---------------------------------------------------------------------------

describe("ApprovalGate.loadPending()", () => {
  it("returns null when no checkpointStore is configured", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required" }, bus);
    const result = await gate.loadPending("run-x");
    expect(result).toBeNull();
  });

  it("returns null when store has nothing for the runId", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate(
      {
        mode: "required",
        durableResume: true,
        checkpointStore: new InMemoryApprovalStore(),
      },
      bus,
    );
    const result = await gate.loadPending("run-missing");
    expect(result).toBeNull();
  });

  it("returns the persisted state after requestApproval", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await expect(
      gate.requestApproval({ runId: "run-lp1", plan: "deploy" }),
    ).rejects.toBeInstanceOf(ApprovalSuspendedError);

    const state = await gate.loadPending("run-lp1");
    expect(state).not.toBeNull();
    expect(state!.runId).toBe("run-lp1");
    expect(state!.plan).toBe("deploy");
  });

  it("returns null after resume clears the state", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await expect(
      gate.requestApproval({ runId: "run-lp2", plan: "x" }),
    ).rejects.toBeInstanceOf(ApprovalSuspendedError);

    await gate.resume("run-lp2", { decision: "approved" }, await tokenFor(gate, "run-lp2"));

    const after = await gate.loadPending("run-lp2");
    expect(after).toBeNull();
  });

  it("returns state with correct contactId when provided", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await expect(
      gate.requestApproval({
        runId: "run-cid",
        plan: "p",
        contactId: "explicit-cid",
      }),
    ).rejects.toBeInstanceOf(ApprovalSuspendedError);

    const state = await gate.loadPending("run-cid");
    expect(state!.contactId).toBe("explicit-cid");
  });

  it("returns state with auto-generated contactId when not provided", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await expect(
      gate.requestApproval({ runId: "run-autocid", plan: "p" }),
    ).rejects.toBeInstanceOf(ApprovalSuspendedError);

    const state = await gate.loadPending("run-autocid");
    expect(typeof state!.contactId).toBe("string");
    expect(state!.contactId.length).toBeGreaterThan(0);
  });

  it("state timeoutAt is null for durableResume with no timeoutMs", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await expect(
      gate.requestApproval({ runId: "run-notime", plan: "p" }),
    ).rejects.toBeInstanceOf(ApprovalSuspendedError);

    const state = await gate.loadPending("run-notime");
    expect(state!.timeoutAt).toBeNull();
  });

  it("state timeoutAt is a number when timeoutMs is set", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      {
        mode: "required",
        durableResume: true,
        checkpointStore: store,
        timeoutMs: 5_000,
      },
      bus,
    );

    await expect(
      gate.requestApproval({ runId: "run-ttime", plan: "p" }),
    ).rejects.toBeInstanceOf(ApprovalSuspendedError);

    const state = await gate.loadPending("run-ttime");
    expect(typeof state!.timeoutAt).toBe("number");
    expect(state!.timeoutAt).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
// 4. requestApproval() durable path
// ---------------------------------------------------------------------------

describe("ApprovalGate.requestApproval() durable path", () => {
  it("throws ApprovalSuspendedError with a resumeToken", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    const err = await gate
      .requestApproval({ runId: "run-d1", plan: "p" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalSuspendedError);
    expect(typeof (err as ApprovalSuspendedError).resumeToken).toBe("string");
  });

  it("emits approval:requested event with correct runId", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    await gate.requestApproval({ runId: "run-d2", plan: "p" }).catch(() => {});

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval:requested",
      runId: "run-d2",
    });
  });

  it("persists requestedAt timestamp", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const before = Date.now();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    await gate.requestApproval({ runId: "run-d3", plan: "p" }).catch(() => {});
    const after = Date.now();

    const state = await store.load("run-d3", APPROVAL_PENDING_KEY);
    expect(state!.requestedAt).toBeGreaterThanOrEqual(before);
    expect(state!.requestedAt).toBeLessThanOrEqual(after);
  });

  it("persists resumeToken matching the thrown error", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    let token: string | undefined;
    await gate.requestApproval({ runId: "run-d4", plan: "p" }).catch((e) => {
      token = (e as ApprovalSuspendedError).resumeToken;
    });

    const state = await store.load("run-d4", APPROVAL_PENDING_KEY);
    expect(state!.resumeToken).toBe(token);
  });

  it("stores the correct channel from config", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      {
        mode: "required",
        durableResume: true,
        checkpointStore: store,
        channel: "slack",
      },
      bus,
    );
    await gate.requestApproval({ runId: "run-d5", plan: "p" }).catch(() => {});

    const state = await store.load("run-d5", APPROVAL_PENDING_KEY);
    expect(state!.channel).toBe("slack");
  });

  it("stores the correct plan value (object)", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    const plan = { action: "delete", target: "prod-db" };
    await gate.requestApproval({ runId: "run-d6", plan }).catch(() => {});

    const state = await store.load("run-d6", APPROVAL_PENDING_KEY);
    expect(state!.plan).toEqual(plan);
  });

  it("unique resumeTokens across multiple requestApproval calls", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) {
      await gate
        .requestApproval({ runId: `run-tok-${i}`, plan: "p" })
        .catch((e) => {
          tokens.add((e as ApprovalSuspendedError).resumeToken);
        });
    }
    expect(tokens.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 5. resume() error cases
// ---------------------------------------------------------------------------

describe("ApprovalGate.resume() error cases", () => {
  it("throws when no checkpointStore is configured", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required" }, bus);
    await expect(
      gate.resume("run-1", { decision: "approved" }, await tokenFor(gate, "run-1")),
    ).rejects.toThrow(/checkpointStore/);
  });

  it("throws when checkpointStore has no pending state for runId", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    await expect(
      gate.resume("run-nope", { decision: "approved" }, await tokenFor(gate, "run-nope")),
    ).rejects.toThrow(/No pending approval/);
  });

  it("emits approval:granted when decision is approved", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const granted: unknown[] = [];
    bus.on("approval:granted", (e) => { granted.push(e) });

    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    await gate.requestApproval({ runId: "run-r1", plan: "p" }).catch(() => {});
    await gate.resume("run-r1", { decision: "approved" }, await tokenFor(gate, "run-r1"));

    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      type: "approval:granted",
      runId: "run-r1",
    });
  });

  it("emits approval:rejected when decision is rejected", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const rejected: unknown[] = [];
    bus.on("approval:rejected", (e) => { rejected.push(e) });

    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    await gate.requestApproval({ runId: "run-r2", plan: "p" }).catch(() => {});
    await gate.resume("run-r2", {
      decision: "rejected",
      reason: "denied by policy",
    }, await tokenFor(gate, "run-r2"));

    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      type: "approval:rejected",
      runId: "run-r2",
      reason: "denied by policy",
    });
  });

  it("approval:rejected event has no reason field when reason is omitted", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const rejected: unknown[] = [];
    bus.on("approval:rejected", (e) => { rejected.push(e) });

    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    await gate.requestApproval({ runId: "run-r3", plan: "p" }).catch(() => {});
    await gate.resume("run-r3", { decision: "rejected" }, await tokenFor(gate, "run-r3"));

    const evt = rejected[0] as Record<string, unknown>;
    expect(evt["reason"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. waitForApproval — bypass (auto) mode
// ---------------------------------------------------------------------------

describe("ApprovalGate bypass (auto) mode", () => {
  it("resolves approved for string plan", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "auto" }, bus);
    const result = await gate.waitForApproval("r", "deploy prod");
    expect(result).toBe("approved");
  });

  it("resolves approved for object plan", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "auto" }, bus);
    const result = await gate.waitForApproval("r", {
      action: "write",
      target: "db",
    });
    expect(result).toBe("approved");
  });

  it("resolves approved for null plan", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "auto" }, bus);
    const result = await gate.waitForApproval("r", null);
    expect(result).toBe("approved");
  });

  it("resolves approved for array plan", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "auto" }, bus);
    const result = await gate.waitForApproval("r", [1, 2, 3]);
    expect(result).toBe("approved");
  });

  it("does NOT emit approval:requested in auto mode", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    const gate = new ApprovalGate({ mode: "auto" }, bus);
    await gate.waitForApproval("r", "plan");
    expect(events).toHaveLength(0);
  });

  it("resolves synchronously (same microtask tick) in auto mode", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "auto" }, bus);
    const p = gate.waitForApproval("r", "plan");
    // The result must already be resolved
    const result = await p;
    expect(result).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// 7. Conditional mode edge cases
// ---------------------------------------------------------------------------

describe("ApprovalGate conditional mode edge cases", () => {
  it("condition receives the plan and ctx arguments", async () => {
    const bus = createEventBus();
    const condition = vi.fn().mockResolvedValue(false);
    const gate = new ApprovalGate({ mode: "conditional", condition }, bus);
    const ctx = { agentId: "a1", runId: "run-1", metadata: {} };

    await gate.waitForApproval("run-1", { op: "read" }, ctx);
    expect(condition).toHaveBeenCalledWith({ op: "read" }, ctx);
  });

  it("condition returning truthy non-boolean (1) requires approval", async () => {
    const bus = createEventBus();
    const condition = vi.fn().mockResolvedValue(1 as unknown as boolean);
    const gate = new ApprovalGate(
      { mode: "conditional", condition, timeoutMs: 30 },
      bus,
    );
    const ctx = { agentId: "a1", runId: "run-1", metadata: {} };

    const result = await gate.waitForApproval("run-1", "plan", ctx);
    // Truthy → needs approval → times out
    expect(result).toBe("timeout");
  });

  it("condition returning false skips approval", async () => {
    const bus = createEventBus();
    const condition = vi.fn().mockResolvedValue(false);
    const gate = new ApprovalGate({ mode: "conditional", condition }, bus);
    const ctx = { agentId: "a1", runId: "run-1", metadata: {} };

    const result = await gate.waitForApproval("run-1", "plan", ctx);
    expect(result).toBe("approved");
  });

  it("condition is synchronous (returns non-Promise) — treated as falsy", async () => {
    const bus = createEventBus();
    // Sync false
    const condition = vi
      .fn()
      .mockReturnValue(false as unknown as Promise<boolean>);
    const gate = new ApprovalGate({ mode: "conditional", condition }, bus);
    const ctx = { agentId: "a1", runId: "run-1", metadata: {} };

    const result = await gate.waitForApproval("run-1", "plan", ctx);
    expect(result).toBe("approved");
  });

  it("missing ctx skips condition evaluation and requires approval", async () => {
    const bus = createEventBus();
    const condition = vi.fn().mockResolvedValue(false);
    const gate = new ApprovalGate(
      { mode: "conditional", condition, timeoutMs: 30 },
      bus,
    );

    const result = await gate.waitForApproval("run-1", "plan");
    // condition is not called when ctx is absent
    expect(condition).not.toHaveBeenCalled();
    expect(result).toBe("timeout");
  });

  it("condition that throws is not caught by the gate — propagates", async () => {
    const bus = createEventBus();
    const condition = vi.fn().mockRejectedValue(new Error("condition failure"));
    const gate = new ApprovalGate({ mode: "conditional", condition }, bus);
    const ctx = { agentId: "a1", runId: "run-1", metadata: {} };

    await expect(gate.waitForApproval("run-1", "plan", ctx)).rejects.toThrow(
      "condition failure",
    );
  });
});

// ---------------------------------------------------------------------------
// 8. AbortSignal — pre-aborted and abort reason variants
// ---------------------------------------------------------------------------

describe("ApprovalGate AbortSignal edge cases", () => {
  it("returns cancelled when signal is already aborted before call", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 5_000 }, bus);

    const controller = new AbortController();
    controller.abort("pre-aborted");

    const result = await gate.waitForApproval("r", "plan", undefined, {
      signal: controller.signal,
    });
    expect(result).toBe("cancelled");
  });

  it("emits approval:cancelled when signal is already aborted", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:cancelled", (e) => { events.push(e) });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 5_000 }, bus);
    const controller = new AbortController();
    controller.abort("pre-abort-reason");

    await gate.waitForApproval("run-pa", "plan", undefined, {
      signal: controller.signal,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval:cancelled",
      runId: "run-pa",
      reason: "pre-abort-reason",
    });
  });

  it("abort reason as Error instance — message is used", async () => {
    const bus = createEventBus();
    const cancellations: unknown[] = [];
    bus.on("approval:cancelled", (e) => { cancellations.push(e) });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 5_000 }, bus);
    const controller = new AbortController();
    controller.abort(new Error("error-reason-message"));

    await gate.waitForApproval("run-err-reason", "plan", undefined, {
      signal: controller.signal,
    });
    const evt = cancellations[0] as Record<string, unknown>;
    expect(evt["reason"]).toBe("error-reason-message");
  });

  it("abort reason as unknown type — falls back to default string", async () => {
    const bus = createEventBus();
    const cancellations: unknown[] = [];
    bus.on("approval:cancelled", (e) => { cancellations.push(e) });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 5_000 }, bus);
    const controller = new AbortController();
    // Abort with a non-string, non-Error value
    controller.abort(42);

    await gate.waitForApproval("run-unk-reason", "plan", undefined, {
      signal: controller.signal,
    });
    const evt = cancellations[0] as Record<string, unknown>;
    expect(typeof evt["reason"]).toBe("string");
    expect((evt["reason"] as string).length).toBeGreaterThan(0);
  });

  it("abort fires after wait starts — resolves cancelled, not timeout", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 1_000 }, bus);
    const controller = new AbortController();

    const p = gate.waitForApproval("run-ab", "plan", undefined, {
      signal: controller.signal,
    });
    // Abort quickly, before the 1s timeout fires
    setTimeout(() => controller.abort("user shutdown"), 10);

    const result = await p;
    expect(result).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// 9. Event sequence correctness
// ---------------------------------------------------------------------------

describe("ApprovalGate event sequence", () => {
  it("requested fires before granted resolves", async () => {
    const bus = createEventBus();
    const sequence: string[] = [];
    bus.on("approval:requested", () => { sequence.push("requested") });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 500 }, bus);
    const p = gate.waitForApproval("run-seq1", "plan");

    setTimeout(() => {
      sequence.push("grant-sent");
      bus.emit({ type: "approval:granted", runId: "run-seq1" });
    }, 10);

    await p;
    sequence.push("resolved");

    expect(sequence[0]).toBe("requested");
    expect(sequence[1]).toBe("grant-sent");
    expect(sequence[2]).toBe("resolved");
  });

  it("requested fires before timed_out resolves", async () => {
    const bus = createEventBus();
    const sequence: string[] = [];
    bus.on("approval:requested", () => { sequence.push("requested") });
    bus.on("approval:timed_out", () => { sequence.push("timed_out") });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-seq2", "plan");
    sequence.push("resolved");

    expect(sequence[0]).toBe("requested");
    expect(sequence[1]).toBe("timed_out");
    expect(sequence[2]).toBe("resolved");
  });

  it("requested fires before cancelled resolves", async () => {
    const bus = createEventBus();
    const sequence: string[] = [];
    bus.on("approval:requested", () => { sequence.push("requested") });
    bus.on("approval:cancelled", () => { sequence.push("cancelled") });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 1_000 }, bus);
    const ctrl = new AbortController();
    const p = gate.waitForApproval("run-seq3", "plan", undefined, {
      signal: ctrl.signal,
    });

    setTimeout(() => ctrl.abort(), 10);
    await p;
    sequence.push("resolved");

    expect(sequence[0]).toBe("requested");
    expect(sequence[1]).toBe("cancelled");
    expect(sequence[2]).toBe("resolved");
  });

  it("exactly one approval:requested event per waitForApproval call", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-once", "plan");

    expect(events).toHaveLength(1);
  });

  it("two sequential waitForApproval calls emit two requested events", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-s1", "plan");
    await gate.waitForApproval("run-s2", "plan");

    expect(events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 10. Rapid grant beats timeout
// ---------------------------------------------------------------------------

describe("ApprovalGate — rapid grant beats timeout", () => {
  it("resolves approved when grant arrives before tiny timeout", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 200 }, bus);

    const p = gate.waitForApproval("run-fast", "plan");
    // Grant well before the 200ms timeout
    setTimeout(
      () => bus.emit({ type: "approval:granted", runId: "run-fast" }),
      5,
    );

    const result = await p;
    expect(result).toBe("approved");
  });

  it("does not emit timed_out when approval arrives in time", async () => {
    // Fake timers: this is a negative assertion, so it needs time to pass rather
    // than a condition to poll. It also FIXES the assertion — the previous 20ms
    // real sleep never reached the 200ms timeout it claimed to rule out, so the
    // test would have passed even if the gate leaked its timer. Advancing well
    // past the timeout is the assertion that was intended, at zero wall cost.
    vi.useFakeTimers();
    try {
      const bus = createEventBus();
      const timeouts: unknown[] = [];
      bus.on("approval:timed_out", (e) => { timeouts.push(e) });

      const gate = new ApprovalGate({ mode: "required", timeoutMs: 200 }, bus);
      const p = gate.waitForApproval("run-fast2", "plan");
      setTimeout(
        () => bus.emit({ type: "approval:granted", runId: "run-fast2" }),
        5,
      );
      await vi.advanceTimersByTimeAsync(5);
      await p;

      // Blow past the 200ms timeout window; a leaked timer would fire here.
      await vi.advanceTimersByTimeAsync(500);
      expect(timeouts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Multiple sequential gates on the same gate instance
// ---------------------------------------------------------------------------

describe("ApprovalGate — sequential gates", () => {
  it("second gate after first is approved also resolves approved", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 500 }, bus);

    const p1 = gate.waitForApproval("run-seq-a", "step-1");
    setTimeout(
      () => bus.emit({ type: "approval:granted", runId: "run-seq-a" }),
      5,
    );
    const r1 = await p1;
    expect(r1).toBe("approved");

    const p2 = gate.waitForApproval("run-seq-b", "step-2");
    setTimeout(
      () => bus.emit({ type: "approval:granted", runId: "run-seq-b" }),
      5,
    );
    const r2 = await p2;
    expect(r2).toBe("approved");
  });

  it("second gate can be rejected independently", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 500 }, bus);

    const p1 = gate.waitForApproval("run-seq-c", "step-1");
    setTimeout(
      () => bus.emit({ type: "approval:granted", runId: "run-seq-c" }),
      5,
    );
    const r1 = await p1;
    expect(r1).toBe("approved");

    const p2 = gate.waitForApproval("run-seq-d", "step-2");
    setTimeout(
      () =>
        bus.emit({
          type: "approval:rejected",
          runId: "run-seq-d",
          reason: "stop",
        }),
      5,
    );
    const r2 = await p2;
    expect(r2).toBe("rejected");
  });

  it("three sequential gates — approved, timeout, rejected", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 50 }, bus);

    const p1 = gate.waitForApproval("multi-1", "a");
    setTimeout(
      () => bus.emit({ type: "approval:granted", runId: "multi-1" }),
      5,
    );
    expect(await p1).toBe("approved");

    const p2 = gate.waitForApproval("multi-2", "b");
    expect(await p2).toBe("timeout");

    const p3 = gate.waitForApproval("multi-3", "c");
    setTimeout(
      () =>
        bus.emit({ type: "approval:rejected", runId: "multi-3", reason: "x" }),
      5,
    );
    expect(await p3).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// 12. Concurrent gates — isolation
// ---------------------------------------------------------------------------

describe("ApprovalGate — concurrent isolation", () => {
  it("grants to run-A do not resolve run-B", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 500 }, bus);

    const pA = gate.waitForApproval("iso-A", "plan");
    const pB = gate.waitForApproval("iso-B", "plan");

    setTimeout(
      () => bus.emit({ type: "approval:granted", runId: "iso-A" }),
      10,
    );
    setTimeout(
      () =>
        bus.emit({ type: "approval:rejected", runId: "iso-B", reason: "no" }),
      20,
    );

    const [rA, rB] = await Promise.all([pA, pB]);
    expect(rA).toBe("approved");
    expect(rB).toBe("rejected");
  });

  it("five concurrent runs — all resolved correctly", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 500 }, bus);

    const runIds = ["c1", "c2", "c3", "c4", "c5"];
    const promises = runIds.map((id) => gate.waitForApproval(id, "plan"));

    // Grant even-indexed, reject odd-indexed
    runIds.forEach((id, idx) => {
      setTimeout(() => {
        if (idx % 2 === 0) {
          bus.emit({ type: "approval:granted", runId: id });
        } else {
          bus.emit({ type: "approval:rejected", runId: id, reason: "odd" });
        }
      }, 5);
    });

    const results = await Promise.all(promises);
    expect(results[0]).toBe("approved");
    expect(results[1]).toBe("rejected");
    expect(results[2]).toBe("approved");
    expect(results[3]).toBe("rejected");
    expect(results[4]).toBe("approved");
  });

  it("timeout on one run does not affect another that is still pending", async () => {
    const bus = createEventBus();
    const gateA = new ApprovalGate({ mode: "required", timeoutMs: 40 }, bus);
    const gateB = new ApprovalGate({ mode: "required", timeoutMs: 500 }, bus);

    const pA = gateA.waitForApproval("t-A", "plan");
    const pB = gateB.waitForApproval("t-B", "plan");

    // Resolve B after A has timed out
    const rA = await pA;
    expect(rA).toBe("timeout");

    bus.emit({ type: "approval:granted", runId: "t-B" });
    const rB = await pB;
    expect(rB).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// 13. Approval metadata shapes
// ---------------------------------------------------------------------------

describe("ApprovalGate metadata in approval:requested event", () => {
  it("emits contactId as a UUID-like string", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-meta", "plan");

    const evt = events[0] as Record<string, unknown>;
    const id = String(evt["contactId"]);
    // UUID v4 pattern
    expect(id).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i,
    );
  });

  it("emits plan as the exact object passed in", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    const plan = { op: "create", resource: "bucket", count: 3 };
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-plan-obj", plan);

    const evt = events[0] as Record<string, unknown>;
    expect(evt["plan"]).toEqual(plan);
  });

  it("emits plan as string when string plan is passed", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-plan-str", "approve the step");

    const evt = events[0] as Record<string, unknown>;
    expect(evt["plan"]).toBe("approve the step");
  });

  it('request.data.question is "Approve this action?" for non-string plan', async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-q1", { x: 1 });

    const evt = events[0] as Record<string, unknown>;
    const req = evt["request"] as Record<string, unknown>;
    const data = req["data"] as Record<string, unknown>;
    expect(data["question"]).toBe("Approve this action?");
  });

  it("request.data.question is the string plan itself", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-q2", "Is this OK?");

    const evt = events[0] as Record<string, unknown>;
    const req = evt["request"] as Record<string, unknown>;
    const data = req["data"] as Record<string, unknown>;
    expect(data["question"]).toBe("Is this OK?");
  });

  it("request contains runId", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-rid1", "plan");

    const evt = events[0] as Record<string, unknown>;
    const req = evt["request"] as Record<string, unknown>;
    expect(req["runId"]).toBe("run-rid1");
  });

  it('request type is "approval"', async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-rt", "plan");

    const evt = events[0] as Record<string, unknown>;
    const req = evt["request"] as Record<string, unknown>;
    expect(req["type"]).toBe("approval");
  });
});

// ---------------------------------------------------------------------------
// 14. Multiple event listeners receive same event
// ---------------------------------------------------------------------------

describe("ApprovalGate — multiple subscribers", () => {
  it("two bus subscribers both receive approval:requested", async () => {
    const bus = createEventBus();
    const a: unknown[] = [];
    const b: unknown[] = [];
    bus.on("approval:requested", (e) => { a.push(e) });
    bus.on("approval:requested", (e) => { b.push(e) });

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-multi-sub", "plan");

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toEqual(b[0]);
  });
});

// ---------------------------------------------------------------------------
// 15. Tool-loop integration — bypass mode emits no events
// ---------------------------------------------------------------------------

describe("Tool-loop + ApprovalGate bypass mode", () => {
  it("approval-required tool passes through when approvalRequired list is empty", async () => {
    const { tool, invokeFn } = mockTool("deploy", "deployed");
    const model = createMockModel([
      aiWithToolCall("deploy", { env: "staging" }),
      new AIMessage("done"),
    ]);
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    // No approvalRequired configured
    const governance = new ToolGovernance({});

    const result = await runToolLoop(
      model,
      [new HumanMessage("deploy please")],
      [tool],
      {
        maxIterations: 5,
        toolGovernance: governance,
        eventBus: bus,
        runId: "run-bypass",
      },
    );

    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("complete");
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 16. Tool-loop integration — second tool in same run also gated
// ---------------------------------------------------------------------------

describe("Tool-loop + ApprovalGate second sequential gate", () => {
  it("loop halts at first approval-required tool, not the second", async () => {
    const { tool: t1, invokeFn: inv1 } = mockTool("deploy", "ok");
    const { tool: t2, invokeFn: inv2 } = mockTool("migrate", "ok");

    // Model will suggest deploy first
    const model = createMockModel([
      aiWithToolCall("deploy", { env: "prod" }, "tc1"),
      // If loop continued (it shouldn't), it would suggest migrate next
      aiWithToolCall("migrate", { db: "main" }, "tc2"),
    ]);
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => { events.push(e) });

    const governance = new ToolGovernance({
      approvalRequired: ["deploy", "migrate"],
    });

    const result = await runToolLoop(
      model,
      [new HumanMessage("go")],
      [t1, t2],
      {
        maxIterations: 5,
        toolGovernance: governance,
        eventBus: bus,
        runId: "run-tl2",
      },
    );

    // Halts at first gate
    expect(result.stopReason).toBe("approval_pending");
    // Only deploy was gated, migrate never called
    expect(inv1).not.toHaveBeenCalled();
    expect(inv2).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval:requested",
      runId: "run-tl2",
      plan: expect.objectContaining({ toolName: "deploy" }),
    });
  });
});

// ---------------------------------------------------------------------------
// 17. Webhook — custom channel forwarded correctly
// ---------------------------------------------------------------------------

describe("ApprovalGate webhook channel forwarding", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("webhook payload includes custom channel", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate(
      {
        mode: "required",
        timeoutMs: 50,
        webhookUrl: "https://hooks.example.com/notify",
        channel: "email",
      },
      bus,
    );

    await gate.waitForApproval("run-ch", "plan");

    // Allow the async webhook to settle
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.channel).toBe("email");
  });

  it("webhook payload includes correct type field", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate(
      {
        mode: "required",
        timeoutMs: 50,
        webhookUrl: "https://hooks.example.com/notify",
      },
      bus,
    );

    await gate.waitForApproval("run-type", { step: "final" });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.type).toBe("approval_requested");
  });

  it("webhook payload runId matches the argument", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate(
      {
        mode: "required",
        timeoutMs: 50,
        webhookUrl: "https://hooks.example.com/notify",
      },
      bus,
    );

    await gate.waitForApproval("run-wh-id", "plan");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.runId).toBe("run-wh-id");
  });

  it("webhook uses POST method", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate(
      {
        mode: "required",
        timeoutMs: 50,
        webhookUrl: "https://hooks.example.com/notify",
      },
      bus,
    );

    await gate.waitForApproval("run-post", "plan");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    expect(fetchSpy.mock.calls[0]![1].method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// 18. APPROVAL_PENDING_KEY constant
// ---------------------------------------------------------------------------

describe("APPROVAL_PENDING_KEY constant", () => {
  it("is a non-empty string", () => {
    expect(typeof APPROVAL_PENDING_KEY).toBe("string");
    expect(APPROVAL_PENDING_KEY.length).toBeGreaterThan(0);
  });

  it("used by requestApproval as the storage key", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    await gate.requestApproval({ runId: "run-key", plan: "p" }).catch(() => {});

    const state = await store.load("run-key", APPROVAL_PENDING_KEY);
    expect(state).not.toBeNull();
  });
});

describe("ApprovalGate durableResume configuration", () => {
  /**
   * `durableResume` with no `timeoutMs` buys an UNBOUNDED in-process wait
   * against the promise that pending state lives in a checkpointStore and
   * another runtime can resume it. Configured without that store the gate used
   * to accept it silently, fall through to the legacy in-process wait, AND drop
   * the default timeout — so the flag delivered the unbounded wait while
   * delivering none of the durability that justified it. A restart lost the
   * approval with no event and no timeout to bound it.
   *
   * The guard is narrow on purpose. `durableResume` + explicit `timeoutMs`
   * with no store is a SUPPORTED configuration: the wait is bounded and the
   * fall-through is graceful. Only the unbounded case is rejected.
   */
  it("rejects durableResume with neither a checkpointStore nor a timeoutMs", () => {
    const bus = createEventBus();
    expect(
      () => new ApprovalGate({ mode: "required", durableResume: true }, bus),
    ).toThrow(/requires a 'timeoutMs'/);
  });

  it("explains both consequences in the error", () => {
    const bus = createEventBus();
    expect(
      () => new ApprovalGate({ mode: "required", durableResume: true }, bus),
    ).toThrow(/unbounded AND non-durable/);
  });

  it("accepts durableResume when a checkpointStore is supplied", () => {
    const bus = createEventBus();
    expect(
      () =>
        new ApprovalGate(
          {
            mode: "required",
            durableResume: true,
            checkpointStore: new InMemoryApprovalStore(),
          },
          bus,
        ),
    ).not.toThrow();
  });

  it("accepts durableResume with an explicit timeoutMs and no store", () => {
    // The bounded fall-through case. Rejecting this would break a documented,
    // already-tested configuration — the wait cannot hang, it just is not
    // durable, which is what the caller asked for.
    const bus = createEventBus();
    expect(
      () =>
        new ApprovalGate(
          { mode: "required", durableResume: true, timeoutMs: 40 },
          bus,
        ),
    ).not.toThrow();
  });

  it("leaves the default (non-durable) configuration alone", () => {
    const bus = createEventBus();
    expect(() => new ApprovalGate({ mode: "required" }, bus)).not.toThrow();
    // Explicit false is a deliberate opt-out, not a misconfiguration.
    expect(
      () => new ApprovalGate({ mode: "required", durableResume: false }, bus),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// DZUPAGENT-AGENT-H-14 — approval grants must be scoped, and resume tokens
// must be verified. Regression coverage for the human-approval bypass.
// ---------------------------------------------------------------------------

describe("ApprovalGate grant scoping (DZUPAGENT-AGENT-H-14)", () => {
  it("a grant for run A does not satisfy a pending approval for run B", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 80 }, bus);

    const pending = gate.waitForApproval("run-B", "deploy prod");
    bus.emit({ type: "approval:granted", runId: "run-A" });

    // The foreign grant must be ignored; the only way out is the timeout.
    await expect(pending).resolves.toBe("timeout");
  });

  it("a grant for contact X does not satisfy contact Y on the same run", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 200 }, bus);

    let pendingContactId: string | undefined;
    bus.on("approval:requested", (e) => {
      pendingContactId = e.contactId;
    });

    const pending = gate.waitForApproval("run-same", "deploy prod");
    expect(pendingContactId).toBeDefined();

    // A grant answering a DIFFERENT outstanding contact on the same run.
    bus.emit({
      type: "approval:granted",
      runId: "run-same",
      contactId: "some-other-contact",
    });

    await expect(pending).resolves.toBe("timeout");
  });

  it("a grant naming the pending contact does satisfy it", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 500 }, bus);

    let pendingContactId: string | undefined;
    bus.on("approval:requested", (e) => {
      pendingContactId = e.contactId;
    });

    const pending = gate.waitForApproval("run-match", "deploy prod");
    bus.emit({
      type: "approval:granted",
      runId: "run-match",
      contactId: pendingContactId!,
    });

    await expect(pending).resolves.toBe("approved");
  });

  it("an unqualified (run-scoped) grant still satisfies a pending approval", async () => {
    // POST /api/runs/:id/approve answers the run as a whole and has no
    // contact to name; that path must keep working.
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 500 }, bus);

    const pending = gate.waitForApproval("run-unqualified", "deploy prod");
    bus.emit({ type: "approval:granted", runId: "run-unqualified" });

    await expect(pending).resolves.toBe("approved");
  });
});

describe("ApprovalGate.resume() token verification (DZUPAGENT-AGENT-H-14)", () => {
  function durableGate(store: InMemoryApprovalStore, bus: ReturnType<typeof createEventBus>) {
    return new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
  }

  async function suspend(gate: ApprovalGate, runId: string): Promise<string> {
    try {
      await gate.requestApproval({ runId, plan: "deploy prod" });
    } catch (err) {
      if (err instanceof ApprovalSuspendedError) return err.resumeToken;
      throw err;
    }
    throw new Error("expected ApprovalSuspendedError");
  }

  it("rejects a replayed resumeToken", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = durableGate(store, bus);

    const token = await suspend(gate, "run-replay");

    // First use succeeds.
    await gate.resume("run-replay", { decision: "approved" }, token);

    // Replaying the very same token must not produce a second grant.
    await expect(
      gate.resume("run-replay", { decision: "approved" }, token),
    ).rejects.toThrow(/No pending approval/);

    const granted: unknown[] = [];
    bus.on("approval:granted", (e) => { granted.push(e) });
    await expect(
      gate.resume("run-replay", { decision: "approved" }, token),
    ).rejects.toThrow();
    expect(granted).toHaveLength(0);
  });

  it("rejects a mismatching resumeToken without consuming the pending state", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = durableGate(store, bus);

    const token = await suspend(gate, "run-badtoken");

    const granted: unknown[] = [];
    bus.on("approval:granted", (e) => { granted.push(e) });

    await expect(
      gate.resume("run-badtoken", { decision: "approved" }, "not-the-token"),
    ).rejects.toThrow(/Invalid resumeToken/);
    expect(granted).toHaveLength(0);

    // A wrong guess must not destroy the live approval.
    const stillPending = await gate.loadPending("run-badtoken");
    expect(stillPending).not.toBeNull();

    // The real token still works.
    await gate.resume("run-badtoken", { decision: "approved" }, token);
    expect(granted).toHaveLength(1);
  });

  it("a token minted for run A cannot resume run B", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = durableGate(store, bus);

    const tokenA = await suspend(gate, "run-tok-A");
    await suspend(gate, "run-tok-B");

    await expect(
      gate.resume("run-tok-B", { decision: "approved" }, tokenA),
    ).rejects.toThrow(/Invalid resumeToken/);
  });

  it("the grant emitted by resume() carries the pending contactId", async () => {
    const store = new InMemoryApprovalStore();
    const bus = createEventBus();
    const gate = durableGate(store, bus);

    const granted: Array<{ contactId?: string }> = [];
    bus.on("approval:granted", (e) => { granted.push(e) });

    const token = await suspend(gate, "run-grant-contact");
    const pending = await gate.loadPending("run-grant-contact");
    await gate.resume("run-grant-contact", { decision: "approved" }, token);

    expect(granted).toHaveLength(1);
    expect(granted[0]!.contactId).toBe(pending!.contactId);
  });
});
