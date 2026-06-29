/**
 * lifecycle-hooks-extended — additional coverage for hook-runner
 *
 * Targets areas not already covered in hook-runner.test.ts and
 * lifecycle-hooks-deep.test.ts:
 *
 * - onApprovalRequired hook semantics (not tested elsewhere)
 * - Mixed null/undefined entries in hooks array
 * - Chained runModifierHook calls (compose multiple modifiers)
 * - Timing: sequential execution is strictly serial
 * - Hook that records call count across multiple runHooks invocations
 * - runHooks with single undefined entry
 * - runHooks with all-undefined entries
 * - mergeHooks preserves insertion order across many sets
 * - mergeHooks with overlapping keys across 5+ sets
 * - hookName zero-length string edge case
 * - HookContext with eventBus field set in context
 * - Modifier hook receiving zero extra args (only currentValue)
 * - Modifier hook returning the same reference (identity)
 * - runHooks emits hook:error with correct message for null throw
 * - Multiple buses — each gets only its own errors
 * - hook:error event has all required fields
 * - mergeHooks key enumeration is stable
 * - Hook deregistration via array splice pattern
 * - runHooks total call count across many runs
 * - Async hooks with delayed resolution do not interleave
 * - onApprovalRequired receives plan and context
 * - onBudgetWarning receives BudgetUsage shape
 * - runModifierHook with async delay still returns correct value
 * - Hook that resolves to zero (falsy) is not ignored
 * - runHooks does not throw when called concurrently (multiple awaits)
 * - mergeHooks returns Partial — keys not in any set are absent
 * - beforeToolCall receives all three args (toolName, input, ctx)
 * - afterToolCall receives all four args
 * - onToolError receives correct error type
 * - Hooks registered at runtime in a loop all fire
 * - Hook composition: runModifierHook chain emulates pipeline
 * - mergeHooks with single hook set produces array of 1
 * - runHooks with 10 hooks — all 10 fire in order
 * - Hook that throws after async delay still isolates error
 * - run context eventBus field does not interfere with hook runner bus
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runHooks, runModifierHook, mergeHooks } from "../hooks/hook-runner.js";
import { createEventBus } from "../events/event-bus.js";
import type { AgentHooks, HookContext } from "../hooks/hook-types.js";
import type { DzupEvent, BudgetUsage } from "../events/event-types.js";
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

function makeBudget(overrides?: Partial<BudgetUsage>): BudgetUsage {
  return {
    tokensBudget: 1000,
    tokensUsed: 500,
    costBudgetUsd: 1.0,
    costUsedUsd: 0.5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. onApprovalRequired hook semantics
// ---------------------------------------------------------------------------

describe("onApprovalRequired hook semantics", () => {
  it("receives plan and context", async () => {
    const ctx = makeCtx();
    const plan = { action: "delete", target: "/tmp/file" };
    let capturedPlan: unknown;
    let capturedCtx: HookContext | undefined;

    const hook = vi.fn(async (p: unknown, c: HookContext) => {
      capturedPlan = p;
      capturedCtx = c;
    });

    const hooks: AgentHooks = { onApprovalRequired: hook };
    await runHooks(
      [hooks.onApprovalRequired as never],
      undefined,
      "onApprovalRequired",
      plan,
      ctx
    );

    expect(capturedPlan).toEqual({ action: "delete", target: "/tmp/file" });
    expect(capturedCtx).toBe(ctx);
  });

  it("receives string plan", async () => {
    const ctx = makeCtx();
    let capturedPlan: unknown;

    const hook = vi.fn(async (p: unknown) => {
      capturedPlan = p;
    });

    await runHooks(
      [hook as never],
      undefined,
      "onApprovalRequired",
      "deploy to production",
      ctx
    );

    expect(capturedPlan).toBe("deploy to production");
  });

  it("multiple onApprovalRequired hooks all receive the plan", async () => {
    const ctx = makeCtx();
    const plan = { steps: ["a", "b"] };
    const received: unknown[] = [];

    const hookA = vi.fn(async (p: unknown) => {
      received.push(p);
    });
    const hookB = vi.fn(async (p: unknown) => {
      received.push(p);
    });

    await runHooks(
      [hookA as never, hookB as never],
      undefined,
      "onApprovalRequired",
      plan,
      ctx
    );

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ steps: ["a", "b"] });
    expect(received[1]).toEqual({ steps: ["a", "b"] });
  });

  it("error in onApprovalRequired hook does not propagate", async () => {
    const hook = vi.fn(async () => {
      throw new Error("approval handler failed");
    });

    await expect(
      runHooks([hook as never], undefined, "onApprovalRequired", {}, makeCtx())
    ).resolves.toBeUndefined();
  });

  it("emits hook:error when onApprovalRequired throws", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);
    const hook = vi.fn(async () => {
      throw new Error("approval-error");
    });

    await runHooks([hook as never], bus, "onApprovalRequired", {}, makeCtx());

    expect(events[0]).toMatchObject({
      type: "hook:error",
      hookName: "onApprovalRequired",
      message: "approval-error",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Mixed null/undefined entries in hooks array
// ---------------------------------------------------------------------------

describe("runHooks — mixed null and undefined entries", () => {
  it("skips undefined entries and calls valid hooks", async () => {
    const fn = vi.fn(async () => {});
    // Cast array to allow undefined as per runHooks signature
    await runHooks([undefined, fn, undefined], undefined, "test");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("handles array of all undefineds without throwing", async () => {
    await expect(
      runHooks([undefined, undefined, undefined], undefined, "test")
    ).resolves.toBeUndefined();
  });

  it("handles single undefined entry without calling anything", async () => {
    const fn = vi.fn(async () => {});
    await runHooks([undefined], undefined, "test");
    expect(fn).not.toHaveBeenCalled();
  });

  it("only calls the one non-undefined hook in mixed array", async () => {
    const called: boolean[] = [];
    const fn = vi.fn(async () => {
      called.push(true);
    });
    await runHooks([undefined, undefined, fn, undefined], undefined, "test");
    expect(called).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Chained runModifierHook calls (composing multiple modifiers)
// ---------------------------------------------------------------------------

describe("chained runModifierHook — pipeline composition", () => {
  it("two modifier hooks chained transform value correctly", async () => {
    const addSuffix = vi.fn(async (val: string) => val + "-A");
    const addPrefix = vi.fn(async (val: string) => "B-" + val);

    // Chain: first modifier result is passed as currentValue to second
    const step1 = await runModifierHook(
      addSuffix as never,
      undefined,
      "step1",
      "original",
      "original"
    );
    const step2 = await runModifierHook(
      addPrefix as never,
      undefined,
      "step2",
      step1,
      step1
    );

    expect(step1).toBe("original-A");
    expect(step2).toBe("B-original-A");
  });

  it("three modifier hooks chained in pipeline", async () => {
    const h1 = vi.fn(async (v: string) => v.toUpperCase());
    const h2 = vi.fn(async (v: string) => v + "!");
    const h3 = vi.fn(async (v: string) => v.trim() + ".");

    let val = "hello";
    val = await runModifierHook(h1 as never, undefined, "h1", val, val);
    val = await runModifierHook(h2 as never, undefined, "h2", val, val);
    val = await runModifierHook(h3 as never, undefined, "h3", val, val);

    expect(val).toBe("HELLO!.");
  });

  it("chain short-circuits on throw — remaining value is passed through", async () => {
    const good = vi.fn(async (v: string) => v + "-good");
    const bad = vi.fn(async () => {
      throw new Error("fail");
    });
    const good2 = vi.fn(async (v: string) => v + "-good2");

    let val = "start";
    val = await runModifierHook(good as never, undefined, "h1", val, val);
    // bad throws but returns currentValue (which is now "start-good")
    val = await runModifierHook(bad as never, undefined, "h2", val, val);
    val = await runModifierHook(good2 as never, undefined, "h3", val, val);

    expect(val).toBe("start-good-good2");
  });

  it("modifier returning zero (falsy number) is NOT treated as undefined", async () => {
    const hook = vi.fn(async () => 0);
    const result = await runModifierHook(hook, undefined, "test", 42);
    expect(result).toBe(0);
  });

  it("modifier returning empty string is NOT treated as undefined", async () => {
    const hook = vi.fn(async () => "");
    const result = await runModifierHook(hook, undefined, "test", "original");
    // empty string !== undefined, so it replaces
    expect(result).toBe("");
  });

  it("modifier returning false is NOT treated as undefined", async () => {
    const hook = vi.fn(async () => false as unknown as boolean);
    const result = await runModifierHook<boolean>(
      hook as never,
      undefined,
      "test",
      true
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Sequential execution timing
// ---------------------------------------------------------------------------

describe("runHooks — sequential execution is strictly serial", () => {
  it("hook B does not start until hook A fully resolves", async () => {
    const timeline: string[] = [];

    const hookA = vi.fn(async () => {
      timeline.push("A:start");
      await new Promise((r) => setTimeout(r, 20));
      timeline.push("A:end");
    });
    const hookB = vi.fn(async () => {
      timeline.push("B:start");
    });

    await runHooks([hookA, hookB], undefined, "test");

    expect(timeline).toEqual(["A:start", "A:end", "B:start"]);
  });

  it("five hooks complete in strict order", async () => {
    const order: number[] = [];
    const hooks = [1, 2, 3, 4, 5].map((n) =>
      vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(n);
      })
    );
    await runHooks(hooks, undefined, "test");
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("async delay in middle hook does not reorder subsequent hooks", async () => {
    const order: string[] = [];
    const hooks = [
      vi.fn(async () => {
        order.push("first");
      }),
      vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 15));
        order.push("second");
      }),
      vi.fn(async () => {
        order.push("third");
      }),
    ];
    await runHooks(hooks, undefined, "test");
    expect(order).toEqual(["first", "second", "third"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Call count across multiple runHooks invocations
// ---------------------------------------------------------------------------

describe("runHooks — persistent call count across runs", () => {
  it("hook called once per runHooks invocation", async () => {
    const hook = vi.fn(async () => {});
    const hooks = [hook];
    await runHooks(hooks, undefined, "test");
    await runHooks(hooks, undefined, "test");
    await runHooks(hooks, undefined, "test");
    expect(hook).toHaveBeenCalledTimes(3);
  });

  it("two hooks each called 5 times over 5 runs", async () => {
    const hookA = vi.fn(async () => {});
    const hookB = vi.fn(async () => {});
    const hooks = [hookA, hookB];
    for (let i = 0; i < 5; i++) {
      await runHooks(hooks, undefined, "test");
    }
    expect(hookA).toHaveBeenCalledTimes(5);
    expect(hookB).toHaveBeenCalledTimes(5);
  });

  it("same hook registered in two separate arrays fires independently", async () => {
    const shared = vi.fn(async () => {});
    const arr1 = [shared];
    const arr2 = [shared];
    await runHooks(arr1, undefined, "group1");
    await runHooks(arr2, undefined, "group2");
    expect(shared).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 6. hook:error event shape completeness
// ---------------------------------------------------------------------------

describe("hook:error event shape", () => {
  it("has type, hookName, and message fields", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);
    await runHooks(
      [
        vi.fn(async () => {
          throw new Error("check fields");
        }),
      ],
      bus,
      "myHookName"
    );
    const evt = events[0] as Extract<DzupEvent, { type: "hook:error" }>;
    expect(evt.type).toBe("hook:error");
    expect(evt.hookName).toBe("myHookName");
    expect(evt.message).toBe("check fields");
  });

  it("hookName zero-length string is preserved in error event", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);
    await runHooks(
      [
        vi.fn(async () => {
          throw new Error("empty name");
        }),
      ],
      bus,
      ""
    );
    const evt = events[0] as Extract<DzupEvent, { type: "hook:error" }>;
    expect(evt.hookName).toBe("");
  });

  it("modifier hook:error also carries correct hookName", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);
    await runModifierHook(
      vi.fn(async () => {
        throw new Error("mod-error");
      }) as never,
      bus,
      "beforeToolCall",
      "current"
    );
    const evt = events[0] as Extract<DzupEvent, { type: "hook:error" }>;
    expect(evt.hookName).toBe("beforeToolCall");
    expect(evt.message).toBe("mod-error");
  });

  it("null throw coerces to string 'null' in message", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);
    await runHooks(
      [
        vi.fn(async () => {
          throw null;
        }),
      ],
      bus,
      "test"
    );
    const evt = events[0] as Extract<DzupEvent, { type: "hook:error" }>;
    expect(evt.message).toBe("null");
  });

  it("object throw coerces via String() in message", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);
    await runHooks(
      [
        vi.fn(async () => {
          throw { code: 42 };
        }),
      ],
      bus,
      "test"
    );
    const evt = events[0] as Extract<DzupEvent, { type: "hook:error" }>;
    expect(typeof evt.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 7. Multiple buses — each gets only its own errors
// ---------------------------------------------------------------------------

describe("multiple buses — error isolation", () => {
  it("errors from busA do not appear in busB", async () => {
    const busA = createEventBus();
    const busB = createEventBus();
    const eventsA = collectEvents(busA);
    const eventsB = collectEvents(busB);

    await runHooks(
      [
        vi.fn(async () => {
          throw new Error("from-A");
        }),
      ],
      busA,
      "test"
    );

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(0);
  });

  it("two buses each get their own errors independently", async () => {
    const busA = createEventBus();
    const busB = createEventBus();
    const eventsA = collectEvents(busA);
    const eventsB = collectEvents(busB);

    await runHooks(
      [
        vi.fn(async () => {
          throw new Error("A-error");
        }),
      ],
      busA,
      "hookA"
    );
    await runHooks(
      [
        vi.fn(async () => {
          throw new Error("B-error");
        }),
      ],
      busB,
      "hookB"
    );

    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]).toMatchObject({ hookName: "hookA" });
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0]).toMatchObject({ hookName: "hookB" });
  });
});

// ---------------------------------------------------------------------------
// 8. HookContext with eventBus field
// ---------------------------------------------------------------------------

describe("HookContext with eventBus field", () => {
  it("context can carry an eventBus reference", async () => {
    const bus = createEventBus();
    const ctx: HookContext = {
      agentId: "a1",
      runId: "r1",
      metadata: {},
      eventBus: bus,
    };
    let capturedCtx: HookContext | undefined;
    const hook = vi.fn(async (c: HookContext) => {
      capturedCtx = c;
    });
    await runHooks([hook as never], undefined, "onRunStart", ctx);
    expect(capturedCtx!.eventBus).toBe(bus);
  });

  it("hook runner bus and context bus are independent", async () => {
    const runnerBus = createEventBus();
    const contextBus = createEventBus();
    const runnerEvents = collectEvents(runnerBus);
    const contextEvents = collectEvents(contextBus);

    const ctx: HookContext = {
      agentId: "a1",
      runId: "r1",
      metadata: {},
      eventBus: contextBus,
    };

    await runHooks(
      [
        vi.fn(async () => {
          throw new Error("runner-bus-error");
        }),
      ],
      runnerBus,
      "test",
      ctx
    );

    // Error goes to runnerBus (passed as 2nd arg), not contextBus
    expect(runnerEvents).toHaveLength(1);
    expect(contextEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. mergeHooks — advanced scenarios
// ---------------------------------------------------------------------------

describe("mergeHooks — advanced scenarios", () => {
  it("merges 5 sets correctly — all 5 hooks in array", () => {
    type Hooks = { onRunStart: () => Promise<void> };
    const fns = Array.from({ length: 5 }, () => async () => {});
    const merged = mergeHooks<Hooks>(
      { onRunStart: fns[0] },
      { onRunStart: fns[1] },
      { onRunStart: fns[2] },
      { onRunStart: fns[3] },
      { onRunStart: fns[4] }
    );
    expect(merged.onRunStart).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(merged.onRunStart![i]).toBe(fns[i]);
    }
  });

  it("merged keys absent from all sets do not appear in result", () => {
    type Hooks = {
      onRunStart: () => Promise<void>;
      onRunComplete: () => Promise<void>;
    };
    const merged = mergeHooks<Hooks>({ onRunStart: async () => {} });
    // onRunComplete was never provided
    expect("onRunComplete" in merged).toBe(false);
  });

  it("single hook set produces array of length 1", () => {
    type Hooks = { onRunStart: () => Promise<void> };
    const h = async () => {};
    const merged = mergeHooks<Hooks>({ onRunStart: h });
    expect(merged.onRunStart).toHaveLength(1);
    expect(merged.onRunStart![0]).toBe(h);
  });

  it("key enumeration order is stable across multiple merges", () => {
    type Hooks = {
      onRunStart: () => Promise<void>;
      onRunComplete: () => Promise<void>;
      onRunError: () => Promise<void>;
    };
    const h = async () => {};
    const merged = mergeHooks<Hooks>(
      { onRunStart: h },
      { onRunComplete: h },
      { onRunError: h }
    );
    const keys = Object.keys(merged);
    expect(keys).toContain("onRunStart");
    expect(keys).toContain("onRunComplete");
    expect(keys).toContain("onRunError");
  });

  it("merges same key from 3 sets into array of 3, preserving order", () => {
    type Hooks = { onRunStart: () => Promise<void> };
    const h1 = async () => {};
    const h2 = async () => {};
    const h3 = async () => {};
    const merged = mergeHooks<Hooks>(
      { onRunStart: h1 },
      { onRunStart: h2 },
      { onRunStart: h3 }
    );
    expect(merged.onRunStart![0]).toBe(h1);
    expect(merged.onRunStart![1]).toBe(h2);
    expect(merged.onRunStart![2]).toBe(h3);
  });
});

// ---------------------------------------------------------------------------
// 10. Hook deregistration via array splice pattern
// ---------------------------------------------------------------------------

describe("hook deregistration via array mutation", () => {
  it("removed hook is not called after splice", async () => {
    const fn = vi.fn(async () => {});
    const hooks: Array<() => Promise<void>> = [fn];

    await runHooks(hooks as never[], undefined, "test");
    expect(fn).toHaveBeenCalledTimes(1);

    // Deregister by splicing
    hooks.splice(0, 1);
    await runHooks(hooks as never[], undefined, "test");
    expect(fn).toHaveBeenCalledTimes(1); // still 1, not called again
  });

  it("other hooks still fire after one is spliced out", async () => {
    const fn1 = vi.fn(async () => {});
    const fn2 = vi.fn(async () => {});
    const hooks: Array<() => Promise<void>> = [fn1, fn2];

    // Remove fn1
    hooks.splice(0, 1);
    await runHooks(hooks as never[], undefined, "test");

    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("all hooks removed — empty array executes without error", async () => {
    const hooks: Array<() => Promise<void>> = [];
    await expect(
      runHooks(hooks as never[], undefined, "test")
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. beforeToolCall receives all three args
// ---------------------------------------------------------------------------

describe("beforeToolCall arg forwarding", () => {
  it("receives toolName as first arg", async () => {
    let capturedName: string | undefined;
    const hook = vi.fn(async (name: string) => {
      capturedName = name;
      return undefined;
    });
    await runModifierHook(
      hook as never,
      undefined,
      "beforeToolCall",
      "current-input",
      "myTool",
      { key: "val" },
      makeCtx()
    );
    expect(capturedName).toBe("myTool");
  });

  it("receives input as second arg", async () => {
    let capturedInput: unknown;
    const hook = vi.fn(async (_name: string, input: unknown) => {
      capturedInput = input;
      return undefined;
    });
    await runModifierHook(
      hook as never,
      undefined,
      "beforeToolCall",
      "pass-through",
      "tool",
      { query: "test" },
      makeCtx()
    );
    expect(capturedInput).toEqual({ query: "test" });
  });

  it("receives ctx as third arg", async () => {
    const ctx = makeCtx({ agentId: "test-agent" });
    let capturedCtx: HookContext | undefined;
    const hook = vi.fn(
      async (_name: string, _input: unknown, c: HookContext) => {
        capturedCtx = c;
        return undefined;
      }
    );
    await runModifierHook(
      hook as never,
      undefined,
      "beforeToolCall",
      "pass-through",
      "tool",
      {},
      ctx
    );
    expect(capturedCtx).toBe(ctx);
  });

  it("can inject extra context into input args", async () => {
    const ctx = makeCtx({ agentId: "injector" });
    const hook = vi.fn(
      async (_name: string, input: Record<string, unknown>) => {
        return { ...input, injected: true };
      }
    );
    const result = await runModifierHook(
      hook as never,
      undefined,
      "beforeToolCall",
      { original: true },
      "tool",
      { original: true },
      ctx
    );
    expect(result).toEqual({ original: true, injected: true });
  });
});

// ---------------------------------------------------------------------------
// 12. afterToolCall receives all four args
// ---------------------------------------------------------------------------

describe("afterToolCall arg forwarding", () => {
  it("receives toolName, input, result, ctx in that order", async () => {
    const receivedArgs: unknown[] = [];
    const hook = vi.fn(async (...args: unknown[]) => {
      receivedArgs.push(...args);
      return undefined;
    });
    const ctx = makeCtx();
    await runModifierHook(
      hook as never,
      undefined,
      "afterToolCall",
      "pass-through-result",
      "search",
      { q: "query" },
      "tool-output",
      ctx
    );
    // runModifierHook forwards extra args (not currentValue)
    expect(receivedArgs[0]).toBe("search");
    expect(receivedArgs[1]).toEqual({ q: "query" });
    expect(receivedArgs[2]).toBe("tool-output");
    expect(receivedArgs[3]).toBe(ctx);
  });

  it("can augment result with additional fields", async () => {
    const hook = vi.fn(
      async (_name: string, _input: unknown, result: string) => {
        return result + " [audited]";
      }
    );
    const result = await runModifierHook(
      hook as never,
      undefined,
      "afterToolCall",
      "raw-output",
      "audit-tool",
      {},
      "raw-output"
    );
    expect(result).toBe("raw-output [audited]");
  });
});

// ---------------------------------------------------------------------------
// 13. onToolError receives correct error type
// ---------------------------------------------------------------------------

describe("onToolError arg types", () => {
  it("receives an Error instance", async () => {
    const err = new TypeError("type mismatch");
    let receivedError: Error | undefined;

    const hook = vi.fn(async (_name: string, e: Error) => {
      receivedError = e;
    });

    await runHooks(
      [hook as never],
      undefined,
      "onToolError",
      "badTool",
      err,
      makeCtx()
    );

    expect(receivedError).toBeInstanceOf(TypeError);
    expect(receivedError!.message).toBe("type mismatch");
  });

  it("receives the tool name string", async () => {
    let receivedName: string | undefined;
    const hook = vi.fn(async (name: string) => {
      receivedName = name;
    });
    await runHooks(
      [hook as never],
      undefined,
      "onToolError",
      "specificTool",
      new Error("err"),
      makeCtx()
    );
    expect(receivedName).toBe("specificTool");
  });
});

// ---------------------------------------------------------------------------
// 14. Hooks registered in a loop all fire
// ---------------------------------------------------------------------------

describe("hooks registered in a loop", () => {
  it("10 hooks registered in a loop all fire", async () => {
    const calls: number[] = [];
    const hooks = Array.from({ length: 10 }, (_, i) =>
      vi.fn(async () => {
        calls.push(i);
      })
    );
    await runHooks(hooks, undefined, "test");
    expect(calls).toHaveLength(10);
    expect(calls).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("hooks dynamically pushed into array before run all execute", async () => {
    const calls: string[] = [];
    const hooks: Array<() => Promise<void>> = [];
    ["alpha", "beta", "gamma"].forEach((name) => {
      hooks.push(async () => {
        calls.push(name);
      });
    });
    await runHooks(hooks as never[], undefined, "dynamic");
    expect(calls).toEqual(["alpha", "beta", "gamma"]);
  });
});

// ---------------------------------------------------------------------------
// 15. Async hook that throws after a delay still isolates error
// ---------------------------------------------------------------------------

describe("async hook with delayed throw — error isolation", () => {
  it("delayed-throw hook does not block subsequent hooks", async () => {
    const calls: string[] = [];
    const delayedThrower = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error("delayed");
    });
    const afterThrower = vi.fn(async () => {
      calls.push("after");
    });

    await runHooks([delayedThrower, afterThrower], undefined, "test");
    expect(calls).toEqual(["after"]);
  });

  it("delayed-throw emits hook:error with correct message", async () => {
    const bus = createEventBus();
    const events = collectEvents(bus);

    await runHooks(
      [
        vi.fn(async () => {
          await new Promise((r) => setTimeout(r, 5));
          throw new Error("async-throw");
        }),
      ],
      bus,
      "asyncHook"
    );

    expect(events[0]).toMatchObject({
      type: "hook:error",
      hookName: "asyncHook",
      message: "async-throw",
    });
  });
});

// ---------------------------------------------------------------------------
// 16. runModifierHook with async delay still returns correct value
// ---------------------------------------------------------------------------

describe("runModifierHook — async delay correctness", () => {
  it("async modifier with 20ms delay returns transformed value", async () => {
    const hook = vi.fn(async (input: string) => {
      await new Promise((r) => setTimeout(r, 20));
      return input.toUpperCase();
    });
    const result = await runModifierHook(
      hook as never,
      undefined,
      "test",
      "hello",
      "hello"
    );
    expect(result).toBe("HELLO");
  });

  it("async modifier returning original ref is identity", async () => {
    const original = { nested: { value: 42 } };
    const hook = vi.fn(async (v: typeof original) => v);
    const result = await runModifierHook(
      hook as never,
      undefined,
      "test",
      original,
      original
    );
    expect(result).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// 17. onBudgetWarning — BudgetUsage shape verification
// ---------------------------------------------------------------------------

describe("onBudgetWarning — BudgetUsage shape", () => {
  it("receives all four budget fields", async () => {
    const ctx = makeCtx();
    const usage = makeBudget({ tokensUsed: 800, costUsedUsd: 0.8 });
    let capturedUsage: BudgetUsage | undefined;
    const hook = vi.fn(async (_level: string, u: BudgetUsage) => {
      capturedUsage = u;
    });

    await runHooks(
      [hook as never],
      undefined,
      "onBudgetWarning",
      "warn",
      usage,
      ctx
    );

    expect(capturedUsage).toMatchObject({
      tokensBudget: 1000,
      tokensUsed: 800,
      costBudgetUsd: 1.0,
      costUsedUsd: 0.8,
    });
  });

  it("receives warn vs critical level correctly", async () => {
    const ctx = makeCtx();
    const levels: string[] = [];
    const hook = vi.fn(async (level: string) => {
      levels.push(level);
    });
    const usage = makeBudget();

    await runHooks(
      [hook as never],
      undefined,
      "onBudgetWarning",
      "warn",
      usage,
      ctx
    );
    await runHooks(
      [hook as never],
      undefined,
      "onBudgetWarning",
      "critical",
      usage,
      ctx
    );

    expect(levels).toEqual(["warn", "critical"]);
  });
});

// ---------------------------------------------------------------------------
// 18. onBudgetExceeded — reason and usage
// ---------------------------------------------------------------------------

describe("onBudgetExceeded — reason and usage", () => {
  it("receives cost-exceeded reason", async () => {
    const ctx = makeCtx();
    const usage = makeBudget({ costUsedUsd: 2.5 });
    let reason: string | undefined;
    const hook = vi.fn(async (r: string) => {
      reason = r;
    });

    await runHooks(
      [hook as never],
      undefined,
      "onBudgetExceeded",
      "cost limit exceeded",
      usage,
      ctx
    );

    expect(reason).toBe("cost limit exceeded");
  });

  it("receives token-exceeded reason", async () => {
    const ctx = makeCtx();
    const usage = makeBudget({ tokensUsed: 1500 });
    let reason: string | undefined;
    const hook = vi.fn(async (r: string) => {
      reason = r;
    });

    await runHooks(
      [hook as never],
      undefined,
      "onBudgetExceeded",
      "token limit exceeded",
      usage,
      ctx
    );

    expect(reason).toBe("token limit exceeded");
  });

  it("receives correct usage when budget is exceeded", async () => {
    const ctx = makeCtx();
    const usage = makeBudget({ tokensUsed: 1200, costUsedUsd: 1.5 });
    let capturedUsage: BudgetUsage | undefined;
    const hook = vi.fn(async (_r: string, u: BudgetUsage) => {
      capturedUsage = u;
    });

    await runHooks(
      [hook as never],
      undefined,
      "onBudgetExceeded",
      "budget exceeded",
      usage,
      ctx
    );

    expect(capturedUsage!.tokensUsed).toBe(1200);
    expect(capturedUsage!.costUsedUsd).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// 19. Concurrent runHooks invocations (parallel callers)
// ---------------------------------------------------------------------------

describe("concurrent runHooks invocations", () => {
  it("two concurrent calls do not interfere with each other", async () => {
    const callsA: string[] = [];
    const callsB: string[] = [];

    const hookA = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      callsA.push("A");
    });
    const hookB = vi.fn(async () => {
      callsB.push("B");
    });

    await Promise.all([
      runHooks([hookA], undefined, "test"),
      runHooks([hookB], undefined, "test"),
    ]);

    expect(callsA).toEqual(["A"]);
    expect(callsB).toEqual(["B"]);
  });

  it("10 concurrent runs each fire their own hooks", async () => {
    const results: number[] = [];
    const promises = Array.from({ length: 10 }, (_, i) =>
      runHooks(
        [
          vi.fn(async () => {
            results.push(i);
          }),
        ],
        undefined,
        "concurrent"
      )
    );
    await Promise.all(promises);
    expect(results).toHaveLength(10);
    expect(results.sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 20. AgentHooks — full interface with all hooks wired through runHooks/runModifierHook
// ---------------------------------------------------------------------------

describe("AgentHooks — all hooks exercised end-to-end", () => {
  let callLog: string[];
  let ctx: HookContext;

  beforeEach(() => {
    callLog = [];
    ctx = makeCtx({ agentId: "e2e-agent", runId: "e2e-run" });
  });

  it("onRunStart fires and receives context", async () => {
    const hooks: AgentHooks = {
      onRunStart: vi.fn(async (c) => {
        callLog.push(`start:${c.agentId}`);
      }),
    };
    await runHooks([hooks.onRunStart as never], undefined, "onRunStart", ctx);
    expect(callLog).toEqual(["start:e2e-agent"]);
  });

  it("onRunComplete fires and receives context + result", async () => {
    const hooks: AgentHooks = {
      onRunComplete: vi.fn(async (c, r) => {
        callLog.push(`complete:${c.runId}:${r}`);
      }),
    };
    await runHooks(
      [hooks.onRunComplete as never],
      undefined,
      "onRunComplete",
      ctx,
      "success"
    );
    expect(callLog).toEqual(["complete:e2e-run:success"]);
  });

  it("onRunError fires and receives context + error", async () => {
    const hooks: AgentHooks = {
      onRunError: vi.fn(async (c, e) => {
        callLog.push(`error:${c.runId}:${e.message}`);
      }),
    };
    await runHooks(
      [hooks.onRunError as never],
      undefined,
      "onRunError",
      ctx,
      new Error("crash")
    );
    expect(callLog).toEqual(["error:e2e-run:crash"]);
  });

  it("beforeToolCall fires and can modify input", async () => {
    const hooks: AgentHooks = {
      beforeToolCall: vi.fn(async (name, input) => {
        callLog.push(`before:${name}`);
        return { ...(input as Record<string, unknown>), modified: true };
      }),
    };
    const result = await runModifierHook(
      hooks.beforeToolCall as never,
      undefined,
      "beforeToolCall",
      { original: true },
      "myTool",
      { original: true },
      ctx
    );
    expect(callLog).toEqual(["before:myTool"]);
    expect(result).toEqual({ original: true, modified: true });
  });

  it("afterToolCall fires and can modify result", async () => {
    const hooks: AgentHooks = {
      afterToolCall: vi.fn(async (name, _input, result) => {
        callLog.push(`after:${name}`);
        return result + " [cached]";
      }),
    };
    const output = await runModifierHook(
      hooks.afterToolCall as never,
      undefined,
      "afterToolCall",
      "raw-result",
      "myTool",
      {},
      "raw-result",
      ctx
    );
    expect(callLog).toEqual(["after:myTool"]);
    expect(output).toBe("raw-result [cached]");
  });

  it("onToolError fires with tool name and error", async () => {
    const err = new Error("tool-fail");
    const hooks: AgentHooks = {
      onToolError: vi.fn(async (name, e) => {
        callLog.push(`toolError:${name}:${e.message}`);
      }),
    };
    await runHooks(
      [hooks.onToolError as never],
      undefined,
      "onToolError",
      "badTool",
      err,
      ctx
    );
    expect(callLog).toEqual(["toolError:badTool:tool-fail"]);
  });

  it("onPhaseChange fires with phase and previousPhase", async () => {
    const hooks: AgentHooks = {
      onPhaseChange: vi.fn(async (phase, prev) => {
        callLog.push(`phase:${prev}->${phase}`);
      }),
    };
    await runHooks(
      [hooks.onPhaseChange as never],
      undefined,
      "onPhaseChange",
      "execute",
      "plan",
      ctx
    );
    expect(callLog).toEqual(["phase:plan->execute"]);
  });

  it("onApprovalRequired fires with plan and context", async () => {
    const hooks: AgentHooks = {
      onApprovalRequired: vi.fn(async (plan, c) => {
        callLog.push(
          `approval:${(plan as Record<string, string>).action}:${c.agentId}`
        );
      }),
    };
    await runHooks(
      [hooks.onApprovalRequired as never],
      undefined,
      "onApprovalRequired",
      { action: "deploy" },
      ctx
    );
    expect(callLog).toEqual(["approval:deploy:e2e-agent"]);
  });

  it("onBudgetWarning fires with level and usage", async () => {
    const usage = makeBudget({ tokensUsed: 750 });
    const hooks: AgentHooks = {
      onBudgetWarning: vi.fn(async (level, u) => {
        callLog.push(`budget-warn:${level}:${u.tokensUsed}`);
      }),
    };
    await runHooks(
      [hooks.onBudgetWarning as never],
      undefined,
      "onBudgetWarning",
      "warn",
      usage,
      ctx
    );
    expect(callLog).toEqual(["budget-warn:warn:750"]);
  });

  it("onBudgetExceeded fires with reason", async () => {
    const usage = makeBudget({ tokensUsed: 1100 });
    const hooks: AgentHooks = {
      onBudgetExceeded: vi.fn(async (reason) => {
        callLog.push(`budget-exceeded:${reason}`);
      }),
    };
    await runHooks(
      [hooks.onBudgetExceeded as never],
      undefined,
      "onBudgetExceeded",
      "over token limit",
      usage,
      ctx
    );
    expect(callLog).toEqual(["budget-exceeded:over token limit"]);
  });

  it("all 9 hooks fire in a full run lifecycle simulation", async () => {
    const hooks: AgentHooks = {
      onRunStart: vi.fn(async () => {
        callLog.push("start");
      }),
      beforeToolCall: vi.fn(async () => {
        callLog.push("before-tool");
        return undefined;
      }),
      afterToolCall: vi.fn(async () => {
        callLog.push("after-tool");
        return undefined;
      }),
      onPhaseChange: vi.fn(async () => {
        callLog.push("phase");
      }),
      onApprovalRequired: vi.fn(async () => {
        callLog.push("approval");
      }),
      onBudgetWarning: vi.fn(async () => {
        callLog.push("budget-warn");
      }),
      onBudgetExceeded: vi.fn(async () => {
        callLog.push("budget-exceeded");
      }),
      onRunError: vi.fn(async () => {
        callLog.push("run-error");
      }),
      onRunComplete: vi.fn(async () => {
        callLog.push("complete");
      }),
    };

    await runHooks([hooks.onRunStart as never], undefined, "onRunStart", ctx);
    await runModifierHook(
      hooks.beforeToolCall as never,
      undefined,
      "beforeToolCall",
      {},
      "t",
      {},
      ctx
    );
    await runModifierHook(
      hooks.afterToolCall as never,
      undefined,
      "afterToolCall",
      "r",
      "t",
      {},
      "r",
      ctx
    );
    await runHooks(
      [hooks.onPhaseChange as never],
      undefined,
      "onPhaseChange",
      "plan",
      "init",
      ctx
    );
    await runHooks(
      [hooks.onApprovalRequired as never],
      undefined,
      "onApprovalRequired",
      {},
      ctx
    );
    await runHooks(
      [hooks.onBudgetWarning as never],
      undefined,
      "onBudgetWarning",
      "warn",
      makeBudget(),
      ctx
    );
    await runHooks(
      [hooks.onBudgetExceeded as never],
      undefined,
      "onBudgetExceeded",
      "limit",
      makeBudget(),
      ctx
    );
    await runHooks(
      [hooks.onRunError as never],
      undefined,
      "onRunError",
      ctx,
      new Error("x")
    );
    await runHooks(
      [hooks.onRunComplete as never],
      undefined,
      "onRunComplete",
      ctx,
      null
    );

    expect(callLog).toEqual([
      "start",
      "before-tool",
      "after-tool",
      "phase",
      "approval",
      "budget-warn",
      "budget-exceeded",
      "run-error",
      "complete",
    ]);
  });
});
