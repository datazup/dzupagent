/**
 * Plugin run-lifecycle hook dispatch.
 *
 * `PluginRegistry.getHooks()` shipped with ZERO production consumers: it
 * returns `Partial<AgentHooks>[]` while every `AgentHooks` key is a single
 * optional function, so a plugin's hooks could be declared, registered and
 * aggregated and then never run — silently, with no error and no warning.
 * `PluginRegistry.toAgentHooks()` is the missing adapter; these specs pin that
 * a REGISTERED plugin's `onRunStart` / `onRunComplete` / `onRunError` actually
 * reach the run boundary, and pin the merge order they arrive in.
 *
 * ## Why the dispatchers below are transcribed rather than imported
 *
 * The real run-boundary dispatchers live in
 * `packages/agent/src/agent/run-lifecycle-hooks.ts`. `@dzupagent/core` is the
 * dependency root and MUST NOT import from `@dzupagent/agent`, so this suite
 * cannot drive `DzupAgent.generate()`. What it CAN do — and does — is drive
 * the real `PluginRegistry`, the real `toAgentHooks()` composition, and the
 * real core primitive (`runHooks`) that those agent-side dispatchers delegate
 * to, through a verbatim transcription of their bodies. The remaining link
 * (agent config `hooks` -> `runHooks`) is already proved from a real run by
 * `packages/agent/src/__tests__/run-lifecycle-hooks-dispatch.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PluginRegistry } from "../plugin/plugin-registry.js";
import { composeAgentHooks } from "../plugin/plugin-hooks.js";
import type { DzupPlugin, PluginContext } from "../plugin/plugin-types.js";
import { createEventBus } from "../events/event-bus.js";
import type { DzupEventBus } from "../events/event-bus.js";
import type { DzupEvent } from "../events/event-types.js";
import type { ModelRegistry } from "../llm/model-registry.js";
import type { AgentHooks, HookContext } from "../hooks/hook-types.js";
import { runHooks } from "../hooks/hook-runner.js";

// ---------------------------------------------------------------------------
// Verbatim transcription of packages/agent/src/agent/run-lifecycle-hooks.ts.
// If that file's dispatch shape changes, these must change with it.
// ---------------------------------------------------------------------------

function asHookList<T>(hook: T | undefined): [T] | undefined {
  return hook === undefined ? undefined : [hook];
}

async function dispatchOnRunStart(
  hooks: AgentHooks | undefined,
  eventBus: DzupEventBus | undefined,
  ctx: HookContext
): Promise<void> {
  await runHooks(asHookList(hooks?.onRunStart), eventBus, "onRunStart", ctx);
}

async function dispatchOnRunComplete(
  hooks: AgentHooks | undefined,
  eventBus: DzupEventBus | undefined,
  ctx: HookContext,
  result: unknown
): Promise<void> {
  await runHooks(
    asHookList(hooks?.onRunComplete),
    eventBus,
    "onRunComplete",
    ctx,
    result
  );
}

async function dispatchOnRunError(
  hooks: AgentHooks | undefined,
  eventBus: DzupEventBus | undefined,
  ctx: HookContext,
  error: Error
): Promise<void> {
  await runHooks(
    asHookList(hooks?.onRunError),
    eventBus,
    "onRunError",
    ctx,
    error
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubContext(eventBus: DzupEventBus): PluginContext {
  return { eventBus, modelRegistry: {} as unknown as ModelRegistry };
}

function makeCtx(): HookContext {
  return { agentId: "agent-1", runId: "run-1", metadata: {} };
}

/**
 * Drain the microtask queue. Deliberately NOT a timer: an ESLint rule bans a
 * real `setTimeout` in this package, and a timer is not needed — every path
 * under test settles on microtasks or not at all.
 */
async function flushMicrotasks(turns = 25): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** A promise this test controls, for parking a hook mid-dispatch. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let bus: DzupEventBus;
let registry: PluginRegistry;

beforeEach(() => {
  bus = createEventBus();
  registry = new PluginRegistry(bus);
});

// ---------------------------------------------------------------------------
// 1. A registered plugin's run hooks are INVOKED
// ---------------------------------------------------------------------------

describe("plugin run hooks reach the run boundary", () => {
  it("invokes a registered plugin's onRunStart with the run's own ctx", async () => {
    const seen: HookContext[] = [];
    const onRunStart = vi.fn(async (ctx: HookContext) => {
      seen.push(ctx);
    });
    const plugin: DzupPlugin = {
      name: "telemetry",
      version: "1.0.0",
      hooks: { onRunStart },
    };
    await registry.register(plugin, stubContext(bus));

    const hooks = registry.toAgentHooks();
    // The key must EXIST, otherwise the dispatcher short-circuits and any
    // assertion below would pass vacuously.
    expect(typeof hooks.onRunStart).toBe("function");

    const ctx = makeCtx();
    await dispatchOnRunStart(hooks, bus, ctx);

    expect(onRunStart).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    // Identity, not shape: the hook must see the run's real context object.
    expect(seen[0]).toBe(ctx);
  });

  it("invokes onRunComplete with the ctx and the run result", async () => {
    const calls: Array<[HookContext, unknown]> = [];
    const onRunComplete = vi.fn(async (ctx: HookContext, result: unknown) => {
      calls.push([ctx, result]);
    });
    await registry.register(
      { name: "p", version: "1.0.0", hooks: { onRunComplete } },
      stubContext(bus)
    );

    const hooks = registry.toAgentHooks();
    expect(typeof hooks.onRunComplete).toBe("function");

    const ctx = makeCtx();
    const result = { stopReason: "complete", output: "done" };
    await dispatchOnRunComplete(hooks, bus, ctx, result);

    expect(onRunComplete).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(ctx);
    expect(calls[0]?.[1]).toBe(result);
  });

  it("invokes onRunError with the thrown Error by identity", async () => {
    const seen: Error[] = [];
    const onRunError = vi.fn(async (_ctx: HookContext, error: Error) => {
      seen.push(error);
    });
    await registry.register(
      { name: "p", version: "1.0.0", hooks: { onRunError } },
      stubContext(bus)
    );

    const hooks = registry.toAgentHooks();
    expect(typeof hooks.onRunError).toBe("function");

    const boom = new Error("model exploded");
    await dispatchOnRunError(hooks, bus, makeCtx(), boom);

    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(seen[0]).toBe(boom);
  });

  it("hands the SAME ctx to onRunStart and onRunComplete so metadata survives", async () => {
    const plugin: DzupPlugin = {
      name: "timing",
      version: "1.0.0",
      hooks: {
        onRunStart: async (ctx) => {
          ctx.metadata.startedBy = "plugin";
        },
        onRunComplete: async (ctx) => {
          ctx.metadata.readBack = ctx.metadata.startedBy;
        },
      },
    };
    await registry.register(plugin, stubContext(bus));

    const hooks = registry.toAgentHooks();
    const ctx = makeCtx();
    await dispatchOnRunStart(hooks, bus, ctx);
    await dispatchOnRunComplete(hooks, bus, ctx, {});

    expect(ctx.metadata.readBack).toBe("plugin");
  });
});

// ---------------------------------------------------------------------------
// 2. Negative controls — registered must be distinguishable from not
// ---------------------------------------------------------------------------

describe("negative controls", () => {
  it("a plugin with NO hooks contributes nothing and dispatch does not throw", async () => {
    await registry.register(
      { name: "inert", version: "1.0.0" },
      stubContext(bus)
    );

    const hooks = registry.toAgentHooks();
    expect(hooks.onRunStart).toBeUndefined();
    expect(hooks.onRunComplete).toBeUndefined();
    expect(hooks.onRunError).toBeUndefined();

    await expect(
      dispatchOnRunStart(hooks, bus, makeCtx())
    ).resolves.toBeUndefined();
  });

  it("an UNregistered plugin's hook is absent and never fires", async () => {
    const onRunStart = vi.fn(async () => {});
    await registry.register(
      { name: "temp", version: "1.0.0", hooks: { onRunStart } },
      stubContext(bus)
    );

    // Control arm: while registered, the key exists.
    expect(typeof registry.toAgentHooks().onRunStart).toBe("function");

    registry.unregisterPlugin("temp");

    const hooks = registry.toAgentHooks();
    expect(hooks.onRunStart).toBeUndefined();
    await dispatchOnRunStart(hooks, bus, makeCtx());
    expect(onRunStart).not.toHaveBeenCalled();
  });

  it("omits keys nothing contributed rather than installing a no-op", async () => {
    await registry.register(
      { name: "start-only", version: "1.0.0", hooks: { onRunStart: async () => {} } },
      stubContext(bus)
    );

    const hooks = registry.toAgentHooks();
    expect(typeof hooks.onRunStart).toBe("function");
    expect(Object.keys(hooks)).toEqual(["onRunStart"]);
    expect("onRunComplete" in hooks).toBe(false);
    expect("beforeToolCall" in hooks).toBe(false);
  });

  it("an empty registry with no agent hooks composes to an empty object", () => {
    const hooks = registry.toAgentHooks();
    expect(Object.keys(hooks)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Merge order — this is contract, and an unpinned order rots
// ---------------------------------------------------------------------------

describe("merge order: plugins in registration order, agent hooks LAST", () => {
  it("runs plugin A, then plugin B, then the agent's own onRunStart", async () => {
    const order: string[] = [];
    await registry.register(
      {
        name: "A",
        version: "1.0.0",
        hooks: { onRunStart: async () => { order.push("plugin-A"); } },
      },
      stubContext(bus)
    );
    await registry.register(
      {
        name: "B",
        version: "1.0.0",
        hooks: { onRunStart: async () => { order.push("plugin-B"); } },
      },
      stubContext(bus)
    );

    const hooks = registry.toAgentHooks({
      onRunStart: async () => { order.push("agent-config"); },
    });

    await dispatchOnRunStart(hooks, bus, makeCtx());

    expect(order).toEqual(["plugin-A", "plugin-B", "agent-config"]);
  });

  it("threads beforeToolCall through plugins then the agent hook, which wins", async () => {
    await registry.register(
      {
        name: "A",
        version: "1.0.0",
        hooks: {
          beforeToolCall: async (_t, input) => `${String(input)}|A`,
        },
      },
      stubContext(bus)
    );
    await registry.register(
      {
        name: "B",
        version: "1.0.0",
        hooks: {
          beforeToolCall: async (_t, input) => `${String(input)}|B`,
        },
      },
      stubContext(bus)
    );

    const hooks = registry.toAgentHooks({
      beforeToolCall: async (_t, input) => `${String(input)}|agent`,
    });

    const final = await hooks.beforeToolCall?.("git_status", "seed", makeCtx());

    // Proves BOTH order and that each contributor saw the previous value —
    // a discard-style fan-out would return "seed" or "seed|agent".
    expect(final).toBe("seed|A|B|agent");
  });

  it("passes the current value through a modifier that returns void", async () => {
    await registry.register(
      {
        name: "A",
        version: "1.0.0",
        hooks: { beforeToolCall: async (_t, input) => `${String(input)}|A` },
      },
      stubContext(bus)
    );
    await registry.register(
      {
        name: "observer",
        version: "1.0.0",
        hooks: { beforeToolCall: async () => undefined },
      },
      stubContext(bus)
    );

    const hooks = registry.toAgentHooks();
    const final = await hooks.beforeToolCall?.("t", "seed", makeCtx());
    expect(final).toBe("seed|A");
  });

  it("threads afterToolCall result strings in the same order", async () => {
    await registry.register(
      {
        name: "A",
        version: "1.0.0",
        hooks: { afterToolCall: async (_t, _i, result) => `${result}|A` },
      },
      stubContext(bus)
    );

    const hooks = registry.toAgentHooks({
      afterToolCall: async (_t, _i, result) => `${result}|agent`,
    });

    const final = await hooks.afterToolCall?.("t", {}, "out", makeCtx());
    expect(final).toBe("out|A|agent");
  });

  it("composeAgentHooks runs sets in array order regardless of the registry", async () => {
    const order: string[] = [];
    const hooks = composeAgentHooks([
      { onRunStart: async () => { order.push("first"); } },
      undefined,
      { onRunStart: async () => { order.push("second"); } },
    ]);
    await dispatchOnRunStart(hooks, undefined, makeCtx());
    expect(order).toEqual(["first", "second"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Error isolation — a throwing plugin must not break the run
// ---------------------------------------------------------------------------

describe("error isolation", () => {
  it("a throwing plugin hook does not stop later hooks and emits hook:error", async () => {
    const events: DzupEvent[] = [];
    bus.onAny((e) => {
      events.push(e);
    });

    const later = vi.fn(async () => {});
    await registry.register(
      {
        name: "bad",
        version: "1.0.0",
        hooks: {
          onRunStart: async () => {
            throw new Error("plugin blew up");
          },
        },
      },
      stubContext(bus)
    );
    await registry.register(
      { name: "good", version: "1.0.0", hooks: { onRunStart: later } },
      stubContext(bus)
    );

    const hooks = registry.toAgentHooks();
    await expect(
      dispatchOnRunStart(hooks, bus, makeCtx())
    ).resolves.toBeUndefined();

    expect(later).toHaveBeenCalledTimes(1);
    const hookErrors = events.filter((e) => e.type === "hook:error");
    expect(hookErrors).toHaveLength(1);
    expect(hookErrors[0]).toMatchObject({
      hookName: "onRunStart",
      message: "plugin blew up",
    });
  });

  it("reports hook errors on the registry's bus by default", async () => {
    const events: DzupEvent[] = [];
    bus.onAny((e) => {
      events.push(e);
    });
    await registry.register(
      {
        name: "bad",
        version: "1.0.0",
        hooks: {
          onRunStart: async () => {
            throw new Error("default bus");
          },
        },
      },
      stubContext(bus)
    );

    // Dispatch with NO bus of its own — the composed hook must still report.
    await registry.toAgentHooks().onRunStart?.(makeCtx());

    expect(
      events.filter(
        (e) => e.type === "hook:error" && e.message === "default bus"
      )
    ).toHaveLength(1);
  });

  it("options.eventBus overrides the registry bus for hook errors", async () => {
    const registryEvents: DzupEvent[] = [];
    const runEvents: DzupEvent[] = [];
    bus.onAny((e) => {
      registryEvents.push(e);
    });
    const runBus = createEventBus();
    runBus.onAny((e) => {
      runEvents.push(e);
    });

    await registry.register(
      {
        name: "bad",
        version: "1.0.0",
        hooks: {
          onRunStart: async () => {
            throw new Error("routed");
          },
        },
      },
      stubContext(bus)
    );

    await registry.toAgentHooks(undefined, { eventBus: runBus }).onRunStart?.(
      makeCtx()
    );

    expect(
      runEvents.filter((e) => e.type === "hook:error")
    ).toHaveLength(1);
    expect(
      registryEvents.filter((e) => e.type === "hook:error")
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Await — deferred gate, NOT microtask ordering
// ---------------------------------------------------------------------------

describe("dispatch awaits every plugin hook", () => {
  it("does not resolve until a parked plugin hook is released", async () => {
    const gate = deferred();
    let entered = false;
    await registry.register(
      {
        name: "slow",
        version: "1.0.0",
        hooks: {
          onRunStart: async () => {
            entered = true;
            await gate.promise;
          },
        },
      },
      stubContext(bus)
    );

    const hooks = registry.toAgentHooks();
    expect(typeof hooks.onRunStart).toBe("function");

    let settled = false;
    const dispatched = dispatchOnRunStart(hooks, bus, makeCtx()).then(() => {
      settled = true;
    });

    await flushMicrotasks();

    // The fixture FIRED — without this the pending assertion below could hold
    // simply because nothing ever ran.
    expect(entered).toBe(true);
    // ...and the dispatch is still PENDING. A dropped `await` would have let
    // it resolve here.
    expect(settled).toBe(false);

    gate.release();
    await dispatched;
    expect(settled).toBe(true);
  });

  it("does not start the second plugin's hook before the first settles", async () => {
    const gate = deferred();
    const order: string[] = [];
    await registry.register(
      {
        name: "first",
        version: "1.0.0",
        hooks: {
          onRunStart: async () => {
            order.push("first:enter");
            await gate.promise;
            order.push("first:exit");
          },
        },
      },
      stubContext(bus)
    );
    await registry.register(
      {
        name: "second",
        version: "1.0.0",
        hooks: {
          onRunStart: async () => {
            order.push("second:enter");
          },
        },
      },
      stubContext(bus)
    );

    const dispatched = dispatchOnRunStart(
      registry.toAgentHooks(),
      bus,
      makeCtx()
    );

    await flushMicrotasks();
    expect(order).toEqual(["first:enter"]);

    gate.release();
    await dispatched;
    expect(order).toEqual(["first:enter", "first:exit", "second:enter"]);
  });

  it("a parked modifier hook holds the value chain until released", async () => {
    const gate = deferred();
    await registry.register(
      {
        name: "gated",
        version: "1.0.0",
        hooks: {
          beforeToolCall: async (_t, input) => {
            await gate.promise;
            return `${String(input)}|gated`;
          },
        },
      },
      stubContext(bus)
    );

    const hooks = registry.toAgentHooks({
      beforeToolCall: async (_t, input) => `${String(input)}|agent`,
    });

    let value: unknown;
    const pending = hooks.beforeToolCall?.("t", "seed", makeCtx()).then((v) => {
      value = v;
    });

    await flushMicrotasks();
    expect(value).toBeUndefined();

    gate.release();
    await pending;
    expect(value).toBe("seed|gated|agent");
  });
});
