import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEventBus } from "@dzupagent/core";
import type { DzupEvent, DzupEventBus } from "@dzupagent/core";

import {
  AdapterApprovalGate,
  type ApprovalContext,
} from "../approval/adapter-approval.js";
import type { AdapterProviderId, AgentEvent } from "../types.js";
import type { AgentCLIAdapter } from "../types.js";
import { createOrchestrator } from "../facade/orchestrator-facade.js";
import { stubCapabilities } from "./adapter-capability-stub.js";
import { collectEvents } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContext(
  overrides: Partial<ApprovalContext> = {}
): ApprovalContext {
  return {
    runId: "run-1",
    description: "Deploy to production",
    providerId: "claude" as AdapterProviderId,
    ...overrides,
  };
}

async function* eventStream(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e;
}

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = [];
  bus.onAny((e) => { events.push(e); });
  return events;
}

function deferredCondition() {
  let resolve!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

// Fake-clock ceiling keeps an uncancellable predicate regression finite.
async function settleConditionalWait<T>(promise: Promise<T>) {
  let timer!: ReturnType<typeof setTimeout>;
  const bounded = Promise.race([
    promise,
    new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), 500);
    }),
  ]).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  try {
    await vi.advanceTimersByTimeAsync(500);
    return await bounded;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdapterApprovalGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("requestApproval()", () => {
    it.each(["false", "true", "reject"] as const)(
      "cancels an unresolved conditional predicate and ignores its late %s settlement",
      async (late) => {
        const controller = new AbortController();
        const deferred = deferredCondition();
        const condition = vi.fn(() => deferred.promise);
        const bus = createEventBus();
        const events = collectBusEvents(bus);
        const gate = new AdapterApprovalGate({ mode: "conditional", condition, eventBus: bus });
        const add = vi.spyOn(controller.signal, "addEventListener");
        const remove = vi.spyOn(controller.signal, "removeEventListener");
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        try {
          const pending = gate.requestApproval(createContext(), controller.signal);
          expect(condition).toHaveBeenCalledTimes(1);
          expect(gate.listPending()).toHaveLength(0);
          expect(vi.getTimerCount()).toBe(0);
          controller.abort();
          const outcome = await settleConditionalWait(pending);
          expect(outcome).toMatchObject({ error: { code: "AGENT_ABORTED" } });
          expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);

          if (late === "reject") deferred.reject(new Error("late predicate rejection"));
          else deferred.resolve(late === "true");
          await vi.advanceTimersByTimeAsync(0);
          expect(gate.listPending()).toHaveLength(0);
          expect(gate.getAuditStore().query()).toHaveLength(0);
          expect(events).toHaveLength(0);
          expect(vi.getTimerCount()).toBe(0);
          expect(unhandled).not.toHaveBeenCalled();
        } finally {
          controller.abort();
          deferred.resolve(false);
          gate.dispose();
          process.off("unhandledRejection", unhandled);
        }
      }, 1000,
    );

    it("preserves conditional auto-approval and required approval with a signal", async () => {
      for (const asynchronous of [false, true]) {
        for (const needsApproval of [false, true]) {
          const controller = new AbortController();
          const gate = new AdapterApprovalGate({
            mode: "conditional",
            condition: () => asynchronous ? Promise.resolve(needsApproval) : needsApproval,
          });
          const remove = vi.spyOn(controller.signal, "removeEventListener");
          const pending = gate.requestApproval(createContext(), controller.signal);
          await vi.advanceTimersByTimeAsync(0);
          expect(remove).toHaveBeenCalled();
          expect(gate.listPending()).toHaveLength(needsApproval ? 1 : 0);
          if (needsApproval) gate.grant(gate.listPending()[0]!.requestId);
          await expect(pending).resolves.toBe("approved");
          controller.abort();
          expect(gate.getAuditStore().query({ action: "rejected" })).toHaveLength(0);
          expect(vi.getTimerCount()).toBe(0);
          gate.dispose();
        }
      }
    });

    it.each([false, true])("preserves a conditional predicate error and removes its listener (async=%s)", async (asynchronous) => {
      const controller = new AbortController();
      const predicateError = new Error("condition refused");
      const gate = new AdapterApprovalGate({
        mode: "conditional",
        condition: () => {
          if (asynchronous) return Promise.reject(predicateError);
          throw predicateError;
        },
      });
      const add = vi.spyOn(controller.signal, "addEventListener");
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      await expect(gate.requestApproval(createContext(), controller.signal)).rejects.toBe(predicateError);
      expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
      controller.abort();
      expect(gate.listPending()).toHaveLength(0);
      expect(gate.getAuditStore().query()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("observes rejection when the predicate synchronously aborts before returning its promise", async () => {
      const controller = new AbortController();
      const deferred = deferredCondition();
      const gate = new AdapterApprovalGate({
        mode: "conditional",
        condition: () => { controller.abort(); return deferred.promise; },
      });
      await expect(gate.requestApproval(createContext(), controller.signal))
        .rejects.toMatchObject({ code: "AGENT_ABORTED" });
      deferred.reject(new Error("late rejection after synchronous abort"));
      await vi.advanceTimersByTimeAsync(0);
      expect(gate.listPending()).toHaveLength(0);
      expect(gate.getAuditStore().query()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["false", "true", "reject"] as const)(
      "releases supervisor cancellation while a conditional predicate is pending, before late %s",
      async (late) => {
        const controller = new AbortController();
        const deferred = deferredCondition();
        const condition = vi.fn(() => deferred.promise);
        const bus = createEventBus();
        const events = collectBusEvents(bus);
        const gate = new AdapterApprovalGate({ mode: "conditional", condition, eventBus: bus });
        const adapter: AgentCLIAdapter = {
          providerId: "codex",
          getCapabilities: () => stubCapabilities(),
          async *execute() { yield { type: "adapter:completed", providerId: "codex",
            sessionId: "unexpected", result: "unexpected", durationMs: 0, timestamp: Date.now() }; },
          async *resumeSession() {},
          interrupt() {},
          configure() {},
          async healthCheck() {
            return { healthy: true, providerId: "codex", sdkInstalled: true, cliAvailable: true };
          },
        };
        const facade = createOrchestrator({ adapters: [adapter], approvalGate: gate, eventBus: bus });
        const prepare = vi.spyOn(facade.pipeline, "prepare");
        const route = vi.spyOn(facade.registry, "getForTask");
        const execute = vi.spyOn(adapter, "execute");
        const configure = vi.spyOn(adapter, "configure");
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        try {
          const pending = facade.supervisor("cancel unresolved condition", {
            signal: controller.signal, requireApproval: true, maxConcurrentDelegations: 1,
            decomposer: { async decompose() { return [
              { description: "root", tags: [] },
              { description: "child", tags: [], dependsOn: [0] },
              { description: "queued", tags: [] },
            ]; } },
          });
          await vi.advanceTimersByTimeAsync(0);
          expect(condition).toHaveBeenCalledTimes(1);
          expect(gate.listPending()).toHaveLength(0);
          expect(vi.getTimerCount()).toBe(0);
          controller.abort();
          const outcome = await settleConditionalWait(pending);
          expect(outcome).not.toHaveProperty("error");
          expect(outcome).toMatchObject({ result: { cancelled: true } });
          if (!("result" in outcome) || outcome.result === "deadline") {
            throw new Error("Conditional cancellation did not settle within 500ms");
          }
          expect(outcome.result.subtaskResults.every((entry) =>
            entry.cancelled && entry.errorCode === "AGENT_ABORTED" && entry.providerId === null,
          )).toBe(true);
          expect(outcome.result.subtaskResults[1]?.skippedDependencies).toEqual([0]);

          if (late === "reject") deferred.reject(new Error("late supervisor predicate rejection"));
          else deferred.resolve(late === "true");
          await vi.advanceTimersByTimeAsync(0);
          expect(gate.listPending()).toHaveLength(0);
          expect(gate.getAuditStore().query()).toHaveLength(0);
          expect(vi.getTimerCount()).toBe(0);
          expect(events.filter((event) => event.type.startsWith("approval:") ||
            event.type === "supervisor:delegating")).toHaveLength(0);
          expect(prepare).not.toHaveBeenCalled();
          expect(route).not.toHaveBeenCalled();
          expect(execute).not.toHaveBeenCalled();
          expect(configure).not.toHaveBeenCalled();
          expect(unhandled).not.toHaveBeenCalled();
        } finally {
          controller.abort();
          deferred.resolve(false);
          gate.dispose();
          process.off("unhandledRejection", unhandled);
        }
      }, 1000,
    );

    it("cancels only the exact request and timer, retaining other pending approvals", async () => {
      const gate = new AdapterApprovalGate({ mode: "required", timeoutMs: 5000 });
      const first = new AbortController();
      const second = new AbortController();
      const firstPending = gate.requestApproval(createContext({ runId: "first" }), first.signal);
      const rejection = expect(firstPending).rejects.toMatchObject({ code: "AGENT_ABORTED" });
      const secondPending = gate.requestApproval(createContext({ runId: "second" }), second.signal);
      const firstRequest = gate.listPending().find((request) => request.runId === "first")!;
      const secondRequest = gate.listPending().find((request) => request.runId === "second")!;
      expect(vi.getTimerCount()).toBe(2);
      first.abort();
      await rejection;
      expect(gate.listPending().map((request) => request.runId)).toEqual(["second"]);
      expect(gate.getRequest(firstRequest.requestId)).toBeUndefined();
      expect(gate.grant(firstRequest.requestId)).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      gate.grant(secondRequest.requestId);
      await expect(secondPending).resolves.toBe("approved");
      expect(vi.getTimerCount()).toBe(0);
      second.abort();
      expect(gate.getAuditStore().query({ requestId: secondRequest.requestId, action: "rejected" })).toHaveLength(0);
    });

    it("cleans up cancellation triggered synchronously by the requested event", async () => {
      const controller = new AbortController();
      const bus = createEventBus();
      bus.onAny((event) => { if (event.type === "approval:requested") controller.abort(); });
      const gate = new AdapterApprovalGate({ mode: "required", eventBus: bus });
      await expect(gate.requestApproval(createContext(), controller.signal)).rejects.toMatchObject({ code: "AGENT_ABORTED" });
      expect(gate.listPending()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("refuses a pre-aborted approval before requests, timers or auto-approval audit", async () => {
      const controller = new AbortController();
      controller.abort();
      const gate = new AdapterApprovalGate({ mode: "auto" });
      await expect(gate.requestApproval(createContext(), controller.signal)).rejects.toMatchObject({ code: "AGENT_ABORTED" });
      expect(gate.listPending()).toHaveLength(0);
      expect(gate.getAuditStore().query()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("auto mode returns approved immediately", async () => {
      const gate = new AdapterApprovalGate({ mode: "auto" });
      const result = await gate.requestApproval(createContext());
      expect(result).toBe("approved");
    });

    it("required mode waits for grant", async () => {
      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 5000,
      });
      const ctx = createContext();

      // Start requesting (will block until grant/reject/timeout)
      const promise = gate.requestApproval(ctx);

      // Wait a tick for the request to be registered
      await vi.advanceTimersByTimeAsync(0);

      const pending = gate.listPending();
      expect(pending).toHaveLength(1);

      // Grant it
      const granted = gate.grant(pending[0]!.requestId);
      expect(granted).toBe(true);

      const result = await promise;
      expect(result).toBe("approved");
    });

    it("required mode times out", async () => {
      const gate = new AdapterApprovalGate({ mode: "required", timeoutMs: 50 });
      const resultPromise = gate.requestApproval(createContext());
      await vi.advanceTimersByTimeAsync(50);
      const result = await resultPromise;
      expect(result).toBe("timeout");
    });

    it("conditional mode evaluates condition - approval needed", async () => {
      const gate = new AdapterApprovalGate({
        mode: "conditional",
        condition: (ctx) => ctx.tags?.includes("dangerous") ?? false,
        timeoutMs: 50,
      });

      // No dangerous tag -- auto-approve
      const result1 = await gate.requestApproval(
        createContext({ tags: ["safe"] })
      );
      expect(result1).toBe("approved");

      // Dangerous tag -- requires approval, will timeout
      const result2Promise = gate.requestApproval(
        createContext({ tags: ["dangerous"] })
      );
      await vi.advanceTimersByTimeAsync(50);
      const result2 = await result2Promise;
      expect(result2).toBe("timeout");
    });

    it("conditional mode evaluates async condition", async () => {
      const gate = new AdapterApprovalGate({
        mode: "conditional",
        condition: async () => false,
        timeoutMs: 50,
      });

      const result = await gate.requestApproval(createContext());
      expect(result).toBe("approved");
    });
  });

  describe("grant()", () => {
    it("resolves pending request as approved", async () => {
      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 5000,
      });
      const promise = gate.requestApproval(createContext());

      await vi.advanceTimersByTimeAsync(0);

      const pending = gate.listPending();
      const found = gate.grant(pending[0]!.requestId, "admin");
      expect(found).toBe(true);

      const result = await promise;
      expect(result).toBe("approved");
    });

    it("returns false for unknown request ID", () => {
      const gate = new AdapterApprovalGate({ mode: "required" });
      expect(gate.grant("nonexistent")).toBe(false);
    });
  });

  describe("reject()", () => {
    it("resolves pending request as rejected", async () => {
      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 5000,
      });
      const promise = gate.requestApproval(createContext());

      await vi.advanceTimersByTimeAsync(0);

      const pending = gate.listPending();
      const found = gate.reject(pending[0]!.requestId, "too risky");
      expect(found).toBe(true);

      const result = await promise;
      expect(result).toBe("rejected");
    });

    it("returns false for unknown request ID", () => {
      const gate = new AdapterApprovalGate({ mode: "required" });
      expect(gate.reject("nonexistent")).toBe(false);
    });
  });

  describe("autoApproveBelowCostCents", () => {
    it("bypasses approval when estimated cost is below threshold", async () => {
      const gate = new AdapterApprovalGate({
        mode: "required",
        autoApproveBelowCostCents: 100,
        timeoutMs: 50,
      });

      // Below threshold -- auto-approve
      const result = await gate.requestApproval(
        createContext({ estimatedCostCents: 50 })
      );
      expect(result).toBe("approved");
    });

    it("requires approval when cost is above threshold", async () => {
      const gate = new AdapterApprovalGate({
        mode: "required",
        autoApproveBelowCostCents: 100,
        timeoutMs: 50,
      });

      // Above threshold -- will timeout
      const resultPromise = gate.requestApproval(
        createContext({ estimatedCostCents: 200 })
      );
      await vi.advanceTimersByTimeAsync(50);
      const result = await resultPromise;
      expect(result).toBe("timeout");
    });

    it("requires approval when no cost estimate is provided", async () => {
      const gate = new AdapterApprovalGate({
        mode: "required",
        autoApproveBelowCostCents: 100,
        timeoutMs: 50,
      });

      // No cost estimate -- requires approval, will timeout
      const resultPromise = gate.requestApproval(createContext());
      await vi.advanceTimersByTimeAsync(50);
      const result = await resultPromise;
      expect(result).toBe("timeout");
    });
  });

  describe("listPending()", () => {
    it("returns pending requests", async () => {
      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 5000,
      });

      // Create two pending requests
      gate.requestApproval(createContext({ runId: "run-1" }));
      gate.requestApproval(createContext({ runId: "run-2" }));

      await vi.advanceTimersByTimeAsync(0);

      const pending = gate.listPending();
      expect(pending).toHaveLength(2);
      expect(pending.map((p) => p.runId)).toContain("run-1");
      expect(pending.map((p) => p.runId)).toContain("run-2");

      // Cleanup
      gate.clear();
    });
  });

  describe("getRequest()", () => {
    it("returns request by ID", async () => {
      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 5000,
      });
      gate.requestApproval(createContext());

      await vi.advanceTimersByTimeAsync(0);

      const pending = gate.listPending();
      const req = gate.getRequest(pending[0]!.requestId);
      expect(req).toBeDefined();
      expect(req!.status).toBe("pending");
      expect(req!.context.description).toBe("Deploy to production");

      gate.clear();
    });

    it("returns undefined for unknown ID", () => {
      const gate = new AdapterApprovalGate({ mode: "required" });
      expect(gate.getRequest("unknown")).toBeUndefined();
    });
  });

  describe("clear()", () => {
    it("removes all pending requests", async () => {
      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 5000,
      });
      gate.requestApproval(createContext({ runId: "a" }));
      gate.requestApproval(createContext({ runId: "b" }));

      await vi.advanceTimersByTimeAsync(0);

      expect(gate.listPending()).toHaveLength(2);

      gate.clear();
      expect(gate.listPending()).toHaveLength(0);
    });
  });

  describe("guard()", () => {
    it("yields events when approved", async () => {
      const gate = new AdapterApprovalGate({ mode: "auto" });
      const source: AgentEvent[] = [
        {
          type: "adapter:started",
          providerId: "claude",
          sessionId: "s1",
          timestamp: Date.now(),
        },
        {
          type: "adapter:completed",
          providerId: "claude",
          sessionId: "s1",
          result: "done",
          durationMs: 10,
          timestamp: Date.now(),
        },
      ];

      const events = await collectEvents(
        gate.guard(createContext(), eventStream(source))
      );

      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe("adapter:started");
      expect(events[1]!.type).toBe("adapter:completed");
    });

    it("yields failed event when rejected", async () => {
      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 5000,
      });
      const ctx = createContext();

      const source: AgentEvent[] = [
        {
          type: "adapter:completed",
          providerId: "claude",
          sessionId: "s1",
          result: "done",
          durationMs: 10,
          timestamp: Date.now(),
        },
      ];

      const guardGen = gate.guard(ctx, eventStream(source));

      // Start consuming in background
      const eventsPromise = collectEvents(guardGen);

      await vi.advanceTimersByTimeAsync(0);

      // Reject the pending request
      const pending = gate.listPending();
      gate.reject(pending[0]!.requestId, "denied");

      const events = await eventsPromise;
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("adapter:failed");
      expect((events[0] as { error: string }).error).toBe("Approval rejected");
    });

    it("yields failed event on timeout", async () => {
      const gate = new AdapterApprovalGate({ mode: "required", timeoutMs: 30 });
      const source: AgentEvent[] = [
        {
          type: "adapter:completed",
          providerId: "claude",
          sessionId: "s1",
          result: "done",
          durationMs: 10,
          timestamp: Date.now(),
        },
      ];

      const eventsPromise = collectEvents(
        gate.guard(createContext(), eventStream(source))
      );
      await vi.advanceTimersByTimeAsync(30);
      const events = await eventsPromise;

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("adapter:failed");
      expect((events[0] as { error: string }).error).toBe("Approval timeout");
    });
  });

  describe("event bus integration", () => {
    it("emits approval events on bus", async () => {
      const bus = createEventBus();
      const emitted = collectBusEvents(bus);

      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 5000,
        eventBus: bus,
      });

      const promise = gate.requestApproval(createContext());

      await vi.advanceTimersByTimeAsync(0);

      const pending = gate.listPending();
      gate.grant(pending[0]!.requestId, "admin");

      await promise;

      const types = emitted.map((e) => e.type);
      expect(types).toContain("approval:requested");
      expect(types).toContain("approval:granted");
    });

    it("emits approval:rejected event on rejection", async () => {
      const bus = createEventBus();
      const emitted = collectBusEvents(bus);

      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 5000,
        eventBus: bus,
      });

      const promise = gate.requestApproval(createContext());

      await vi.advanceTimersByTimeAsync(0);

      const pending = gate.listPending();
      gate.reject(pending[0]!.requestId, "too risky");

      await promise;

      const types = emitted.map((e) => e.type);
      expect(types).toContain("approval:rejected");
    });
  });

  describe("webhook notification", () => {
    it("calls webhook URL on approval request", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("ok", { status: 200 }));

      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 50,
        webhookUrl: "https://hooks.example.com/approve",
      });

      // Fire (but do not await to completion -- the webhook is dispatched
      // synchronously before the 50ms timeout timer even starts, and we
      // don't need the full "timeout" resolution for this assertion).
      void gate.requestApproval(
        createContext({
          estimatedCostCents: 42,
          tags: ["deploy"],
          metadata: { env: "prod" },
        })
      );

      // Webhook is fire-and-forget, wait a tick
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://hooks.example.com/approve");
      expect((options as RequestInit).method).toBe("POST");

      const body = JSON.parse(
        (options as RequestInit).body as string
      ) as Record<string, unknown>;
      expect(body["type"]).toBe("approval_requested");
      expect(body["description"]).toBe("Deploy to production");
      expect(body["estimatedCostCents"]).toBe(42);
    });

    it("passes webhook URL validation policy through to secure fetch", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("ok", { status: 200 }));

      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 50,
        webhookUrl: "http://127.0.0.1:3000/approve",
        webhookUrlValidation: {
          allowHttp: true,
          allowedHosts: ["127.0.0.1:3000"],
        },
        webhookFetchImpl: fetchMock as typeof fetch,
      });

      // Fire (but do not await to completion -- see comment in the previous
      // test for why we don't need the full 50ms "timeout" resolution here).
      void gate.requestApproval(createContext());

      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("http://127.0.0.1:3000/approve");
    });

    it("does not throw if webhook fails", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("network error")
      );

      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 50,
        webhookUrl: "https://hooks.example.com/approve",
      });

      // Should not throw despite fetch failure
      const resultPromise = gate.requestApproval(createContext());
      await vi.advanceTimersByTimeAsync(50);
      const result = await resultPromise;
      expect(result).toBe("timeout");
    });
  });

  // -------------------------------------------------------------------------
  // ERR-H-09 / ERR-M-11: failure-path observability
  // -------------------------------------------------------------------------
  describe("failure-path observability", () => {
    it("ERR-H-09: logs (does not swallow) an audit-store write failure", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // An audit store whose record() always throws (DB down / disk full).
      const throwingAuditStore = {
        record: vi.fn(() => {
          throw new Error("audit DB unavailable");
        }),
        query: vi.fn(() => []),
        clear: vi.fn(),
      };

      const gate = new AdapterApprovalGate({
        mode: "auto",
        auditStore: throwingAuditStore,
      });

      // Must NOT throw even though the audit write fails.
      const result = await gate.requestApproval(createContext());
      expect(result).toBe("approved");

      // The failure must be observable, not silent.
      expect(throwingAuditStore.record).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      const loggedArgs = errorSpy.mock.calls[0] ?? [];
      const flat = JSON.stringify(loggedArgs);
      expect(flat).toContain("approval.audit.record");
      expect(flat).toContain("audit DB unavailable");
    });

    it("ERR-M-11: logs (does not swallow) a webhook notification failure", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("webhook host unreachable")
      );

      const gate = new AdapterApprovalGate({
        mode: "required",
        timeoutMs: 30,
        webhookUrl: "https://hooks.example.com/approve",
      });

      const resultPromise = gate.requestApproval(createContext());
      await vi.advanceTimersByTimeAsync(30);
      const result = await resultPromise;
      expect(result).toBe("timeout");

      // Give the fire-and-forget webhook catch a tick to run.
      await vi.advanceTimersByTimeAsync(0);

      expect(warnSpy).toHaveBeenCalled();
      const flat = JSON.stringify(warnSpy.mock.calls);
      expect(flat).toContain("approval.webhook");
    });
  });
});
