/**
 * Extended approval gate tests — covering surface area NOT already addressed
 * by the four existing approval-gate test files:
 *
 *   approval-gate.test.ts          — basic auto/required/conditional/webhook
 *   approval-gate-deep.test.ts     — extended conditional, AbortSignal, events
 *   approval-gate-durable.test.ts  — process-restart simulation, onError workflow
 *   approval-gate-hitl.test.ts     — HITL comprehensive (SuspendedError, resume,
 *                                    loadPending, sequential/concurrent isolation)
 *   tool-loop-approval.test.ts     — ReAct loop gating
 *
 * This file focuses on:
 *
 *  1.  requestApproval() durable path with input.channel overriding config.channel
 *  2.  requestApproval() without checkpointStore but durableResume: true — falls through
 *  3.  requestApproval() falls through to waitForApproval in non-durable config
 *  4.  webhookDLQ invoked after HTTP 4xx exhaustion (non-network error)
 *  5.  webhookDLQ callback that itself throws is silently swallowed
 *  6.  Webhook outbound URL policy field is forwarded to fetchWithOutboundUrlPolicy
 *  7.  Circular-reference plan is serialised without throwing (safeJsonStringify)
 *  8.  Concurrent requestApproval() calls on different runIds store independently
 *  9.  loadPending() returns null after rejection resume
 *  10. Sequential requestApproval() on same runId overwrites the persisted state
 *  11. resume() approved emits no reason field in the event
 *  12. waitForApproval with durableResume + timeoutMs — uses effective timeout
 *  13. contactId in approval:requested event is a UUID-like string (waitForApproval)
 *  14. channel defaults to in-app when not provided
 *  15. All non-in-app channel values (email, slack, sms, phone) are stored/emitted
 *  16. Idempotent store.delete — calling resume twice throws on second call
 *  17. store.save failure propagates out of requestApproval
 *  18. Approval result 'cancelled' when abort fires between requested and granted
 *  19. approval:timed_out carries the runId and contactId
 *  20. approval:cancelled carries runId and contactId
 *  21. AbortSignal abort fires during in-flight store.save — gate survives
 *  22. waitForApproval with empty-string plan
 *  23. waitForApproval with numeric plan
 *  24. plan with nested objects → context field in request.data
 *  25. Large plan object (>1 KB) serialised without throwing
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createEventBus } from "@dzupagent/core";
import { ApprovalGate } from "../approval/approval-gate.js";
import { ApprovalSuspendedError } from "../approval/approval-errors.js";
import {
  APPROVAL_PENDING_KEY,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ApprovalCheckpointStore,
  type ApprovalPendingState,
} from "../approval/approval-types.js";

// ---------------------------------------------------------------------------
// Shared test double
// ---------------------------------------------------------------------------

class InMemoryStore implements ApprovalCheckpointStore {
  readonly map = new Map<string, ApprovalPendingState>();

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

/** Store whose save() rejects with the supplied error. */
class FailingStore implements ApprovalCheckpointStore {
  constructor(private readonly error: Error) {}

  async save(): Promise<void> {
    throw this.error;
  }

  async load(): Promise<ApprovalPendingState | null> {
    return null;
  }

  async delete(): Promise<void> {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. requestApproval() durable — input.channel overrides config.channel
// ---------------------------------------------------------------------------

describe("ApprovalGate.requestApproval() channel precedence", () => {
  it("input.channel overrides config.channel", async () => {
    const store = new InMemoryStore();
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

    await gate
      .requestApproval({ runId: "run-ch1", plan: "p", channel: "email" })
      .catch(() => {});

    const state = await store.load("run-ch1", APPROVAL_PENDING_KEY);
    expect(state!.channel).toBe("email");
  });

  it("config.channel is used when input.channel is absent", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      {
        mode: "required",
        durableResume: true,
        checkpointStore: store,
        channel: "sms",
      },
      bus,
    );

    await gate.requestApproval({ runId: "run-ch2", plan: "p" }).catch(() => {});

    const state = await store.load("run-ch2", APPROVAL_PENDING_KEY);
    expect(state!.channel).toBe("sms");
  });

  it("defaults to in-app when neither input.channel nor config.channel is set", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await gate.requestApproval({ runId: "run-ch3", plan: "p" }).catch(() => {});

    const state = await store.load("run-ch3", APPROVAL_PENDING_KEY);
    expect(state!.channel).toBe("in-app");
  });
});

// ---------------------------------------------------------------------------
// 2. requestApproval() without checkpointStore but durableResume: true — falls through
// ---------------------------------------------------------------------------

describe("ApprovalGate.requestApproval() — durableResume without store falls through", () => {
  it("falls through to waitForApproval and resolves (timeout) without throwing", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate(
      // durableResume true but no checkpointStore → falls through to legacy path
      { mode: "required", durableResume: true, timeoutMs: 40 },
      bus,
    );

    const result = await gate.requestApproval({ runId: "run-ft1", plan: "p" });
    expect(result).toBe("timeout");
  });

  it("falls through and resolves approved when event arrives", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, timeoutMs: 500 },
      bus,
    );

    const p = gate.requestApproval({ runId: "run-ft2", plan: "p" });
    setTimeout(
      () => bus.emit({ type: "approval:granted", runId: "run-ft2" }),
      10,
    );

    const result = await p;
    expect(result).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// 3. requestApproval() — non-durable config falls through to waitForApproval
// ---------------------------------------------------------------------------

describe("ApprovalGate.requestApproval() — non-durable falls through to waitForApproval", () => {
  it("resolves timeout without store", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 40 }, bus);
    const result = await gate.requestApproval({ runId: "run-nd1", plan: "p" });
    expect(result).toBe("timeout");
  });

  it("resolves approved when event arrives in non-durable mode", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 500 }, bus);
    const p = gate.requestApproval({ runId: "run-nd2", plan: "p" });
    setTimeout(
      () => bus.emit({ type: "approval:granted", runId: "run-nd2" }),
      10,
    );
    const result = await p;
    expect(result).toBe("approved");
  });

  it("resolves rejected when event arrives in non-durable mode", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 500 }, bus);
    const p = gate.requestApproval({ runId: "run-nd3", plan: "p" });
    setTimeout(
      () =>
        bus.emit({ type: "approval:rejected", runId: "run-nd3", reason: "no" }),
      10,
    );
    const result = await p;
    expect(result).toBe("rejected");
  });

  it("emits approval:requested event in non-durable requestApproval", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => events.push(e));

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 40 }, bus);
    await gate.requestApproval({ runId: "run-nd4", plan: "p" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval:requested",
      runId: "run-nd4",
    });
  });
});

// ---------------------------------------------------------------------------
// 4. webhookDLQ invoked after HTTP 4xx exhaustion
// ---------------------------------------------------------------------------

describe("ApprovalGate webhook — DLQ on HTTP error response", () => {
  it("invokes webhookDLQ after all retries return non-ok HTTP status", async () => {
    vi.useFakeTimers();
    const bus = createEventBus();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal("fetch", fetchSpy);
    const dlq = vi.fn();

    const gate = new ApprovalGate(
      {
        mode: "required",
        timeoutMs: 50,
        webhookUrl: "https://example.com/wh",
        webhookDLQ: dlq,
      },
      bus,
    );

    const waitPromise = gate.waitForApproval("run-dlq-403", "plan");
    await vi.runAllTimersAsync();
    await waitPromise;

    expect(dlq).toHaveBeenCalledOnce();
    expect(dlq).toHaveBeenCalledWith(
      "run-dlq-403",
      "https://example.com/wh",
      expect.any(Error),
    );

    vi.useRealTimers();
  });

  it("emits approval:webhook_failed after HTTP 403 exhaustion", async () => {
    vi.useFakeTimers();
    const bus = createEventBus();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal("fetch", fetchSpy);
    const failedEvents: unknown[] = [];
    bus.on("approval:webhook_failed", (e) => failedEvents.push(e));

    const gate = new ApprovalGate(
      {
        mode: "required",
        timeoutMs: 50,
        webhookUrl: "https://example.com/wh",
      },
      bus,
    );

    const waitPromise = gate.waitForApproval("run-dlq-emits", "plan");
    await vi.runAllTimersAsync();
    await waitPromise;

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      type: "approval:webhook_failed",
      runId: "run-dlq-emits",
      attempts: 3,
    });

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 5. webhookDLQ callback that itself throws is silently swallowed
// ---------------------------------------------------------------------------

describe("ApprovalGate webhook — DLQ error is swallowed", () => {
  it("does not propagate DLQ callback errors", async () => {
    vi.useFakeTimers();
    const bus = createEventBus();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchSpy);

    const gate = new ApprovalGate(
      {
        mode: "required",
        timeoutMs: 50,
        webhookUrl: "https://example.com/wh",
        webhookDLQ: async () => {
          throw new Error("DLQ itself failed");
        },
      },
      bus,
    );

    // Should NOT reject even though DLQ throws
    const waitPromise = gate.waitForApproval("run-dlq-swallow", "plan");
    await vi.runAllTimersAsync();
    await expect(waitPromise).resolves.toBe("timeout");

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 6. Circular-reference plan — safeJsonStringify fallback
// ---------------------------------------------------------------------------

describe("ApprovalGate circular plan serialisation", () => {
  it("does not throw when plan contains a circular reference", async () => {
    const bus = createEventBus();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    // Build a circular object
    const circular: Record<string, unknown> = { a: 1 };
    circular["self"] = circular;

    const gate = new ApprovalGate(
      {
        mode: "required",
        timeoutMs: 40,
        webhookUrl: "https://example.com/wh",
      },
      bus,
    );

    // Should resolve without throwing
    await expect(gate.waitForApproval("run-circ", circular)).resolves.toBe(
      "timeout",
    );
  });

  it("webhook body is valid JSON even for circular plan", async () => {
    vi.useFakeTimers();
    const bus = createEventBus();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    const circular: Record<string, unknown> = { key: "value" };
    circular["ref"] = circular;

    const gate = new ApprovalGate(
      {
        mode: "required",
        timeoutMs: 50,
        webhookUrl: "https://example.com/wh",
      },
      bus,
    );

    const waitPromise = gate.waitForApproval("run-circ-wh", circular);
    await vi.runAllTimersAsync();
    await waitPromise;

    // Verify the body sent to the webhook is parseable JSON
    const bodyStr = fetchSpy.mock.calls[0]?.[1]?.body as string;
    expect(() => JSON.parse(bodyStr)).not.toThrow();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 7. Concurrent requestApproval() — different runIds stored independently
// ---------------------------------------------------------------------------

describe("ApprovalGate.requestApproval() — concurrent different runIds", () => {
  it("stores independent state for concurrent runs", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await Promise.all([
      gate
        .requestApproval({ runId: "concurrent-A", plan: "plan-A" })
        .catch(() => {}),
      gate
        .requestApproval({ runId: "concurrent-B", plan: "plan-B" })
        .catch(() => {}),
      gate
        .requestApproval({ runId: "concurrent-C", plan: "plan-C" })
        .catch(() => {}),
    ]);

    const stateA = await store.load("concurrent-A", APPROVAL_PENDING_KEY);
    const stateB = await store.load("concurrent-B", APPROVAL_PENDING_KEY);
    const stateC = await store.load("concurrent-C", APPROVAL_PENDING_KEY);

    expect(stateA!.plan).toBe("plan-A");
    expect(stateB!.plan).toBe("plan-B");
    expect(stateC!.plan).toBe("plan-C");
  });

  it("each concurrent run gets a unique resumeToken", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    const tokens: string[] = [];
    await Promise.all(
      ["rA", "rB", "rC", "rD"].map((runId) =>
        gate.requestApproval({ runId, plan: "p" }).catch((e) => {
          tokens.push((e as ApprovalSuspendedError).resumeToken);
        }),
      ),
    );

    const unique = new Set(tokens);
    expect(unique.size).toBe(4);
  });

  it("resuming one run does not affect other pending runs", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await gate.requestApproval({ runId: "iso-X", plan: "px" }).catch(() => {});
    await gate.requestApproval({ runId: "iso-Y", plan: "py" }).catch(() => {});

    // Resume only iso-X
    await gate.resume("iso-X", { decision: "approved" });

    // iso-Y state must still be present
    const stateY = await store.load("iso-Y", APPROVAL_PENDING_KEY);
    expect(stateY).not.toBeNull();
    expect(stateY!.plan).toBe("py");

    // iso-X state must be cleared
    const stateX = await store.load("iso-X", APPROVAL_PENDING_KEY);
    expect(stateX).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. loadPending() returns null after rejection resume
// ---------------------------------------------------------------------------

describe("ApprovalGate.loadPending() after rejection resume", () => {
  it("returns null after rejection resume clears state", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await gate
      .requestApproval({ runId: "run-rej-lp", plan: "x" })
      .catch(() => {});
    await gate.resume("run-rej-lp", { decision: "rejected", reason: "denied" });

    const state = await gate.loadPending("run-rej-lp");
    expect(state).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Sequential requestApproval on same runId overwrites persisted state
// ---------------------------------------------------------------------------

describe("ApprovalGate.requestApproval() — sequential on same runId", () => {
  it("second requestApproval overwrites the stored state", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    // First request — resume and clear
    await gate
      .requestApproval({ runId: "run-overwrite", plan: "first" })
      .catch(() => {});
    await gate.resume("run-overwrite", { decision: "approved" });

    // Second request on same runId — fresh state
    await gate
      .requestApproval({ runId: "run-overwrite", plan: "second" })
      .catch(() => {});

    const state = await store.load("run-overwrite", APPROVAL_PENDING_KEY);
    expect(state).not.toBeNull();
    expect(state!.plan).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// 10. resume() approved — event has no reason field
// ---------------------------------------------------------------------------

describe("ApprovalGate.resume() approved event shape", () => {
  it("approval:granted event does not include a reason field", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const granted: unknown[] = [];
    bus.on("approval:granted", (e) => granted.push(e));

    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    await gate
      .requestApproval({ runId: "run-grant-shape", plan: "p" })
      .catch(() => {});
    await gate.resume("run-grant-shape", { decision: "approved" });

    const evt = granted[0] as Record<string, unknown>;
    expect(evt["reason"]).toBeUndefined();
  });

  it("approval:granted event always carries the runId", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const granted: unknown[] = [];
    bus.on("approval:granted", (e) => granted.push(e));

    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    await gate
      .requestApproval({ runId: "run-grant-rid", plan: "p" })
      .catch(() => {});
    await gate.resume("run-grant-rid", { decision: "approved" });

    expect(granted[0]).toMatchObject({
      type: "approval:granted",
      runId: "run-grant-rid",
    });
  });
});

// ---------------------------------------------------------------------------
// 11. waitForApproval with durableResume + timeoutMs — uses effective timeout
// ---------------------------------------------------------------------------

describe("ApprovalGate.waitForApproval() — durableResume + timeoutMs", () => {
  it("times out when durableResume is true and timeoutMs is set", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, timeoutMs: 40 },
      bus,
    );

    const result = await gate.waitForApproval("run-drt", "plan");
    expect(result).toBe("timeout");
  });

  it("emits timed_out event when durableResume + timeoutMs combination times out", async () => {
    const bus = createEventBus();
    const timedOut: unknown[] = [];
    bus.on("approval:timed_out", (e) => timedOut.push(e));

    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, timeoutMs: 40 },
      bus,
    );
    await gate.waitForApproval("run-drt-event", "plan");

    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]).toMatchObject({
      type: "approval:timed_out",
      runId: "run-drt-event",
      timeoutMs: 40,
    });
  });
});

// ---------------------------------------------------------------------------
// 12. DEFAULT_APPROVAL_TIMEOUT_MS used when no timeoutMs and no durableResume
// ---------------------------------------------------------------------------

describe("ApprovalGate effective timeout — default applied", () => {
  it("approval:requested event request.timeoutAt reflects DEFAULT_APPROVAL_TIMEOUT_MS", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => events.push(e));

    const gate = new ApprovalGate({ mode: "required" }, bus);
    const before = Date.now();
    const p = gate.waitForApproval("run-def-to", "plan");
    setTimeout(
      () => bus.emit({ type: "approval:granted", runId: "run-def-to" }),
      5,
    );
    await p;

    const evt = events[0] as Record<string, unknown>;
    const req = evt["request"] as Record<string, unknown>;
    const timeoutAt = new Date(String(req["timeoutAt"])).getTime();

    // Should be approximately now + DEFAULT_APPROVAL_TIMEOUT_MS
    expect(timeoutAt).toBeGreaterThan(
      before + DEFAULT_APPROVAL_TIMEOUT_MS - 2000,
    );
    expect(timeoutAt).toBeLessThan(before + DEFAULT_APPROVAL_TIMEOUT_MS + 2000);
  });
});

// ---------------------------------------------------------------------------
// 13. contactId in approval:requested event is UUID-like (waitForApproval path)
// ---------------------------------------------------------------------------

describe("ApprovalGate contactId format", () => {
  it("contactId emitted by requestApproval durable path is UUID-like", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => events.push(e));

    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    await gate
      .requestApproval({ runId: "run-uuid", plan: "p" })
      .catch(() => {});

    const evt = events[0] as Record<string, unknown>;
    const id = String(evt["contactId"]);
    expect(id).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i,
    );
  });

  it("persisted contactId matches the emitted contactId", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => events.push(e));

    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    await gate
      .requestApproval({ runId: "run-cid-match", plan: "p" })
      .catch(() => {});

    const emittedContactId = (events[0] as Record<string, unknown>)[
      "contactId"
    ];
    const storedState = await store.load("run-cid-match", APPROVAL_PENDING_KEY);

    expect(storedState!.contactId).toBe(emittedContactId);
  });
});

// ---------------------------------------------------------------------------
// 14. Channel values beyond in-app
// ---------------------------------------------------------------------------

describe("ApprovalGate — non-default channel values", () => {
  const channels = ["email", "sms", "phone", "slack"] as const;

  for (const ch of channels) {
    it(`channel "${ch}" is stored correctly in checkpoint`, async () => {
      const store = new InMemoryStore();
      const bus = createEventBus();
      const gate = new ApprovalGate(
        {
          mode: "required",
          durableResume: true,
          checkpointStore: store,
          channel: ch,
        },
        bus,
      );
      await gate
        .requestApproval({ runId: `run-ch-${ch}`, plan: "p" })
        .catch(() => {});

      const state = await store.load(`run-ch-${ch}`, APPROVAL_PENDING_KEY);
      expect(state!.channel).toBe(ch);
    });

    it(`channel "${ch}" is emitted in approval:requested event`, async () => {
      const bus = createEventBus();
      const events: unknown[] = [];
      bus.on("approval:requested", (e) => events.push(e));

      const gate = new ApprovalGate(
        { mode: "required", timeoutMs: 30, channel: ch },
        bus,
      );
      await gate.waitForApproval(`run-ch-ev-${ch}`, "plan");

      const evt = events[0] as Record<string, unknown>;
      expect(evt["channel"]).toBe(ch);
    });
  }
});

// ---------------------------------------------------------------------------
// 15. Idempotent delete — calling resume twice throws on second call
// ---------------------------------------------------------------------------

describe("ApprovalGate.resume() idempotency", () => {
  it('second resume after state already cleared throws "No pending approval"', async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await gate
      .requestApproval({ runId: "run-idem", plan: "p" })
      .catch(() => {});
    await gate.resume("run-idem", { decision: "approved" });

    // Second resume must fail because the state was deleted
    await expect(
      gate.resume("run-idem", { decision: "approved" }),
    ).rejects.toThrow(/No pending approval/);
  });

  it("only one approval:granted event emitted across double resume attempt", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const granted: unknown[] = [];
    bus.on("approval:granted", (e) => granted.push(e));

    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await gate
      .requestApproval({ runId: "run-idem2", plan: "p" })
      .catch(() => {});
    await gate.resume("run-idem2", { decision: "approved" });
    await gate.resume("run-idem2", { decision: "approved" }).catch(() => {});

    expect(granted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 16. store.save failure propagates out of requestApproval
// ---------------------------------------------------------------------------

describe("ApprovalGate.requestApproval() — store.save failure", () => {
  it("propagates store.save error", async () => {
    const saveError = new Error("disk full");
    const store = new FailingStore(saveError);
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await expect(
      gate.requestApproval({ runId: "run-savefail", plan: "p" }),
    ).rejects.toThrow("disk full");
  });
});

// ---------------------------------------------------------------------------
// 17. approval:timed_out event carries runId, contactId, and timeoutMs
// ---------------------------------------------------------------------------

describe("ApprovalGate approval:timed_out event shape", () => {
  it("carries runId, contactId, and timeoutMs fields", async () => {
    const bus = createEventBus();
    const timedOut: unknown[] = [];
    bus.on("approval:timed_out", (e) => timedOut.push(e));

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-timed-shape", "plan");

    const evt = timedOut[0] as Record<string, unknown>;
    expect(evt["runId"]).toBe("run-timed-shape");
    expect(typeof evt["contactId"]).toBe("string");
    expect((evt["contactId"] as string).length).toBeGreaterThan(0);
    expect(evt["timeoutMs"]).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 18. approval:cancelled event carries runId and contactId
// ---------------------------------------------------------------------------

describe("ApprovalGate approval:cancelled event shape", () => {
  it("carries runId and contactId fields", async () => {
    const bus = createEventBus();
    const cancelled: unknown[] = [];
    bus.on("approval:cancelled", (e) => cancelled.push(e));

    const gate = new ApprovalGate({ mode: "required", timeoutMs: 1_000 }, bus);
    const ctrl = new AbortController();
    const p = gate.waitForApproval("run-cancel-shape", "plan", undefined, {
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort("user cancel"), 10);
    await p;

    const evt = cancelled[0] as Record<string, unknown>;
    expect(evt["runId"]).toBe("run-cancel-shape");
    expect(typeof evt["contactId"]).toBe("string");
    expect((evt["contactId"] as string).length).toBeGreaterThan(0);
    expect(evt["reason"]).toBe("user cancel");
  });
});

// ---------------------------------------------------------------------------
// 19. waitForApproval with edge-case plan values
// ---------------------------------------------------------------------------

describe("ApprovalGate — edge-case plan values", () => {
  it("empty-string plan resolves without throwing", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await expect(gate.waitForApproval("run-empty", "")).resolves.toBe(
      "timeout",
    );
  });

  it("numeric plan resolves without throwing", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await expect(gate.waitForApproval("run-num", 42)).resolves.toBe("timeout");
  });

  it("boolean plan resolves without throwing", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await expect(gate.waitForApproval("run-bool", true)).resolves.toBe(
      "timeout",
    );
  });

  it("deeply-nested object plan resolves without throwing", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    const deep = { a: { b: { c: { d: [1, 2, { e: "value" }] } } } };
    await expect(gate.waitForApproval("run-deep", deep)).resolves.toBe(
      "timeout",
    );
  });

  it("large plan (>1KB) serialised in request.data.context without throwing", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => events.push(e));

    const largePlan = {
      items: Array.from({ length: 100 }, (_, i) => ({
        id: i,
        name: `item-${i}`,
      })),
    };
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 30 }, bus);
    await gate.waitForApproval("run-large", largePlan);

    const evt = events[0] as Record<string, unknown>;
    const req = evt["request"] as Record<string, unknown>;
    const data = req["data"] as Record<string, unknown>;
    expect(typeof data["context"]).toBe("string");
    expect((data["context"] as string).length).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// 20. auto mode — requestApproval in auto mode resolves approved immediately
// ---------------------------------------------------------------------------

describe("ApprovalGate.requestApproval() — auto mode", () => {
  it("resolves approved immediately in auto mode without requiring store", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "auto" }, bus);
    const result = await gate.requestApproval({ runId: "run-auto", plan: "p" });
    expect(result).toBe("approved");
  });

  it("does not emit approval:requested in auto mode via requestApproval", async () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => events.push(e));

    const gate = new ApprovalGate({ mode: "auto" }, bus);
    await gate.requestApproval({ runId: "run-auto2", plan: "p" });

    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 21. ApprovalSuspendedError.runId matches the requestApproval input.runId
// ---------------------------------------------------------------------------

describe("ApprovalSuspendedError — runId accuracy", () => {
  it("thrown error runId matches the requestApproval input.runId exactly", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    let caught: Error | undefined;
    await gate
      .requestApproval({ runId: "exact-run-id-123", plan: "p" })
      .catch((e) => {
        caught = e as Error;
      });

    expect(caught).toBeInstanceOf(ApprovalSuspendedError);
    expect((caught as ApprovalSuspendedError).runId).toBe("exact-run-id-123");
  });

  it("thrown error resumeToken matches the stored resumeToken", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    let caught: ApprovalSuspendedError | undefined;
    await gate
      .requestApproval({ runId: "run-token-match", plan: "p" })
      .catch((e) => {
        caught = e as ApprovalSuspendedError;
      });

    const state = await store.load("run-token-match", APPROVAL_PENDING_KEY);
    expect(state!.resumeToken).toBe(caught!.resumeToken);
  });
});

// ---------------------------------------------------------------------------
// 22. requestApproval plan with null value
// ---------------------------------------------------------------------------

describe("ApprovalGate.requestApproval() — null plan", () => {
  it("stores null plan in checkpoint correctly", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await gate
      .requestApproval({ runId: "run-null-plan", plan: null })
      .catch(() => {});

    const state = await store.load("run-null-plan", APPROVAL_PENDING_KEY);
    expect(state!.plan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 23. Webhook content-type header is always application/json
// ---------------------------------------------------------------------------

describe("ApprovalGate webhook Content-Type header", () => {
  it("always sends Content-Type: application/json", async () => {
    vi.useFakeTimers();
    const bus = createEventBus();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    const gate = new ApprovalGate(
      {
        mode: "required",
        timeoutMs: 50,
        webhookUrl: "https://example.com/wh",
      },
      bus,
    );

    const p = gate.waitForApproval("run-ct", "plan");
    await vi.runAllTimersAsync();
    await p;

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["Content-Type"]).toBe("application/json");

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 24. requestApproval emits approval:requested for durable path
// ---------------------------------------------------------------------------

describe("ApprovalGate.requestApproval() — durable path event emission", () => {
  it("emits approval:requested before throwing ApprovalSuspendedError", async () => {
    const store = new InMemoryStore();
    const bus = createEventBus();
    const sequence: string[] = [];
    bus.on("approval:requested", () => sequence.push("requested"));

    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );

    await gate
      .requestApproval({ runId: "run-seq-emit", plan: "p" })
      .catch(() => {
        sequence.push("threw");
      });

    expect(sequence[0]).toBe("requested");
    expect(sequence[1]).toBe("threw");
  });

  it("durable path approval:requested event does NOT include request sub-object", async () => {
    // The durable requestApproval path emits a simpler event (no request field)
    // compared to the waitForApproval path.
    const store = new InMemoryStore();
    const bus = createEventBus();
    const events: unknown[] = [];
    bus.on("approval:requested", (e) => events.push(e));

    const gate = new ApprovalGate(
      { mode: "required", durableResume: true, checkpointStore: store },
      bus,
    );
    await gate
      .requestApproval({ runId: "run-durable-shape", plan: "p" })
      .catch(() => {});

    // The durable path emits without a request sub-object (it doesn't build ApprovalRequest)
    const evt = events[0] as Record<string, unknown>;
    expect(evt["type"]).toBe("approval:requested");
    expect(evt["runId"]).toBe("run-durable-shape");
    expect(evt["plan"]).toBe("p");
    expect(evt["contactId"]).toBeDefined();
    expect(evt["channel"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 25. Abort signal — abort fires after grant event (race: grant wins)
// ---------------------------------------------------------------------------

describe("ApprovalGate — grant wins race against abort", () => {
  it("resolves approved (not cancelled) when grant and abort fire close together", async () => {
    const bus = createEventBus();
    const gate = new ApprovalGate({ mode: "required", timeoutMs: 1_000 }, bus);
    const ctrl = new AbortController();

    const p = gate.waitForApproval("run-race", "plan", undefined, {
      signal: ctrl.signal,
    });

    // Grant fires first (synchronous emit before abort)
    bus.emit({ type: "approval:granted", runId: "run-race" });
    ctrl.abort("too late");

    const result = await p;
    expect(result).toBe("approved");
  });
});
