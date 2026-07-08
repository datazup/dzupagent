import { describe, it, expect } from "vitest";
import { BackgroundSubagentRuntime } from "../runtime/background-subagent-runtime.js";
import { SpawnGate, allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import type { SpawnPolicy } from "../governance/spawn-gate.js";
import type { InterruptOutcome } from "@dzupagent/adapter-types";
import { InProcessRunner } from "../runner/in-process-runner.js";
import { InMemoryTaskStore } from "../store/in-memory-task-store.js";
import {
  ControllableExecutor,
  ManualClock,
  RecordingEventSink,
  RecordingGovernanceSink,
  flush,
  sequentialIds,
} from "./helpers.js";

function setup(
  opts: {
    policy?: SpawnPolicy;
    approvalGate?: {
      waitForInterrupt: (r: string, a: string) => Promise<InterruptOutcome>;
    };
    executorMode?: "manual" | "instant";
    maxConcurrent?: number;
    maxQueued?: number;
  } = {}
) {
  const store = new InMemoryTaskStore();
  const clock = new ManualClock(0);
  const events = new RecordingEventSink();
  const governance = new RecordingGovernanceSink();
  const executor = new ControllableExecutor(opts.executorMode ?? "manual");
  const runner = new InProcessRunner({ store, executor, events, clock });
  const gate = new SpawnGate(
    opts.policy ?? allowAllSpawnPolicy,
    opts.approvalGate
  );
  const runtime = new BackgroundSubagentRuntime({
    store,
    runner,
    gate,
    events,
    governance,
    clock,
    generateId: sequentialIds(),
    policy: {
      maxConcurrentBackground: opts.maxConcurrent ?? 4,
      maxQueuedTasks: opts.maxQueued ?? 100,
      defaultTtlMs: 1000,
      retentionMs: 1000,
      gcIntervalMs: 1000,
    },
  });
  return { store, clock, events, governance, executor, runtime };
}

describe("runtime happy path (spawn → run → deliver)", () => {
  it("spawns, admits, completes, and delivers via pull", async () => {
    const { runtime, executor, events } = setup();
    const out = await runtime.spawn({ agentId: "x", input: "go" }, "run-1");
    expect(out).toMatchObject({ ok: true, status: "running" });
    if (!out.ok) throw new Error("spawn failed");

    await flush();
    expect((await runtime.check(out.taskId))?.status).toBe("running");

    executor.complete(out.taskId, { output: 42 });
    const final = await runtime.await(out.taskId, { timeoutMs: 1000 });
    expect(final?.status).toBe("succeeded");
    expect(final?.result).toEqual({ output: 42 });

    const types = events.types();
    expect(types).toContain("subagent:spawned");
    expect(types).toContain("subagent:admitted");
    expect(types).toContain("subagent:completed");
  });

  it("emits a failed event when the executor throws", async () => {
    const { runtime, executor, events } = setup();
    const out = await runtime.spawn({ agentId: "x", input: "go" }, "run-1");
    if (!out.ok) throw new Error("spawn failed");
    await flush();
    executor.fail(out.taskId, "kaboom");
    const final = await runtime.await(out.taskId, { timeoutMs: 1000 });
    expect(final?.status).toBe("failed");
    expect(final?.error).toBe("kaboom");
    expect(events.types()).toContain("subagent:failed");
  });
});

describe("runtime governance", () => {
  it("denies a spawn the policy rejects", async () => {
    const policy: SpawnPolicy = {
      check: () => ({ allow: false, reason: "nope" }),
    };
    const { runtime, governance } = setup({ policy });
    const out = await runtime.spawn({ agentId: "x", input: "go" }, "run-1");
    expect(out).toEqual({ ok: false, reason: "denied", detail: "nope" });
    expect(governance.types()).toContain("governance:rule_violation");
  });

  it("blocks on approval then admits after grant", async () => {
    let resolveApproval: (() => void) | undefined;
    const approvalGate = {
      waitForInterrupt: () =>
        new Promise<InterruptOutcome>((res) => {
          resolveApproval = () => res({ decision: "granted" });
        }),
    };
    const policy: SpawnPolicy = {
      check: () => ({ allow: true, requiresApproval: true }),
    };
    const { runtime, executor, governance } = setup({ policy, approvalGate });

    const out = await runtime.spawn({ agentId: "x", input: "go" }, "run-1");
    expect(out).toMatchObject({ ok: true, status: "awaiting_approval" });
    if (!out.ok) throw new Error("spawn failed");
    expect(governance.types()).toContain("governance:approval_requested");

    resolveApproval?.();
    await flush(10);
    expect((await runtime.check(out.taskId))?.status).toBe("running");
    expect(governance.types()).toContain("governance:approval_resolved");

    executor.complete(out.taskId);
    expect((await runtime.await(out.taskId, { timeoutMs: 1000 }))?.status).toBe(
      "succeeded"
    );
  });

  it("cancels the task when approval is rejected", async () => {
    const approvalGate = {
      waitForInterrupt: async (): Promise<InterruptOutcome> => ({
        decision: "rejected",
        reason: "denied by reviewer",
      }),
    };
    const policy: SpawnPolicy = {
      check: () => ({ allow: true, requiresApproval: true }),
    };
    const { runtime } = setup({ policy, approvalGate });
    const out = await runtime.spawn({ agentId: "x", input: "go" }, "run-1");
    if (!out.ok) throw new Error("spawn failed");
    await flush(10);
    const final = await runtime.check(out.taskId);
    expect(final?.status).toBe("cancelled");
  });

  it("forces approval when admission-resolved persona constraints require it", async () => {
    let resolveApproval: (() => void) | undefined;
    const approvalGate = {
      waitForInterrupt: () =>
        new Promise<InterruptOutcome>((res) => {
          resolveApproval = () => res({ decision: "granted" });
        }),
    };
    // Base policy allows without approval; the persona constraint escalates it.
    const policy: SpawnPolicy = {
      check: () => ({ allow: true, requiresApproval: false }),
    };
    const store = new InMemoryTaskStore();
    const clock = new ManualClock(0);
    const events = new RecordingEventSink();
    const governance = new RecordingGovernanceSink();
    const executor = new ControllableExecutor("manual");
    const runner = new InProcessRunner({ store, executor, events, clock });
    const runtime = new BackgroundSubagentRuntime({
      store,
      runner,
      gate: new SpawnGate(policy, approvalGate),
      events,
      governance,
      clock,
      generateId: sequentialIds(),
      resolveAdmission: (spec) => ({
        spec: {
          ...spec,
          resolvedPersonaName: "security-reviewer",
          resolvedDefinition: {
            name: "security-reviewer",
            personaPrompt: "Review security carefully.",
            constraints: { approvalMode: "required" },
          },
        },
        audit: {
          personaName: "security-reviewer",
          inlineDefinitionHash: "sha256:test",
        },
      }),
      policy: {
        maxConcurrentBackground: 4,
        maxQueuedTasks: 100,
        defaultTtlMs: 1000,
        retentionMs: 1000,
        gcIntervalMs: 1000,
      },
    });

    const out = await runtime.spawn(
      { agentId: "security-reviewer", input: "go" },
      "run-1"
    );
    expect(out).toMatchObject({ ok: true, status: "awaiting_approval" });
    if (!out.ok) throw new Error("spawn failed");
    expect(governance.types()).toContain("governance:approval_requested");

    resolveApproval?.();
    await flush(10);
    expect((await runtime.check(out.taskId))?.status).toBe("running");
  });

  it("emits persona audit metadata on subagent:spawned", async () => {
    const store = new InMemoryTaskStore();
    const clock = new ManualClock(0);
    const events = new RecordingEventSink();
    const governance = new RecordingGovernanceSink();
    const executor = new ControllableExecutor("manual");
    const runner = new InProcessRunner({ store, executor, events, clock });
    const runtime = new BackgroundSubagentRuntime({
      store,
      runner,
      gate: new SpawnGate(allowAllSpawnPolicy),
      events,
      governance,
      clock,
      generateId: sequentialIds(),
      resolveAdmission: (spec) => ({
        spec: {
          ...spec,
          resolvedPersonaName: "reviewer",
          resolvedDefinition: {
            name: "reviewer",
            personaPrompt: "Review carefully.",
          },
        },
        audit: {
          personaName: "reviewer",
          inlineDefinitionHash: "sha256:abc",
        },
      }),
    });

    const out = await runtime.spawn(
      { agentId: "reviewer", input: "go" },
      "run-1"
    );
    if (!out.ok) throw new Error("spawn failed");
    await flush();

    expect(
      events.events.find((event) => event.type === "subagent:spawned")
    ).toMatchObject({
      personaName: "reviewer",
      inlineDefinitionHash: "sha256:abc",
    });
  });
});

describe("runtime concurrency + backpressure", () => {
  it("queues beyond maxConcurrent and admits as slots free", async () => {
    const { runtime, executor } = setup({ maxConcurrent: 1 });
    const a = await runtime.spawn({ agentId: "x", input: "1" }, "r");
    const b = await runtime.spawn({ agentId: "x", input: "2" }, "r");
    if (!a.ok || !b.ok) throw new Error("spawn failed");
    await flush();
    expect((await runtime.check(a.taskId))?.status).toBe("running");
    expect((await runtime.check(b.taskId))?.status).toBe("queued");

    executor.complete(a.taskId);
    await flush(10);
    expect((await runtime.check(b.taskId))?.status).toBe("running");
    executor.complete(b.taskId);
    expect((await runtime.await(b.taskId, { timeoutMs: 1000 }))?.status).toBe(
      "succeeded"
    );
  });

  it("returns queue_full when the queued cap is exceeded", async () => {
    const { runtime } = setup({ maxConcurrent: 1, maxQueued: 1 });
    await runtime.spawn({ agentId: "x", input: "1" }, "r"); // running
    await flush();
    await runtime.spawn({ agentId: "x", input: "2" }, "r"); // queued (fills cap of 1)
    const third = await runtime.spawn({ agentId: "x", input: "3" }, "r");
    expect(third).toEqual({ ok: false, reason: "queue_full" });
  });
});

describe("runtime cancellation", () => {
  it("aborts a running task and marks it cancelled", async () => {
    const { runtime, executor, events } = setup();
    const out = await runtime.spawn({ agentId: "x", input: "go" }, "r");
    if (!out.ok) throw new Error("spawn failed");
    await flush();
    await runtime.cancel(out.taskId);
    const final = await runtime.await(out.taskId, { timeoutMs: 1000 });
    expect(final?.status).toBe("cancelled");
    expect(events.types()).toContain("subagent:cancelled");
    // executor saw the abort
    expect(executor.runCalls.length).toBe(1);
  });

  it("cancels a queued task without running it", async () => {
    const { runtime } = setup({ maxConcurrent: 1 });
    const a = await runtime.spawn({ agentId: "x", input: "1" }, "r");
    const b = await runtime.spawn({ agentId: "x", input: "2" }, "r");
    if (!a.ok || !b.ok) throw new Error("spawn failed");
    await flush();
    await runtime.cancel(b.taskId);
    expect((await runtime.check(b.taskId))?.status).toBe("cancelled");
  });
});

describe("runtime orphan reconciliation", () => {
  it("marks orphaned running tasks failed for a non-durable runner", async () => {
    const { runtime, store } = setup();
    await store.put({
      id: "orphan",
      parentRunId: "r",
      spec: { agentId: "x", input: "hi" },
      status: "running",
      createdAt: 0,
      ttlMs: 1000,
      depth: 0,
    });
    const reconciled = await runtime.reconcileOrphans();
    expect(reconciled).toEqual(["orphan"]);
    expect((await store.get("orphan"))?.status).toBe("failed");
    expect((await store.get("orphan"))?.error).toBe(
      "orphaned_by_process_restart"
    );
  });
});
