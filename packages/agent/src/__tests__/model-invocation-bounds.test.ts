/**
 * Engine execution bounds — ORCH-DSL-L1-C-01 and ORCH-DSL-L1-H-02.
 *
 * The properties under test are *liveness* properties: a run must terminate
 * even when the provider never does. Every "stalled provider" here is a promise
 * that genuinely never settles, so a regression does not fail these tests with a
 * wrong value — it hangs them. Each such test therefore carries an explicit
 * timeout well above its deadline, so a hang surfaces as a failure rather than a
 * stuck suite.
 */
import { describe, it, expect, vi } from "vitest";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import {
  invokeModelWithMiddleware,
  type ModelInvocationDeps,
} from "../agent/model-invocation.js";
import {
  isModelCancellationError,
  isModelTimeoutError,
} from "../agent/model-timeout-error.js";
import { createRunDeadline } from "../agent/run-deadline.js";
import { DzupAgent } from "../agent/dzip-agent.js";
import type { DzupAgentConfig } from "../agent/agent-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const model = {} as BaseChatModel;

/** A model call that never settles — the exact hang this work bounds. */
function stalledRuntime() {
  return {
    invokeModel: vi.fn(
      (
        _m: BaseChatModel,
        _msgs: BaseMessage[],
        _o?: { signal?: AbortSignal }
      ) => new Promise<BaseMessage>(() => {})
    ),
  };
}

function resolvingRuntime(text = "ok") {
  return {
    invokeModel: vi.fn(
      async (
        _m: BaseChatModel,
        _msgs: BaseMessage[],
        _o?: { signal?: AbortSignal }
      ) => new AIMessage(text) as BaseMessage
    ),
  };
}

function deps(over: Partial<ModelInvocationDeps> = {}): ModelInvocationDeps {
  return {
    agentId: "agent-1",
    tenantId: "tenant-1",
    rateLimiter: undefined,
    distributedRateLimiter: undefined,
    distributedCostLedger: undefined,
    eventBus: undefined,
    middlewareRuntime:
      resolvingRuntime() as unknown as ModelInvocationDeps["middlewareRuntime"],
    registry: undefined,
    resolvedProvider: undefined,
    getProviderAttempts: () => [],
    shouldRunFailover: () => false,
    ...over,
  } as ModelInvocationDeps;
}

// ---------------------------------------------------------------------------
// ORCH-DSL-L1-C-01 — per-call model deadline
// ---------------------------------------------------------------------------

describe("model invocation deadline (ORCH-DSL-L1-C-01)", () => {
  it("aborts a stalled model call at the configured deadline", async () => {
    const runtime = stalledRuntime();
    const d = deps({
      middlewareRuntime:
        runtime as unknown as ModelInvocationDeps["middlewareRuntime"],
      modelTimeoutMs: 40,
    });

    await expect(invokeModelWithMiddleware(d, model, [])).rejects.toSatisfy(
      isModelTimeoutError
    );
  }, 5_000);

  it("reports the deadline as a model timeout, not a tool timeout", async () => {
    const runtime = stalledRuntime();
    const d = deps({
      middlewareRuntime:
        runtime as unknown as ModelInvocationDeps["middlewareRuntime"],
      modelTimeoutMs: 40,
    });

    const err = await invokeModelWithMiddleware(d, model, []).catch(
      (e: unknown) => e
    );
    // A tool-shaped error here would mislead recovery logic that branches on
    // "retry the tool" vs "fail the turn".
    expect((err as { code?: string }).code).toBe("MODEL_TIMEOUT");
    expect((err as { toolName?: string }).toolName).toBeUndefined();
  }, 5_000);

  it("threads an abort signal into the provider call", async () => {
    const runtime = resolvingRuntime();
    const d = deps({
      middlewareRuntime:
        runtime as unknown as ModelInvocationDeps["middlewareRuntime"],
      modelTimeoutMs: 1_000,
    });

    await invokeModelWithMiddleware(d, model, []);

    const passed = runtime.invokeModel.mock.calls[0]?.[2] as
      | { signal?: AbortSignal }
      | undefined;
    expect(passed?.signal).toBeInstanceOf(AbortSignal);
    expect(passed?.signal?.aborted).toBe(false);
  });

  it("aborts in-flight when the run signal fires before the deadline", async () => {
    const controller = new AbortController();
    const runtime = stalledRuntime();
    const d = deps({
      middlewareRuntime:
        runtime as unknown as ModelInvocationDeps["middlewareRuntime"],
      modelTimeoutMs: 10_000,
      signal: controller.signal,
    });

    const pending = invokeModelWithMiddleware(d, model, []);
    controller.abort();

    await expect(pending).rejects.toSatisfy(isModelCancellationError);
  }, 5_000);

  it("rejects immediately when the run signal is already aborted", async () => {
    const runtime = stalledRuntime();
    const d = deps({
      middlewareRuntime:
        runtime as unknown as ModelInvocationDeps["middlewareRuntime"],
      signal: AbortSignal.abort(),
    });

    await expect(invokeModelWithMiddleware(d, model, [])).rejects.toSatisfy(
      isModelCancellationError
    );
    expect(runtime.invokeModel).not.toHaveBeenCalled();
  }, 5_000);

  it("leaves the call unbounded when neither bound is configured", async () => {
    const runtime = resolvingRuntime("unbounded");
    const d = deps({
      middlewareRuntime:
        runtime as unknown as ModelInvocationDeps["middlewareRuntime"],
    });

    const result = await invokeModelWithMiddleware(d, model, []);

    // Opt-out path must keep the original single-await shape: no options arg.
    expect(runtime.invokeModel.mock.calls[0]?.[2]).toBeUndefined();
    expect((result as AIMessage).content).toBe("unbounded");
  });

  it("does not fire the deadline for a call that resolves in time", async () => {
    const runtime = resolvingRuntime("fast");
    const d = deps({
      middlewareRuntime:
        runtime as unknown as ModelInvocationDeps["middlewareRuntime"],
      modelTimeoutMs: 2_000,
    });

    await expect(
      invokeModelWithMiddleware(d, model, [])
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ORCH-DSL-L1-H-02 — whole-run wall clock
// ---------------------------------------------------------------------------

describe("run deadline (ORCH-DSL-L1-H-02)", () => {
  it("returns no signal when no duration and no caller signal are set", () => {
    const d = createRunDeadline(undefined, undefined);
    expect(d.signal).toBeUndefined();
    d.dispose();
  });

  it("passes the caller signal through untouched when no duration is set", () => {
    const controller = new AbortController();
    const d = createRunDeadline(undefined, controller.signal);
    expect(d.signal).toBe(controller.signal);
    d.dispose();
  });

  it("aborts on the wall clock even when nothing else advances", async () => {
    const d = createRunDeadline(40, undefined);
    expect(d.signal?.aborted).toBe(false);

    // Real timers required: CascadingTimeout calls .unref() on its internal
    // timer, which fake timers do not model, and this test asserts a
    // *wall-clock* deadline. Bounded to 120ms against a 40ms deadline, with an
    // explicit 5s test timeout.
    // eslint-disable-next-line no-restricted-syntax -- sleep-ok: load-bearing wall-clock deadline assertion; fake timers do not model unref
    await new Promise((resolve) => setTimeout(resolve, 120));

    // This is the property maxIterations/maxTokens/maxCostCents cannot give:
    // they only tick when a call returns, and here nothing ever returns.
    expect(d.signal?.aborted).toBe(true);
    d.dispose();
  }, 5_000);

  it("aborts on the caller signal before the deadline elapses", () => {
    const controller = new AbortController();
    const d = createRunDeadline(10_000, controller.signal);

    expect(d.signal?.aborted).toBe(false);
    controller.abort();
    expect(d.signal?.aborted).toBe(true);

    d.dispose();
  });

  it("is already aborted when the caller signal was aborted up front", () => {
    const d = createRunDeadline(10_000, AbortSignal.abort());
    expect(d.signal?.aborted).toBe(true);
    d.dispose();
  });

  it("stops a stalled model call when the run deadline expires", async () => {
    const runDeadline = createRunDeadline(40, undefined);
    const runtime = stalledRuntime();
    const d = deps({
      middlewareRuntime:
        runtime as unknown as ModelInvocationDeps["middlewareRuntime"],
      ...(runDeadline.signal ? { signal: runDeadline.signal } : {}),
    });

    // No per-call deadline here: the whole-run clock alone must end it.
    await expect(invokeModelWithMiddleware(d, model, [])).rejects.toSatisfy(
      isModelCancellationError
    );
    runDeadline.dispose();
  }, 5_000);
});

// ---------------------------------------------------------------------------
// End-to-end wiring — the deadline must actually reach the running loop
// ---------------------------------------------------------------------------

/** A model whose `invoke` never settles, driven through the real agent path. */
function stalledModel(): BaseChatModel {
  return {
    invoke: vi.fn(() => new Promise<BaseMessage>(() => {})),
    bindTools: vi.fn().mockReturnThis(),
  } as unknown as BaseChatModel;
}

describe("engine bounds are wired into the real run path", () => {
  it("terminates a run whose model never responds, via guardrails.maxDurationMs", async () => {
    const agent = new DzupAgent({
      id: "bounded-agent",
      instructions: "test",
      model: stalledModel(),
      guardrails: { maxDurationMs: 150 },
    } as DzupAgentConfig);

    // Without the wiring this never settles and the test times out. That is
    // the whole point: a unit test of createRunDeadline alone passes even when
    // the deadline is not connected to anything.
    await expect(
      agent.generate([new HumanMessage("hello")])
    ).rejects.toBeDefined();
  }, 10_000);

  it("terminates a run whose model never responds, via guardrails.modelTimeoutMs", async () => {
    const agent = new DzupAgent({
      id: "bounded-agent-2",
      instructions: "test",
      model: stalledModel(),
      guardrails: { modelTimeoutMs: 150 },
    } as DzupAgentConfig);

    await expect(
      agent.generate([new HumanMessage("hello")])
    ).rejects.toBeDefined();
  }, 10_000);
});
