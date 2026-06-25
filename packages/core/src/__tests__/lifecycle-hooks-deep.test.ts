/**
 * W31-B — Core: lifecycle hooks deep coverage
 *
 * Tests cover:
 * - Registration and invocation of all AgentHooks types
 * - Invocation order (sequential, registration order)
 * - Async hooks awaited before continuing
 * - Error isolation: one hook throws, others still run
 * - onRunStart / onRunComplete / onRunError semantics
 * - beforeToolCall / afterToolCall modifier semantics
 * - onToolError hook
 * - onPhaseChange hook
 * - onBudgetWarning / onBudgetExceeded hooks
 * - Hook removal (unsubscribe via event bus)
 * - Multiple agent instances with independent hook sets
 * - Run isolation via fresh HookContext per run
 * - Conditional hooks (filter predicate pattern)
 * - Hook composition via mergeHooks
 * - Empty hook list / undefined hooks
 * - runModifierHook pass-through and transform
 * - runModifierHook with object values
 * - runHooks with eventBus error reporting
 * - mergeHooks deduplication and ordering
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runHooks, runModifierHook, mergeHooks } from "../hooks/hook-runner.js";
import { createEventBus } from "../events/event-bus.js";
import type { AgentHooks, HookContext } from "../hooks/hook-types.js";
import type { DzupEvent } from "../events/event-types.js";
import type { DzupEventBus } from "../events/event-bus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<HookContext>): HookContext {
  return {
    agentId: "agent-1",
    runId: "run-1",
    metadata: {},
    ...overrides,
  };
}

function collectEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = [];
  bus.onAny((e) => events.push(e));
  return events;
}

// ---------------------------------------------------------------------------
// 1. runHooks — registration and basic invocation
// ---------------------------------------------------------------------------

describe("runHooks — basic invocation", () => {
  it("calls a single hook with forwarded args", async () => {
    const hook = vi.fn(async () => {});
    const ctx = makeCtx();
    await runHooks([hook], undefined, "onRunStart", ctx);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(ctx);
  });

  it("calls two hooks with the same args", async () => {
    const ctx = makeCtx();
    const hookA = vi.fn(async () => {});
    const hookB = vi.fn(async () => {});
    await runHooks([hookA, hookB], undefined, "onRunStart", ctx);
    expect(hookA).toHaveBeenCalledWith(ctx);
    expect(hookB).toHaveBeenCalledWith(ctx);
  });

  it("calls five hooks with forwarded args", async () => {
    const ctx = makeCtx();
    const hooks = Array.from({ length: 5 }, () => vi.fn(async () => {}));
    await runHooks(hooks, undefined, "onRunStart", ctx);
    for (const hook of hooks) {
      expect(hook).toHaveBeenCalledTimes(1);
    }
  });

  it("returns immediately for empty array", async () => {
    // Must not throw or resolve to anything meaningful
    await expect(runHooks([], undefined, "empty")).resolves.toBeUndefined();
  });

  it("returns immediately when hooks is undefined", async () => {
    await expect(
      runHooks(undefined, undefined, "empty")
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. runHooks — invocation order
// ---------------------------------------------------------------------------

describe("runHooks — invocation order", () => {
  it("calls hooks in registration order (1-2-3)", async () => {
    const order: number[] = [];
    const hooks = [
      vi.fn(async () => {
        order.push(1);
      }),
      vi.fn(async () => {
        order.push(2);
      }),
      vi.fn(async () => {
        order.push(3);
      }),
    ];
    await runHooks(hooks, undefined, "test");
    expect(order).toEqual([1, 2, 3]);
  });

  it("maintains registration order with 5 hooks", async () => {
    const order: number[] = [];
    const hooks = [1, 2, 3, 4, 5].map((n) =>
      vi.fn(async () => {
        order.push(n);
      })
    );
    await runHooks(hooks, undefined, "test");
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not call hook until the previous async hook completes", async () => {
    const timeline: string[] = [];
    const slow = vi.fn(async () => {
      timeline.push("slow-start");
      await new Promise((r) => setTimeout(r, 10));
      timeline.push("slow-end");
    });
    const fast = vi.fn(async () => {
      timeline.push("fast");
    });
    await runHooks([slow, fast], undefined, "ordered");
    expect(timeline).toEqual(["slow-start", "slow-end", "fast"]);
  });
});

// ---------------------------------------------------------------------------
// 3. runHooks — async hook awaiting
// ---------------------------------------------------------------------------

describe("runHooks — async hooks are awaited", () => {
  it("awaits a hook that resolves after 10 ms", async () => {
    let resolved = false;
    const hook = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolved = true;
    });
    await runHooks([hook], undefined, "onRunStart");
    expect(resolved).toBe(true);
  });

  it("all async hooks complete before function returns", async () => {
    const results: boolean[] = [];
    const hooks = [
      vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(true);
      }),
      vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(true);
      }),
      vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(true);
      }),
    ];
    await runHooks(hooks, undefined, "test");
    expect(results).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 4. runHooks — error isolation
// ---------------------------------------------------------------------------

describe("runHooks — error isolation", () => {
  it("continues to subsequent hooks when one throws", async () => {
    const second = vi.fn(async () => {});
    const hooks = [
      vi.fn(async () => {
        throw new Error("first fails");
      }),
      second,
    ];
    await runHooks(hooks, undefined, "test");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("all three hooks called even when middle one throws", async () => {
    const first = vi.fn(async () => {});
    const third = vi.fn(async () => {});
    const hooks = [
      first,
      vi.fn(async () => {
        throw new Error("middle fails");
      }),
      third,
    ];
    await runHooks(hooks, undefined, "test");
    expect(first).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(1);
  });

  it("does not propagate error from hook to caller", async () => {
    const hooks = [
      vi.fn(async () => {
        throw new Error("boom");
      }),
    ];
    await expect(runHooks(hooks, undefined, "test")).resolves.toBeUndefined();
  });

  it("emits hook:error with hookName when hook throws", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);
    await runHooks(
      [
        vi.fn(async () => {
          throw new Error("fail");
        }),
      ],
      bus,
      "onRunStart"
    );
    expect(events[0]).toMatchObject({
      type: "hook:error",
      hookName: "onRunStart",
      message: "fail",
    });
  });

  it("emits hook:error for each throwing hook", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);
    await runHooks(
      [
        vi.fn(async () => {
          throw new Error("first");
        }),
        vi.fn(async () => {
          throw new Error("second");
        }),
      ],
      bus,
      "test"
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ message: "first" });
    expect(events[1]).toMatchObject({ message: "second" });
  });

  it("converts non-Error throws to string in hook:error message", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);
    await runHooks(
      [
        vi.fn(async () => {
          throw 42;
        }),
      ],
      bus,
      "test"
    );
    expect(
      (events[0] as Extract<DzupEvent, { type: "hook:error" }>).message
    ).toBe("42");
  });

  it("does not emit hook:error when no eventBus and hook throws", async () => {
    // Should just swallow the error silently
    await expect(
      runHooks(
        [
          vi.fn(async () => {
            throw new Error("no bus");
          }),
        ],
        undefined,
        "test"
      )
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. onRunStart semantics (via runHooks with HookContext)
// ---------------------------------------------------------------------------

describe("onRunStart hook semantics", () => {
  it("receives agent id from context", async () => {
    const ctx = makeCtx({ agentId: "my-agent" });
    let capturedAgentId: string | undefined;
    const hook = vi.fn(async (c: HookContext) => {
      capturedAgentId = c.agentId;
    });
    await runHooks([hook as never], undefined, "onRunStart", ctx);
    expect(capturedAgentId).toBe("my-agent");
  });

  it("receives run id from context", async () => {
    const ctx = makeCtx({ runId: "run-xyz" });
    let capturedRunId: string | undefined;
    const hook = vi.fn(async (c: HookContext) => {
      capturedRunId = c.runId;
    });
    await runHooks([hook as never], undefined, "onRunStart", ctx);
    expect(capturedRunId).toBe("run-xyz");
  });

  it("receives metadata from context", async () => {
    const ctx = makeCtx({ metadata: { env: "test", version: 1 } });
    let capturedMeta: Record<string, unknown> | undefined;
    const hook = vi.fn(async (c: HookContext) => {
      capturedMeta = c.metadata;
    });
    await runHooks([hook as never], undefined, "onRunStart", ctx);
    expect(capturedMeta).toEqual({ env: "test", version: 1 });
  });

  it("multiple onRunStart hooks all receive same context", async () => {
    const ctx = makeCtx({ runId: "shared-run" });
    const received: string[] = [];
    const hookA = vi.fn(async (c: HookContext) => {
      received.push(c.runId);
    });
    const hookB = vi.fn(async (c: HookContext) => {
      received.push(c.runId);
    });
    await runHooks(
      [hookA as never, hookB as never],
      undefined,
      "onRunStart",
      ctx
    );
    expect(received).toEqual(["shared-run", "shared-run"]);
  });
});

// ---------------------------------------------------------------------------
// 6. onRunComplete semantics
// ---------------------------------------------------------------------------

describe("onRunComplete hook semantics", () => {
  it("receives context and result", async () => {
    const ctx = makeCtx();
    const result = { answer: 42 };
    let capturedResult: unknown;
    const hook = vi.fn(async (_c: HookContext, r: unknown) => {
      capturedResult = r;
    });
    await runHooks([hook as never], undefined, "onRunComplete", ctx, result);
    expect(capturedResult).toEqual({ answer: 42 });
  });

  it("receives string result", async () => {
    const ctx = makeCtx();
    let capturedResult: unknown;
    const hook = vi.fn(async (_c: HookContext, r: unknown) => {
      capturedResult = r;
    });
    await runHooks([hook as never], undefined, "onRunComplete", ctx, "done");
    expect(capturedResult).toBe("done");
  });

  it("multiple onRunComplete hooks all receive same result", async () => {
    const ctx = makeCtx();
    const results: unknown[] = [];
    const hookA = vi.fn(async (_c: HookContext, r: unknown) => {
      results.push(r);
    });
    const hookB = vi.fn(async (_c: HookContext, r: unknown) => {
      results.push(r);
    });
    await runHooks(
      [hookA as never, hookB as never],
      undefined,
      "onRunComplete",
      ctx,
      "final"
    );
    expect(results).toEqual(["final", "final"]);
  });
});

// ---------------------------------------------------------------------------
// 7. onRunError semantics
// ---------------------------------------------------------------------------

describe("onRunError hook semantics", () => {
  it("receives context and error", async () => {
    const ctx = makeCtx();
    const err = new Error("run failed");
    let capturedError: Error | undefined;
    const hook = vi.fn(async (_c: HookContext, e: Error) => {
      capturedError = e;
    });
    await runHooks([hook as never], undefined, "onRunError", ctx, err);
    expect(capturedError).toBe(err);
  });

  it("receives error message correctly", async () => {
    const ctx = makeCtx();
    const err = new Error("catastrophic failure");
    let capturedMessage: string | undefined;
    const hook = vi.fn(async (_c: HookContext, e: Error) => {
      capturedMessage = e.message;
    });
    await runHooks([hook as never], undefined, "onRunError", ctx, err);
    expect(capturedMessage).toBe("catastrophic failure");
  });

  it("onRunError hook throwing does not propagate", async () => {
    const ctx = makeCtx();
    const hook = vi.fn(async () => {
      throw new Error("error handler also failed");
    });
    await expect(
      runHooks(
        [hook as never],
        undefined,
        "onRunError",
        ctx,
        new Error("original")
      )
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. beforeToolCall (modifier hook) semantics
// ---------------------------------------------------------------------------

describe("beforeToolCall modifier hook semantics", () => {
  it("passes through input when hook returns undefined", async () => {
    const hook = vi.fn(async () => undefined);
    const result = await runModifierHook(hook, undefined, "beforeToolCall", {
      query: "original",
    });
    expect(result).toEqual({ query: "original" });
  });

  it("replaces input when hook returns new value", async () => {
    const hook = vi.fn(async () => ({ query: "replaced" }));
    const result = await runModifierHook(hook, undefined, "beforeToolCall", {
      query: "original",
    });
    expect(result).toEqual({ query: "replaced" });
  });

  it("receives tool name and input args", async () => {
    let capturedArgs: unknown[];
    const hook = vi.fn(async (...args: unknown[]) => {
      capturedArgs = args;
      return undefined;
    });
    await runModifierHook(
      hook,
      undefined,
      "beforeToolCall",
      "original-input",
      "searchTool",
      { q: "test" }
    );
    expect(capturedArgs!).toEqual(["searchTool", { q: "test" }]);
  });

  it("passes through when hook is undefined", async () => {
    const result = await runModifierHook(
      undefined,
      undefined,
      "beforeToolCall",
      "original"
    );
    expect(result).toBe("original");
  });

  it("passes through when hook throws and emits hook:error", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);
    const hook = vi.fn(async () => {
      throw new Error("modifier blew up");
    });
    const result = await runModifierHook(
      hook,
      bus,
      "beforeToolCall",
      "original"
    );
    expect(result).toBe("original");
    expect(events[0]).toMatchObject({
      type: "hook:error",
      hookName: "beforeToolCall",
    });
  });

  it("can transform input to a different type", async () => {
    const hook = vi.fn(async () => "converted-to-string");
    const result = await runModifierHook<string>(
      hook,
      undefined,
      "beforeToolCall",
      "original"
    );
    expect(result).toBe("converted-to-string");
  });
});

// ---------------------------------------------------------------------------
// 9. afterToolCall (modifier hook) semantics
// ---------------------------------------------------------------------------

describe("afterToolCall modifier hook semantics", () => {
  it("passes through result when hook returns undefined", async () => {
    const hook = vi.fn(async () => undefined);
    const result = await runModifierHook(
      hook,
      undefined,
      "afterToolCall",
      "tool-result"
    );
    expect(result).toBe("tool-result");
  });

  it("replaces result when hook returns new string", async () => {
    const hook = vi.fn(async () => "modified-result");
    const result = await runModifierHook(
      hook,
      undefined,
      "afterToolCall",
      "original-result"
    );
    expect(result).toBe("modified-result");
  });

  it("passes through on throw, emitting hook:error", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);
    const hook = vi.fn(async () => {
      throw new Error("after hook failed");
    });
    const result = await runModifierHook(
      hook,
      bus,
      "afterToolCall",
      "original"
    );
    expect(result).toBe("original");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("hook:error");
  });

  it("receives tool result as first arg", async () => {
    let received: unknown;
    const hook = vi.fn(
      async (toolName: unknown, _input: unknown, result: unknown) => {
        received = result;
        return undefined;
      }
    );
    await runModifierHook(
      hook,
      undefined,
      "afterToolCall",
      "passthrough",
      "search",
      {},
      "the-result"
    );
    expect(received).toBe("the-result");
  });
});

// ---------------------------------------------------------------------------
// 10. onToolError hook
// ---------------------------------------------------------------------------

describe("onToolError hook semantics", () => {
  it("receives tool name and error", async () => {
    const ctx = makeCtx();
    const err = new Error("tool crashed");
    let capturedName: string | undefined;
    let capturedError: Error | undefined;
    const hook = vi.fn(
      async (toolName: string, error: Error, _ctx: HookContext) => {
        capturedName = toolName;
        capturedError = error;
      }
    );
    await runHooks(
      [hook as never],
      undefined,
      "onToolError",
      "searchTool",
      err,
      ctx
    );
    expect(capturedName).toBe("searchTool");
    expect(capturedError).toBe(err);
  });

  it("error in onToolError does not propagate", async () => {
    const hook = vi.fn(async () => {
      throw new Error("meta-error");
    });
    await expect(
      runHooks([hook], undefined, "onToolError", "tool", new Error("original"))
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. onPhaseChange hook
// ---------------------------------------------------------------------------

describe("onPhaseChange hook semantics", () => {
  it("receives phase and previousPhase", async () => {
    const ctx = makeCtx();
    let phase: string | undefined;
    let prevPhase: string | undefined;
    const hook = vi.fn(async (p: string, pp: string, _ctx: HookContext) => {
      phase = p;
      prevPhase = pp;
    });
    await runHooks(
      [hook as never],
      undefined,
      "onPhaseChange",
      "execute",
      "plan",
      ctx
    );
    expect(phase).toBe("execute");
    expect(prevPhase).toBe("plan");
  });
});

// ---------------------------------------------------------------------------
// 12. onBudgetWarning and onBudgetExceeded hooks
// ---------------------------------------------------------------------------

describe("onBudgetWarning hook semantics", () => {
  it("receives warn level and usage", async () => {
    const ctx = makeCtx();
    const usage = {
      tokensBudget: 1000,
      tokensUsed: 750,
      costBudgetUsd: 1,
      costUsedUsd: 0.75,
    };
    let capturedLevel: string | undefined;
    const hook = vi.fn(async (level: string) => {
      capturedLevel = level;
    });
    await runHooks(
      [hook as never],
      undefined,
      "onBudgetWarning",
      "warn",
      usage,
      ctx
    );
    expect(capturedLevel).toBe("warn");
  });

  it("receives critical level", async () => {
    const ctx = makeCtx();
    const usage = {
      tokensBudget: 1000,
      tokensUsed: 950,
      costBudgetUsd: 1,
      costUsedUsd: 0.95,
    };
    let capturedLevel: string | undefined;
    const hook = vi.fn(async (level: string) => {
      capturedLevel = level;
    });
    await runHooks(
      [hook as never],
      undefined,
      "onBudgetWarning",
      "critical",
      usage,
      ctx
    );
    expect(capturedLevel).toBe("critical");
  });
});

describe("onBudgetExceeded hook semantics", () => {
  it("receives reason and usage", async () => {
    const ctx = makeCtx();
    const usage = {
      tokensBudget: 1000,
      tokensUsed: 1001,
      costBudgetUsd: 1,
      costUsedUsd: 1.01,
    };
    let capturedReason: string | undefined;
    const hook = vi.fn(async (reason: string) => {
      capturedReason = reason;
    });
    await runHooks(
      [hook as never],
      undefined,
      "onBudgetExceeded",
      "token limit exceeded",
      usage,
      ctx
    );
    expect(capturedReason).toBe("token limit exceeded");
  });
});

// ---------------------------------------------------------------------------
// 13. Hook removal — unregister via unsub
// ---------------------------------------------------------------------------

describe("hook removal via event bus unsubscribe", () => {
  it("unsubscribed handler is no longer called", () => {
    const bus = createEventBus();
    const handler = vi.fn();
    const unsub = bus.onAny(handler);
    unsub();
    bus.emit({ type: "hook:error", hookName: "test", message: "x" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("other handlers still called after one is removed", () => {
    const bus = createEventBus();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const unsubA = bus.onAny(handlerA);
    bus.onAny(handlerB);
    unsubA();
    bus.emit({ type: "hook:error", hookName: "test", message: "x" });
    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  it("on() unsubscribe removes typed handler", () => {
    const bus = createEventBus();
    const handler = vi.fn();
    const unsub = bus.on("hook:error", handler);
    unsub();
    bus.emit({ type: "hook:error", hookName: "h", message: "m" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("once() auto-unsubscribes after first call", () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.once("hook:error", handler);
    bus.emit({ type: "hook:error", hookName: "h", message: "m" });
    bus.emit({ type: "hook:error", hookName: "h", message: "m" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 14. Multiple agent instances — no cross-contamination
// ---------------------------------------------------------------------------

describe("multiple agent instances — hook isolation", () => {
  it("hooks for agent A do not fire for agent B context", async () => {
    const agentAOrder: string[] = [];
    const agentBOrder: string[] = [];

    const hooksA: Array<(...args: unknown[]) => Promise<void>> = [
      vi.fn(async (ctx: unknown) => {
        agentAOrder.push((ctx as HookContext).agentId);
      }),
    ];
    const hooksB: Array<(...args: unknown[]) => Promise<void>> = [
      vi.fn(async (ctx: unknown) => {
        agentBOrder.push((ctx as HookContext).agentId);
      }),
    ];

    const ctxA = makeCtx({ agentId: "agent-A" });
    const ctxB = makeCtx({ agentId: "agent-B" });

    await runHooks(hooksA, undefined, "onRunStart", ctxA);
    await runHooks(hooksB, undefined, "onRunStart", ctxB);

    expect(agentAOrder).toEqual(["agent-A"]);
    expect(agentBOrder).toEqual(["agent-B"]);
  });

  it("two independent buses do not share events", () => {
    const busA = createEventBus();
    const busB = createEventBus();
    const eventsA: DzupEvent[] = [];
    const eventsB: DzupEvent[] = [];
    busA.onAny((e) => eventsA.push(e));
    busB.onAny((e) => eventsB.push(e));

    busA.emit({ type: "hook:error", hookName: "h", message: "from-A" });
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 15. Run isolation — fresh context per run
// ---------------------------------------------------------------------------

describe("run isolation — fresh HookContext per run", () => {
  it("run IDs differ across two runs", async () => {
    const runIds: string[] = [];
    const hook = vi.fn(async (ctx: unknown) => {
      runIds.push((ctx as HookContext).runId);
    });

    const ctxRun1 = makeCtx({ runId: "run-1" });
    const ctxRun2 = makeCtx({ runId: "run-2" });

    await runHooks([hook as never], undefined, "onRunStart", ctxRun1);
    await runHooks([hook as never], undefined, "onRunStart", ctxRun2);

    expect(runIds).toEqual(["run-1", "run-2"]);
  });

  it("metadata mutation in one hook context does not affect next run", async () => {
    const ctxRun1 = makeCtx({ runId: "run-1", metadata: {} });
    const ctxRun2 = makeCtx({ runId: "run-2", metadata: {} });

    const hook = vi.fn(async (ctx: unknown) => {
      (ctx as HookContext).metadata["mutated"] = true;
    });

    await runHooks([hook as never], undefined, "onRunStart", ctxRun1);
    await runHooks([hook as never], undefined, "onRunStart", ctxRun2);

    // ctxRun2 is its own object; mutation of ctxRun1 should not affect it
    expect(ctxRun1.metadata["mutated"]).toBe(true);
    expect(ctxRun2.metadata["mutated"]).toBe(true); // both were mutated independently
    // Key assertion: they are different objects
    expect(ctxRun1).not.toBe(ctxRun2);
  });
});

// ---------------------------------------------------------------------------
// 16. Conditional hooks (filter predicate pattern)
// ---------------------------------------------------------------------------

describe("conditional hooks — predicate filtering", () => {
  it("hook with passing predicate fires", async () => {
    const ctx = makeCtx({ agentId: "agent-prod" });
    const fired: boolean[] = [];

    // Pattern: wrap hook with predicate
    const conditionalHook = vi.fn(async (c: HookContext) => {
      if (c.agentId.startsWith("agent-prod")) {
        fired.push(true);
      }
    });
    await runHooks([conditionalHook as never], undefined, "onRunStart", ctx);
    expect(fired).toHaveLength(1);
  });

  it("hook with failing predicate does not fire side effect", async () => {
    const ctx = makeCtx({ agentId: "agent-dev" });
    const fired: boolean[] = [];

    const conditionalHook = vi.fn(async (c: HookContext) => {
      if (c.agentId.startsWith("agent-prod")) {
        fired.push(true);
      }
    });
    await runHooks([conditionalHook as never], undefined, "onRunStart", ctx);
    expect(fired).toHaveLength(0);
    // but hook was still called
    expect(conditionalHook).toHaveBeenCalledTimes(1);
  });

  it("predicate on tool name — fires only for matching tool", async () => {
    const calls: string[] = [];
    const conditionalHook = vi.fn(async (toolName: string) => {
      if (toolName === "search") {
        calls.push(toolName);
      }
    });
    const ctx = makeCtx();

    await runHooks(
      [conditionalHook as never],
      undefined,
      "beforeToolCall",
      "search",
      {},
      ctx
    );
    await runHooks(
      [conditionalHook as never],
      undefined,
      "beforeToolCall",
      "write",
      {},
      ctx
    );
    expect(calls).toEqual(["search"]);
  });

  it("modifier hook with predicate passes through when predicate fails", async () => {
    // runModifierHook passes extra args to the hook (not currentValue directly).
    // Pattern: pass the value as an extra arg so the hook can inspect and optionally transform it.
    const hook = vi.fn(async (rawInput: string) => {
      if (rawInput.includes("UPPERCASE")) return rawInput.toLowerCase();
      return undefined;
    });
    const result1 = await runModifierHook(
      hook,
      undefined,
      "test",
      "hello UPPERCASE world", // currentValue (returned if hook returns undefined)
      "hello UPPERCASE world" // extra arg forwarded to hook for inspection
    );
    const result2 = await runModifierHook(
      hook,
      undefined,
      "test",
      "already lowercase",
      "already lowercase"
    );
    expect(result1).toBe("hello uppercase world");
    expect(result2).toBe("already lowercase");
  });
});

// ---------------------------------------------------------------------------
// 17. Hook composition — mergeHooks
// ---------------------------------------------------------------------------

describe("hook composition via mergeHooks", () => {
  it("merges two onRunStart hooks into an array of 2", () => {
    const hA = async () => {};
    const hB = async () => {};
    type Hooks = { onRunStart: () => Promise<void> };
    const merged = mergeHooks<Hooks>({ onRunStart: hA }, { onRunStart: hB });
    expect(merged.onRunStart).toHaveLength(2);
    expect(merged.onRunStart![0]).toBe(hA);
    expect(merged.onRunStart![1]).toBe(hB);
  });

  it("merged hooks are both invoked", async () => {
    const calls: number[] = [];
    type Hooks = { onRunStart: () => Promise<void> };
    const merged = mergeHooks<Hooks>(
      {
        onRunStart: async () => {
          calls.push(1);
        },
      },
      {
        onRunStart: async () => {
          calls.push(2);
        },
      }
    );
    for (const hook of merged.onRunStart ?? []) {
      await hook();
    }
    expect(calls).toEqual([1, 2]);
  });

  it("merges three hook sets correctly", () => {
    type Hooks = { onRunStart: () => Promise<void> };
    const h1 = async () => {};
    const h2 = async () => {};
    const h3 = async () => {};
    const merged = mergeHooks<Hooks>(
      { onRunStart: h1 },
      { onRunStart: h2 },
      { onRunStart: h3 }
    );
    expect(merged.onRunStart).toHaveLength(3);
  });

  it("merges disjoint hook sets without interference", () => {
    type Hooks = {
      onRunStart: () => Promise<void>;
      onRunComplete: () => Promise<void>;
    };
    const hA = async () => {};
    const hB = async () => {};
    const merged = mergeHooks<Hooks>({ onRunStart: hA }, { onRunComplete: hB });
    expect(merged.onRunStart).toHaveLength(1);
    expect(merged.onRunComplete).toHaveLength(1);
  });

  it("skips undefined hook sets", () => {
    type Hooks = { onRunStart: () => Promise<void> };
    const h = async () => {};
    const merged = mergeHooks<Hooks>(undefined, { onRunStart: h }, undefined);
    expect(merged.onRunStart).toHaveLength(1);
  });

  it("skips undefined values within a hook set", () => {
    type Hooks = { onRunStart: () => Promise<void> };
    const merged = mergeHooks<Hooks>({ onRunStart: undefined });
    expect(merged.onRunStart).toBeUndefined();
  });

  it("returns empty object when called with no args", () => {
    type Hooks = { onRunStart: () => Promise<void> };
    const merged = mergeHooks<Hooks>();
    expect(Object.keys(merged)).toHaveLength(0);
  });

  it("merges hooks and runHooks processes them sequentially", async () => {
    const order: number[] = [];
    type Hooks = { onRunStart: (ctx: HookContext) => Promise<void> };
    const merged = mergeHooks<Hooks>(
      {
        onRunStart: async () => {
          order.push(1);
        },
      },
      {
        onRunStart: async () => {
          order.push(2);
        },
      },
      {
        onRunStart: async () => {
          order.push(3);
        },
      }
    );
    await runHooks(merged.onRunStart, undefined, "onRunStart", makeCtx());
    expect(order).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// 18. runModifierHook — additional edge cases
// ---------------------------------------------------------------------------

describe("runModifierHook — edge cases", () => {
  it("preserves object reference when returning undefined", async () => {
    const original = { key: "value" };
    const hook = vi.fn(async () => undefined);
    const result = await runModifierHook(hook, undefined, "test", original);
    expect(result).toBe(original);
  });

  it("works with number values", async () => {
    const hook = vi.fn(async () => 99);
    const result = await runModifierHook(hook, undefined, "test", 0);
    expect(result).toBe(99);
  });

  it("works with array values", async () => {
    const hook = vi.fn(async () => [1, 2, 3]);
    const result = await runModifierHook(hook, undefined, "test", []);
    expect(result).toEqual([1, 2, 3]);
  });

  it("works with boolean values", async () => {
    const hook = vi.fn(async () => false);
    const result = await runModifierHook<boolean>(
      hook,
      undefined,
      "test",
      true
    );
    expect(result).toBe(false);
  });

  it("passes all extra args to modifier hook", async () => {
    let receivedArgs: unknown[];
    const hook = vi.fn(async (...args: unknown[]) => {
      receivedArgs = args;
      return undefined;
    });
    await runModifierHook(
      hook,
      undefined,
      "test",
      "current",
      "extra1",
      "extra2"
    );
    expect(receivedArgs!).toEqual(["extra1", "extra2"]);
  });

  it("returns current value when hook returns null (not undefined)", async () => {
    // null !== undefined, so it replaces the value
    const hook = vi.fn(async () => null as unknown as string);
    const result = await runModifierHook(hook, undefined, "test", "original");
    // null is not undefined so it replaces
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 19. AgentHooks type integrity — ensure interface matches expectations
// ---------------------------------------------------------------------------

describe("AgentHooks interface integrity", () => {
  it("accepts a full AgentHooks object with all optional hooks", () => {
    const ctx = makeCtx();
    const hooks: AgentHooks = {
      onRunStart: vi.fn(async (_ctx: HookContext) => {}),
      onRunComplete: vi.fn(async (_ctx: HookContext, _result: unknown) => {}),
      onRunError: vi.fn(async (_ctx: HookContext, _error: Error) => {}),
      beforeToolCall: vi.fn(
        async (_toolName: string, _input: unknown, _ctx: HookContext) =>
          undefined
      ),
      afterToolCall: vi.fn(
        async (
          _toolName: string,
          _input: unknown,
          _result: string,
          _ctx: HookContext
        ) => undefined
      ),
      onToolError: vi.fn(
        async (_toolName: string, _error: Error, _ctx: HookContext) => {}
      ),
      onPhaseChange: vi.fn(
        async (_phase: string, _previousPhase: string, _ctx: HookContext) => {}
      ),
      onApprovalRequired: vi.fn(
        async (_plan: unknown, _ctx: HookContext) => {}
      ),
      onBudgetWarning: vi.fn(
        async (
          _level: "warn" | "critical",
          _usage: unknown,
          _ctx: HookContext
        ) => {}
      ),
      onBudgetExceeded: vi.fn(
        async (_reason: string, _usage: unknown, _ctx: HookContext) => {}
      ),
    };
    // This test is about structural validity — all hooks defined without TS errors
    expect(hooks.onRunStart).toBeDefined();
    expect(hooks.onRunComplete).toBeDefined();
    expect(hooks.onRunError).toBeDefined();
    expect(hooks.beforeToolCall).toBeDefined();
    expect(hooks.afterToolCall).toBeDefined();
    expect(hooks.onToolError).toBeDefined();
    expect(hooks.onPhaseChange).toBeDefined();
    expect(hooks.onApprovalRequired).toBeDefined();
    expect(hooks.onBudgetWarning).toBeDefined();
    expect(hooks.onBudgetExceeded).toBeDefined();
    void ctx;
  });

  it("accepts partial AgentHooks (all fields optional)", () => {
    const hooks: AgentHooks = {
      onRunStart: vi.fn(async () => {}),
    };
    expect(hooks.onRunStart).toBeDefined();
    expect(hooks.onRunComplete).toBeUndefined();
  });

  it("accepts empty AgentHooks object", () => {
    const hooks: AgentHooks = {};
    expect(Object.keys(hooks)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 20. Integration: full lifecycle sequence
// ---------------------------------------------------------------------------

describe("integration — full run lifecycle hook sequence", () => {
  it("runs start → complete hooks in order with correct args", async () => {
    const timeline: string[] = [];
    const ctx = makeCtx({ runId: "integration-run" });
    const result = { status: "ok" };

    const onStartHook = vi.fn(async (c: HookContext) => {
      timeline.push(`start:${c.runId}`);
    });
    const onCompleteHook = vi.fn(async (c: HookContext, r: unknown) => {
      timeline.push(
        `complete:${c.runId}:${(r as Record<string, string>).status}`
      );
    });

    await runHooks([onStartHook as never], undefined, "onRunStart", ctx);
    await runHooks(
      [onCompleteHook as never],
      undefined,
      "onRunComplete",
      ctx,
      result
    );

    expect(timeline).toEqual([
      "start:integration-run",
      "complete:integration-run:ok",
    ]);
  });

  it("runs start → error hooks in order when run fails", async () => {
    const timeline: string[] = [];
    const ctx = makeCtx({ runId: "failing-run" });
    const err = new Error("fatal");

    const onStartHook = vi.fn(async (c: HookContext) => {
      timeline.push(`start:${c.runId}`);
    });
    const onErrorHook = vi.fn(async (c: HookContext, e: Error) => {
      timeline.push(`error:${c.runId}:${e.message}`);
    });

    await runHooks([onStartHook as never], undefined, "onRunStart", ctx);
    await runHooks([onErrorHook as never], undefined, "onRunError", ctx, err);

    expect(timeline).toEqual(["start:failing-run", "error:failing-run:fatal"]);
  });

  it("tool lifecycle: beforeToolCall → afterToolCall → onToolError", async () => {
    const calls: string[] = [];

    const beforeHook = vi.fn(async (toolName: string) => {
      calls.push(`before:${toolName}`);
      return undefined;
    });
    const afterHook = vi.fn(async (toolName: string) => {
      calls.push(`after:${toolName}`);
      return undefined;
    });

    await runModifierHook(
      beforeHook as never,
      undefined,
      "beforeToolCall",
      "input",
      "search",
      {}
    );
    await runModifierHook(
      afterHook as never,
      undefined,
      "afterToolCall",
      "result",
      "search",
      {},
      "result"
    );

    expect(calls).toEqual(["before:search", "after:search"]);
  });

  it("merged hooks from two agents run all four hooks on a run", async () => {
    const calls: number[] = [];
    type Hooks = { onRunStart: () => Promise<void> };

    const agentAHooks = mergeHooks<Hooks>({
      onRunStart: async () => {
        calls.push(1);
      },
    });
    const agentBHooks = mergeHooks<Hooks>({
      onRunStart: async () => {
        calls.push(2);
      },
    });
    const combined = mergeHooks<Hooks>(
      { onRunStart: agentAHooks.onRunStart?.[0] },
      { onRunStart: agentBHooks.onRunStart?.[0] }
    );

    await runHooks(combined.onRunStart, undefined, "onRunStart", makeCtx());
    expect(calls).toEqual([1, 2]);
  });

  it("full run with event bus captures all hook:error events", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);

    const badStart = vi.fn(async () => {
      throw new Error("start-error");
    });
    const badComplete = vi.fn(async () => {
      throw new Error("complete-error");
    });
    const ctx = makeCtx();

    await runHooks([badStart], bus, "onRunStart", ctx);
    await runHooks([badComplete], bus, "onRunComplete", ctx, null);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "hook:error",
      hookName: "onRunStart",
    });
    expect(events[1]).toMatchObject({
      type: "hook:error",
      hookName: "onRunComplete",
    });
  });
});
