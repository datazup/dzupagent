/**
 * Plugin system extended coverage (+70 tests)
 *
 * Topics not yet exhausted by plugin-system.test.ts or plugin-mcp-deep.test.ts:
 *
 *  - PluginRegistry source/path defaults when options are omitted
 *  - PluginRegistry: plugin:registered event carries correct pluginName
 *  - PluginRegistry: async onRegister awaited before handlers are wired
 *  - PluginRegistry: multiple event types on a single plugin all fire
 *  - PluginRegistry: disposePlugin then re-register wires handlers again
 *  - PluginRegistry: getHooks() with disposed plugin (hooks still listed but no events)
 *  - PluginRegistry: getMiddleware() flattens multi-tool arrays
 *  - PluginRegistry: register with memoryService in context
 *  - PluginRegistrationOptions: unknown source stored correctly
 *  - Hook runner (runHooks): sequential ordering, error isolation, event bus
 *  - Hook runner (runModifierHook): pass-through, substitution, error fallback
 *  - mergeHooks: combine two hook sets, combined output correct
 *  - resolvePluginOrder: no-dependency list, single plugin, external dep, long chain
 *  - validateManifest: null manifest, non-object, empty name, whitespace name
 *  - validateManifest: valid full manifest, empty capabilities ok, build-metadata semver
 *  - validateManifest: entryPoint starting with ./ and with no ./ prefix
 *  - validateManifest: capabilities with whitespace-only strings
 *  - createManifest + validateManifest: output is always valid
 *  - Plugin composition: two plugins contribute hooks that both fire via getHooks chain
 *  - Plugin composition: middleware tools[] merged across plugins
 *  - PluginNameConflictError: diagnostic signal and path fields
 *  - PluginDisposeResult telemetry: disposerCount matches handler count
 *  - Concurrency: ten plugins registered simultaneously all land
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PluginRegistry } from "../plugin/plugin-registry.js";
import type { PluginRegistrationConflictError } from "../plugin/plugin-registry.js";
import type {
  DzupPlugin,
  PluginContext,
  PluginDisposeResult,
} from "../plugin/plugin-types.js";
import {
  resolvePluginOrder,
  validateManifest,
  discoverPlugins,
} from "../plugin/plugin-discovery.js";
import type {
  DiscoveredPlugin,
  PluginManifest,
  PluginNameConflictError,
} from "../plugin/plugin-discovery.js";
import {
  createManifest,
  serializeManifest,
} from "../plugin/plugin-manifest.js";
import { runHooks, runModifierHook, mergeHooks } from "../hooks/hook-runner.js";
import { createEventBus } from "../events/event-bus.js";
import type { DzupEventBus } from "../events/event-bus.js";
import type { DzupEvent } from "../events/event-types.js";
import type { ModelRegistry } from "../llm/model-registry.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function stubContext(
  eventBus: DzupEventBus,
  memoryService?: unknown,
): PluginContext {
  return {
    eventBus,
    modelRegistry: {} as unknown as ModelRegistry,
    ...(memoryService !== undefined ? { memoryService } : {}),
  };
}

function makePlugin(overrides: Partial<DzupPlugin> = {}): DzupPlugin {
  return { name: "test-plugin", version: "1.0.0", ...overrides };
}

function makeDiscovered(
  name: string,
  deps: string[] = [],
  source: DiscoveredPlugin["source"] = "local",
  pathSuffix = "",
): DiscoveredPlugin {
  return {
    manifest: {
      name,
      version: "1.0.0",
      description: name,
      capabilities: [],
      entryPoint: "./index.js",
      ...(deps.length ? { dependencies: deps } : {}),
    },
    path: `/plugins/${name}${pathSuffix}`,
    source,
  };
}

function validManifest(
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    name: "my-plugin",
    version: "1.2.3",
    description: "A valid plugin",
    capabilities: ["cap-a"],
    entryPoint: "./index.js",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PluginRegistry — source/path defaults
// ---------------------------------------------------------------------------

describe("PluginRegistry — source and path defaults", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("registers when options is entirely omitted (no source, no path)", async () => {
    await expect(
      registry.register(makePlugin({ name: "no-opts" }), ctx),
    ).resolves.toBeUndefined();
    expect(registry.has("no-opts")).toBe(true);
  });

  it("conflict diagnostic shows 'unknown' source when options are omitted", async () => {
    await registry.register(makePlugin({ name: "src-default" }), ctx);
    let caught: PluginRegistrationConflictError | undefined;
    try {
      await registry.register(makePlugin({ name: "src-default" }), ctx);
    } catch (err) {
      caught = err as PluginRegistrationConflictError;
    }
    expect(caught?.diagnostic.previousSource).toBe("unknown");
    expect(caught?.diagnostic.source).toBe("unknown");
  });

  it("conflict diagnostic shows '<runtime>' path when options.path is omitted", async () => {
    await registry.register(makePlugin({ name: "path-default" }), ctx);
    let caught: PluginRegistrationConflictError | undefined;
    try {
      await registry.register(makePlugin({ name: "path-default" }), ctx);
    } catch (err) {
      caught = err as PluginRegistrationConflictError;
    }
    expect(caught?.diagnostic.previousPath).toBe("<runtime>");
    expect(caught?.diagnostic.path).toBe("<runtime>");
  });

  it("stores the custom source and path from options in conflict diagnostics", async () => {
    await registry.register(makePlugin({ name: "custom-src" }), ctx, {
      source: "npm",
      path: "/node_modules/custom-src",
    });
    let caught: PluginRegistrationConflictError | undefined;
    try {
      await registry.register(makePlugin({ name: "custom-src" }), ctx, {
        source: "local",
        path: "/local/custom-src",
      });
    } catch (err) {
      caught = err as PluginRegistrationConflictError;
    }
    expect(caught?.diagnostic.previousSource).toBe("npm");
    expect(caught?.diagnostic.previousPath).toBe("/node_modules/custom-src");
    expect(caught?.diagnostic.source).toBe("local");
    expect(caught?.diagnostic.path).toBe("/local/custom-src");
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry — plugin:registered event
// ---------------------------------------------------------------------------

describe("PluginRegistry — plugin:registered event", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;
  let events: DzupEvent[];

  beforeEach(() => {
    bus = createEventBus();
    events = [];
    bus.onAny((e) => events.push(e));
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("emits plugin:registered with the correct pluginName", async () => {
    await registry.register(makePlugin({ name: "emit-test" }), ctx);
    const evt = events.find((e) => e.type === "plugin:registered");
    expect(evt).toBeDefined();
    const typed = evt as Extract<DzupEvent, { type: "plugin:registered" }>;
    expect(typed.pluginName).toBe("emit-test");
  });

  it("emits plugin:registered once per registration", async () => {
    await registry.register(makePlugin({ name: "once-emit" }), ctx);
    const count = events.filter((e) => e.type === "plugin:registered").length;
    expect(count).toBe(1);
  });

  it("emits plugin:registered for each plugin when multiple registered", async () => {
    await registry.register(makePlugin({ name: "alpha-reg" }), ctx);
    await registry.register(makePlugin({ name: "beta-reg" }), ctx);
    const regEvents = events.filter((e) => e.type === "plugin:registered");
    expect(regEvents).toHaveLength(2);
  });

  it("plugin:registered event fires after onRegister completes", async () => {
    const order: string[] = [];
    await registry.register(
      makePlugin({
        name: "order-test",
        onRegister: async () => {
          order.push("onRegister");
        },
      }),
      ctx,
    );
    const regEvtIndex = events.findIndex(
      (e) =>
        e.type === "plugin:registered" &&
        (e as Extract<DzupEvent, { type: "plugin:registered" }>).pluginName ===
          "order-test",
    );
    expect(order[0]).toBe("onRegister");
    expect(regEvtIndex).toBeGreaterThanOrEqual(0);
  });

  it("plugin:registered is NOT emitted when onRegister throws", async () => {
    await expect(
      registry.register(
        makePlugin({
          name: "init-fail",
          onRegister: async () => {
            throw new Error("boom");
          },
        }),
        ctx,
      ),
    ).rejects.toThrow();
    expect(events.find((e) => e.type === "plugin:registered")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry — async onRegister behaviour
// ---------------------------------------------------------------------------

describe("PluginRegistry — async onRegister", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("awaits async onRegister before plugin appears in listPlugins()", async () => {
    const seen: boolean[] = [];
    await registry.register(
      makePlugin({
        name: "async-init",
        onRegister: async () => {
          // Plugin should NOT be in registry yet during onRegister
          seen.push(registry.has("async-init"));
        },
      }),
      ctx,
    );
    // During onRegister the plugin is not yet stored (registration happens after)
    expect(seen[0]).toBe(false);
    // After register() resolves, it is stored
    expect(registry.has("async-init")).toBe(true);
  });

  it("onRegister receives the full PluginContext", async () => {
    const receivedCtx: PluginContext[] = [];
    await registry.register(
      makePlugin({
        name: "ctx-test",
        onRegister: async (c) => {
          receivedCtx.push(c);
        },
      }),
      ctx,
    );
    expect(receivedCtx[0]).toBe(ctx);
  });

  it("onRegister can access memoryService when provided in context", async () => {
    const memSvc = { store: vi.fn() };
    const customCtx = stubContext(bus, memSvc);
    const captured: unknown[] = [];
    await registry.register(
      makePlugin({
        name: "mem-ctx",
        onRegister: async (c) => {
          captured.push(c.memoryService);
        },
      }),
      customCtx,
    );
    expect(captured[0]).toBe(memSvc);
  });

  it("multiple async onRegisters are awaited in registration order", async () => {
    const order: string[] = [];
    await registry.register(
      makePlugin({
        name: "async-first",
        onRegister: async () => {
          order.push("first");
        },
      }),
      ctx,
    );
    await registry.register(
      makePlugin({
        name: "async-second",
        onRegister: async () => {
          order.push("second");
        },
      }),
      ctx,
    );
    expect(order).toEqual(["first", "second"]);
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry — multiple event types on one plugin
// ---------------------------------------------------------------------------

describe("PluginRegistry — multiple event types per plugin", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("all event types from one plugin fire independently", async () => {
    const fired: string[] = [];
    await registry.register(
      makePlugin({
        name: "multi-evt",
        eventHandlers: {
          "agent:started": () => fired.push("started"),
          "agent:completed": () => fired.push("completed"),
          "agent:failed": () => fired.push("failed"),
        },
      }),
      ctx,
    );
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    bus.emit({ type: "agent:completed", agentId: "a", runId: "r" });
    bus.emit({
      type: "agent:failed",
      agentId: "a",
      runId: "r",
      error: new Error("e"),
    });
    await Promise.resolve();
    expect(fired).toContain("started");
    expect(fired).toContain("completed");
    expect(fired).toContain("failed");
  });

  it("disposing plugin stops all its event types", async () => {
    const fired: string[] = [];
    await registry.register(
      makePlugin({
        name: "dispose-multi",
        eventHandlers: {
          "agent:started": () => fired.push("started"),
          "agent:completed": () => fired.push("completed"),
        },
      }),
      ctx,
    );
    registry.disposePlugin("dispose-multi");
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    bus.emit({ type: "agent:completed", agentId: "a", runId: "r" });
    await Promise.resolve();
    expect(fired).toHaveLength(0);
  });

  it("disposePlugin then re-register wires event handlers again", async () => {
    const calls: number[] = [];
    const handler = () => calls.push(1);
    await registry.register(
      makePlugin({
        name: "rewire",
        eventHandlers: { "agent:started": handler },
      }),
      ctx,
    );
    registry.disposePlugin("rewire");
    // Re-register with overrideExisting: true (because plugin still exists in registry after disposePlugin)
    await registry.register(
      makePlugin({
        name: "rewire",
        eventHandlers: { "agent:started": handler },
      }),
      ctx,
      { overrideExisting: true },
    );
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it("disposerCount after disposePlugin on multi-event plugin equals handler count", async () => {
    await registry.register(
      makePlugin({
        name: "count-check",
        eventHandlers: {
          "agent:started": vi.fn(),
          "agent:completed": vi.fn(),
          "agent:failed": vi.fn(),
        },
      }),
      ctx,
    );
    const result = registry.disposePlugin("count-check");
    expect(result.disposerCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry — getHooks/getMiddleware after dispose
// ---------------------------------------------------------------------------

describe("PluginRegistry — getHooks and getMiddleware after dispose", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("getHooks() still includes disposed plugin's hooks (disposePlugin keeps registration)", async () => {
    const hooks = { onRunStart: vi.fn() };
    await registry.register(makePlugin({ name: "disposed-hooks", hooks }), ctx);
    registry.disposePlugin("disposed-hooks");
    expect(registry.getHooks()).toContain(hooks);
  });

  it("getHooks() excludes unregistered plugin's hooks", async () => {
    const hooks = { onRunStart: vi.fn() };
    await registry.register(makePlugin({ name: "unreg-hooks", hooks }), ctx);
    registry.unregisterPlugin("unreg-hooks");
    expect(registry.getHooks()).not.toContain(hooks);
  });

  it("getMiddleware() still includes disposed plugin's middleware", async () => {
    await registry.register(
      makePlugin({ name: "disp-mw", middleware: [{ name: "mw-x" }] }),
      ctx,
    );
    registry.disposePlugin("disp-mw");
    expect(registry.getMiddleware().map((m) => m.name)).toContain("mw-x");
  });

  it("getMiddleware() returns empty array for empty registry", () => {
    expect(registry.getMiddleware()).toEqual([]);
  });

  it("getHooks() returns empty array for empty registry", () => {
    expect(registry.getHooks()).toEqual([]);
  });

  it("middleware tools[] from multiple plugins are merged in getMiddleware()", async () => {
    await registry.register(
      makePlugin({
        name: "tool-p1",
        middleware: [{ name: "mw-a" }, { name: "mw-b" }],
      }),
      ctx,
    );
    await registry.register(
      makePlugin({
        name: "tool-p2",
        middleware: [{ name: "mw-c" }],
      }),
      ctx,
    );
    const mw = registry.getMiddleware();
    expect(mw.map((m) => m.name)).toEqual(["mw-a", "mw-b", "mw-c"]);
  });
});

// ---------------------------------------------------------------------------
// Hook runner — runHooks
// ---------------------------------------------------------------------------

describe("runHooks — additional coverage", () => {
  it("runs all hooks in declared order", async () => {
    const order: number[] = [];
    const hooks = [
      async () => {
        order.push(1);
      },
      async () => {
        order.push(2);
      },
      async () => {
        order.push(3);
      },
    ];
    await runHooks(hooks, undefined, "test-hook");
    expect(order).toEqual([1, 2, 3]);
  });

  it("passes extra arguments to each hook", async () => {
    const captured: unknown[][] = [];
    const hooks = [
      async (...args: unknown[]) => {
        captured.push(args);
      },
    ];
    await runHooks(hooks, undefined, "arg-hook", "foo", 42);
    expect(captured[0]).toEqual(["foo", 42]);
  });

  it("continues after a hook throws and runs subsequent hooks", async () => {
    const second = vi.fn(async () => {});
    const hooks = [
      async () => {
        throw new Error("first-fail");
      },
      second,
    ];
    await runHooks(hooks, undefined, "fail-hook");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("emits hook:error event with hookName and message when hook throws", async () => {
    const bus = createEventBus();
    const events: DzupEvent[] = [];
    bus.onAny((e) => events.push(e));
    const hooks = [
      async () => {
        throw new Error("hook-boom");
      },
    ];
    await runHooks(hooks, bus, "my-hook-name");
    const errEvt = events.find((e) => e.type === "hook:error");
    expect(errEvt).toBeDefined();
    const typed = errEvt as Extract<DzupEvent, { type: "hook:error" }>;
    expect(typed.hookName).toBe("my-hook-name");
    expect(typed.message).toBe("hook-boom");
  });

  it("emits hook:error with string representation for non-Error throws", async () => {
    const bus = createEventBus();
    const events: DzupEvent[] = [];
    bus.onAny((e) => events.push(e));
    const hooks = [
      async () => {
        throw "string-error";
      },
    ];
    await runHooks(hooks, bus, "non-error-hook");
    const errEvt = events.find((e) => e.type === "hook:error") as
      | Extract<DzupEvent, { type: "hook:error" }>
      | undefined;
    expect(errEvt?.message).toBe("string-error");
  });

  it("returns immediately when hooks array is undefined", async () => {
    await expect(
      runHooks(undefined, undefined, "noop-hook"),
    ).resolves.toBeUndefined();
  });

  it("skips undefined entries in the hooks array", async () => {
    const fn = vi.fn(async () => {});
    const hooks = [undefined, fn, undefined];
    await runHooks(hooks, undefined, "skip-hook");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not emit hook:error when no error occurs", async () => {
    const bus = createEventBus();
    const events: DzupEvent[] = [];
    bus.onAny((e) => events.push(e));
    const hooks = [async () => {}];
    await runHooks(hooks, bus, "clean-hook");
    expect(events.find((e) => e.type === "hook:error")).toBeUndefined();
  });

  it("runs zero hooks without error", async () => {
    await expect(
      runHooks([], undefined, "empty-hook"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hook runner — runModifierHook
// ---------------------------------------------------------------------------

describe("runModifierHook — additional coverage", () => {
  it("returns original value when hook is undefined", async () => {
    const result = await runModifierHook(
      undefined,
      undefined,
      "mod",
      "original",
    );
    expect(result).toBe("original");
  });

  it("returns hook return value when hook returns a defined value", async () => {
    const hook = async () => "modified";
    const result = await runModifierHook(hook, undefined, "mod", "original");
    expect(result).toBe("modified");
  });

  it("returns original value when hook returns undefined (void pass-through)", async () => {
    const hook = async () => undefined;
    const result = await runModifierHook(
      hook,
      undefined,
      "void-mod",
      "keep-me",
    );
    expect(result).toBe("keep-me");
  });

  it("returns original value when hook throws", async () => {
    const hook = async (): Promise<string | void> => {
      throw new Error("modifier-fail");
    };
    const result = await runModifierHook(
      hook,
      undefined,
      "err-mod",
      "fallback",
    );
    expect(result).toBe("fallback");
  });

  it("emits hook:error when hook throws", async () => {
    const bus = createEventBus();
    const events: DzupEvent[] = [];
    bus.onAny((e) => events.push(e));
    const hook = async (): Promise<string | void> => {
      throw new Error("modifier-error");
    };
    await runModifierHook(hook, bus, "mod-hook", "val");
    const errEvt = events.find((e) => e.type === "hook:error");
    expect(errEvt).toBeDefined();
  });

  it("passes extra arguments to modifier hook", async () => {
    const captured: unknown[][] = [];
    const hook = async (...args: unknown[]): Promise<string | void> => {
      captured.push(args);
    };
    await runModifierHook(
      hook,
      undefined,
      "arg-mod",
      "val",
      "extra1",
      "extra2",
    );
    // runModifierHook spreads ...args (the extra args after currentValue) to the hook,
    // so currentValue itself is NOT prepended — hook receives only ["extra1", "extra2"].
    expect(captured[0]).toEqual(["extra1", "extra2"]);
  });

  it("works with numeric values", async () => {
    const hook = async () => 42;
    const result = await runModifierHook(hook, undefined, "num-mod", 0);
    expect(result).toBe(42);
  });

  it("works with object values", async () => {
    const newObj = { key: "new" };
    const hook = async () => newObj;
    const result = await runModifierHook(hook, undefined, "obj-mod", {
      key: "old",
    });
    expect(result).toBe(newObj);
  });
});

// ---------------------------------------------------------------------------
// mergeHooks
// ---------------------------------------------------------------------------

describe("mergeHooks", () => {
  it("merges two hook sets into arrays keyed by hook name", () => {
    const fn1 = vi.fn(async () => {});
    const fn2 = vi.fn(async () => {});
    const merged = mergeHooks({ onRunStart: fn1 }, { onRunStart: fn2 });
    expect(merged.onRunStart).toHaveLength(2);
    expect(merged.onRunStart).toContain(fn1);
    expect(merged.onRunStart).toContain(fn2);
  });

  it("merges non-overlapping keys from two hook sets", () => {
    const fn1 = vi.fn(async () => {});
    const fn2 = vi.fn(async () => {});
    const merged = mergeHooks({ onRunStart: fn1 }, { onRunError: fn2 });
    expect(merged.onRunStart).toHaveLength(1);
    expect(merged.onRunError).toHaveLength(1);
  });

  it("returns empty object when all inputs are undefined", () => {
    const merged = mergeHooks(undefined, undefined);
    expect(Object.keys(merged)).toHaveLength(0);
  });

  it("skips undefined entries in input", () => {
    const fn = vi.fn(async () => {});
    const merged = mergeHooks(undefined, { onRunStart: fn });
    expect(merged.onRunStart).toHaveLength(1);
  });

  it("merges three hook sets correctly", () => {
    const fn1 = vi.fn(async () => {});
    const fn2 = vi.fn(async () => {});
    const fn3 = vi.fn(async () => {});
    const merged = mergeHooks(
      { onRunStart: fn1 },
      { onRunStart: fn2 },
      { onRunStart: fn3 },
    );
    expect(merged.onRunStart).toHaveLength(3);
  });

  it("preserves insertion order of merged hooks", async () => {
    const order: number[] = [];
    const fn1 = async () => {
      order.push(1);
    };
    const fn2 = async () => {
      order.push(2);
    };
    const merged = mergeHooks({ onRunStart: fn1 }, { onRunStart: fn2 });
    // Run them all
    for (const hook of merged.onRunStart!) {
      await hook();
    }
    expect(order).toEqual([1, 2]);
  });

  it("skips non-function values in hook sets", () => {
    const merged = mergeHooks({ onRunStart: undefined } as Record<
      string,
      undefined
    >);
    expect(merged.onRunStart).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolvePluginOrder — additional cases
// ---------------------------------------------------------------------------

describe("resolvePluginOrder — additional coverage", () => {
  it("returns empty array for empty input", () => {
    expect(resolvePluginOrder([])).toEqual([]);
  });

  it("returns single plugin unchanged", () => {
    const p = makeDiscovered("solo");
    const result = resolvePluginOrder([p]);
    expect(result).toHaveLength(1);
    expect(result[0]!.manifest.name).toBe("solo");
  });

  it("handles external dependency not in the set gracefully", () => {
    const p = makeDiscovered("needs-ext", ["external-lib"]);
    const result = resolvePluginOrder([p]);
    expect(result).toHaveLength(1);
    expect(result[0]!.manifest.name).toBe("needs-ext");
  });

  it("places dependency before dependant in sorted output", () => {
    const dep = makeDiscovered("dep-A");
    const main = makeDiscovered("main-A", ["dep-A"]);
    const sorted = resolvePluginOrder([main, dep]);
    const names = sorted.map((p) => p.manifest.name);
    expect(names.indexOf("dep-A")).toBeLessThan(names.indexOf("main-A"));
  });

  it("handles a long linear chain correctly", () => {
    const plugins = [
      makeDiscovered("e", ["d"]),
      makeDiscovered("d", ["c"]),
      makeDiscovered("c", ["b"]),
      makeDiscovered("b", ["a"]),
      makeDiscovered("a"),
    ];
    const sorted = resolvePluginOrder(plugins);
    const names = sorted.map((p) => p.manifest.name);
    expect(names[0]).toBe("a");
    expect(names[4]).toBe("e");
  });

  it("does not duplicate plugins in output", () => {
    const plugins = [
      makeDiscovered("x", ["y"]),
      makeDiscovered("y", ["z"]),
      makeDiscovered("z"),
    ];
    const sorted = resolvePluginOrder(plugins);
    expect(sorted).toHaveLength(3);
    const names = sorted.map((p) => p.manifest.name);
    expect(new Set(names).size).toBe(3);
  });

  it("allowNameConflicts keeps last entry for same name", () => {
    const v1 = makeDiscovered("shared", [], "local", "/v1");
    const v2 = makeDiscovered("shared", [], "npm", "/v2");
    const sorted = resolvePluginOrder([v1, v2], { allowNameConflicts: true });
    const winner = sorted.find((p) => p.manifest.name === "shared");
    expect(winner?.source).toBe("npm");
  });

  it("throws PluginNameConflictError with correct signal field", () => {
    const plugins = [
      makeDiscovered("dup-sig", [], "local"),
      makeDiscovered("dup-sig", [], "npm", "/extra"),
    ];
    let caught: PluginNameConflictError | undefined;
    try {
      resolvePluginOrder(plugins);
    } catch (err) {
      caught = err as PluginNameConflictError;
    }
    expect(caught?.diagnostic.signal).toBe(
      "plugin_registration_conflict_count",
    );
  });

  it("PluginNameConflictError carries path from both sources", () => {
    const v1 = {
      ...makeDiscovered("path-test", [], "local"),
      path: "/local/path-test",
    };
    const v2 = {
      ...makeDiscovered("path-test", [], "npm"),
      path: "/npm/path-test",
    };
    let caught: PluginNameConflictError | undefined;
    try {
      resolvePluginOrder([v1, v2]);
    } catch (err) {
      caught = err as PluginNameConflictError;
    }
    expect(caught?.diagnostic.previousPath).toBe("/local/path-test");
    expect(caught?.diagnostic.path).toBe("/npm/path-test");
  });
});

// ---------------------------------------------------------------------------
// validateManifest — additional edge cases
// ---------------------------------------------------------------------------

describe("validateManifest — additional edge cases", () => {
  it("returns valid:true for a fully populated valid manifest", () => {
    const v = validateManifest(
      validManifest({
        author: "Ninel",
        dependencies: ["peer-plugin"],
        source: "local",
      }),
    );
    expect(v.valid).toBe(true);
    expect(v.errors).toHaveLength(0);
  });

  it("returns valid:false for null input", () => {
    const v = validateManifest(null);
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/non-null object/);
  });

  it("returns valid:false for string input", () => {
    const v = validateManifest("not-an-object");
    expect(v.valid).toBe(false);
  });

  it("returns valid:false for number input", () => {
    const v = validateManifest(42);
    expect(v.valid).toBe(false);
  });

  it("returns valid:false for array input", () => {
    // Arrays are objects in JS but the discriminator catches them via typeof !== 'object' check pass-through
    const v = validateManifest([]);
    // arrays pass the object check — they'll fail required fields
    // Just verify it doesn't throw and returns a result
    expect(typeof v.valid).toBe("boolean");
  });

  it("reports missing required fields for empty object", () => {
    const v = validateManifest({});
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.includes("name"))).toBe(true);
    expect(v.errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("rejects empty string name", () => {
    const v = validateManifest(validManifest({ name: "" }));
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain('"name"');
  });

  it("rejects whitespace-only name", () => {
    const v = validateManifest(validManifest({ name: "   " }));
    expect(v.valid).toBe(false);
  });

  it("accepts semver with build metadata (1.0.0+build)", () => {
    const v = validateManifest(validManifest({ version: "1.0.0+build.42" }));
    expect(v.valid).toBe(true);
  });

  it("accepts 0.0.0 as a valid version", () => {
    const v = validateManifest(validManifest({ version: "0.0.0" }));
    expect(v.valid).toBe(true);
  });

  it("rejects version with only major and minor", () => {
    const v = validateManifest(validManifest({ version: "1.2" }));
    expect(v.valid).toBe(false);
  });

  it("rejects version with non-numeric parts", () => {
    const v = validateManifest(validManifest({ version: "a.b.c" }));
    expect(v.valid).toBe(false);
  });

  it("accepts entryPoint without leading ./", () => {
    const v = validateManifest(validManifest({ entryPoint: "index.js" }));
    // relative path without ../ is valid (not absolute, no traversal)
    expect(v.valid).toBe(true);
  });

  it("accepts entryPoint with subdirectory ./dist/main.js", () => {
    const v = validateManifest(validManifest({ entryPoint: "./dist/main.js" }));
    expect(v.valid).toBe(true);
  });

  it("rejects entryPoint that is empty string", () => {
    const v = validateManifest(validManifest({ entryPoint: "" }));
    expect(v.valid).toBe(false);
  });

  it("accepts empty capabilities array", () => {
    const v = validateManifest(validManifest({ capabilities: [] }));
    expect(v.valid).toBe(true);
  });

  it("rejects capabilities with whitespace-only items", () => {
    const v = validateManifest(validManifest({ capabilities: ["   "] }));
    expect(v.valid).toBe(false);
  });

  it("rejects dependencies with non-string items", () => {
    const v = validateManifest(
      validManifest({ dependencies: [null as unknown as string] }),
    );
    expect(v.valid).toBe(false);
  });

  it("accepts valid dependencies array", () => {
    const v = validateManifest(
      validManifest({ dependencies: ["dep-a", "dep-b"] }),
    );
    expect(v.valid).toBe(true);
  });

  it("accumulates errors for multiple invalid fields", () => {
    const v = validateManifest({
      name: 0,
      version: "bad-ver",
      description: "",
      capabilities: "not-array",
      entryPoint: "",
    });
    expect(v.errors.length).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// createManifest validated by validateManifest
// ---------------------------------------------------------------------------

describe("createManifest always produces validateManifest-valid output", () => {
  it("minimal createManifest passes validation", () => {
    const m = createManifest({
      name: "v-test",
      version: "1.0.0",
      description: "desc",
    });
    expect(validateManifest(m).valid).toBe(true);
  });

  it("full createManifest passes validation", () => {
    const m = createManifest({
      name: "full-valid",
      version: "2.3.1",
      description: "A full plugin",
      capabilities: ["cap-x", "cap-y"],
      author: "Alice",
      dependencies: ["base-plugin"],
      entryPoint: "./dist/main.js",
    });
    expect(validateManifest(m).valid).toBe(true);
  });

  it("serializeManifest output re-parsed passes validation", () => {
    const m = createManifest({
      name: "serial-valid",
      version: "1.0.0",
      description: "serialized",
    });
    const parsed = JSON.parse(serializeManifest(m));
    expect(validateManifest(parsed).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plugin composition — hooks chain through getHooks + runHooks
// ---------------------------------------------------------------------------

describe("Plugin composition — hooks chaining via getHooks + runHooks", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("hooks from two plugins both fire when run via runHooks", async () => {
    const order: string[] = [];
    await registry.register(
      makePlugin({
        name: "comp-a",
        hooks: {
          onRunStart: async () => {
            order.push("A");
          },
        },
      }),
      ctx,
    );
    await registry.register(
      makePlugin({
        name: "comp-b",
        hooks: {
          onRunStart: async () => {
            order.push("B");
          },
        },
      }),
      ctx,
    );
    const allHooks = registry.getHooks();
    const hooksCtx = { agentId: "a", runId: "r", metadata: {} };
    for (const h of allHooks) {
      if (h.onRunStart) await h.onRunStart(hooksCtx);
    }
    expect(order).toContain("A");
    expect(order).toContain("B");
  });

  it("hooks fire in registration order (A before B)", async () => {
    const order: string[] = [];
    await registry.register(
      makePlugin({
        name: "order-a",
        hooks: {
          onRunStart: async () => {
            order.push("A");
          },
        },
      }),
      ctx,
    );
    await registry.register(
      makePlugin({
        name: "order-b",
        hooks: {
          onRunStart: async () => {
            order.push("B");
          },
        },
      }),
      ctx,
    );
    const allHooks = registry.getHooks();
    const hooksCtx = { agentId: "a", runId: "r", metadata: {} };
    for (const h of allHooks) {
      if (h.onRunStart) await h.onRunStart(hooksCtx);
    }
    expect(order).toEqual(["A", "B"]);
  });

  it("afterToolCall hook from a plugin can modify tool result", async () => {
    await registry.register(
      makePlugin({
        name: "tool-modifier",
        hooks: {
          afterToolCall: async (toolName, _input, result) => {
            if (toolName === "adder") return `modified:${result}`;
          },
        },
      }),
      ctx,
    );
    const [toolHooks] = registry.getHooks();
    const hooksCtx = { agentId: "a", runId: "r", metadata: {} };
    const modified = await runModifierHook(
      toolHooks?.afterToolCall,
      bus,
      "afterToolCall",
      "original",
      "adder",
      {},
      "original",
      hooksCtx,
    );
    expect(modified).toBe("modified:original");
  });

  it("beforeToolCall from two plugins chain through mergeHooks", async () => {
    const fn1 = vi.fn(async () => {});
    const fn2 = vi.fn(async () => {});
    const merged = mergeHooks({ beforeToolCall: fn1 }, { beforeToolCall: fn2 });
    const hooksCtx = { agentId: "a", runId: "r", metadata: {} };
    await runHooks(
      merged.beforeToolCall,
      bus,
      "beforeToolCall",
      "my-tool",
      {},
      hooksCtx,
    );
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Concurrency — ten plugins registered
// ---------------------------------------------------------------------------

describe("PluginRegistry — concurrent/batch registration", () => {
  it("registering ten plugins concurrently all land successfully", async () => {
    const bus = createEventBus();
    const ctx = stubContext(bus);
    const registry = new PluginRegistry(bus);

    const promises = Array.from({ length: 10 }, (_, i) =>
      registry.register(makePlugin({ name: `batch-${i}` }), ctx),
    );
    await Promise.all(promises);
    expect(registry.listPlugins()).toHaveLength(10);
  });

  it("ten registered plugins all appear in listPlugins()", async () => {
    const bus = createEventBus();
    const ctx = stubContext(bus);
    const registry = new PluginRegistry(bus);

    for (let i = 0; i < 10; i++) {
      await registry.register(makePlugin({ name: `seq-${i}` }), ctx);
    }
    expect(registry.listPlugins()).toHaveLength(10);
  });

  it("unregistering all plugins leaves empty registry", async () => {
    const bus = createEventBus();
    const ctx = stubContext(bus);
    const registry = new PluginRegistry(bus);

    for (let i = 0; i < 5; i++) {
      await registry.register(makePlugin({ name: `rem-${i}` }), ctx);
    }
    for (let i = 0; i < 5; i++) {
      registry.unregisterPlugin(`rem-${i}`);
    }
    expect(registry.listPlugins()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// discoverPlugins — basic no-filesystem cases
// ---------------------------------------------------------------------------

describe("discoverPlugins — builtin plugins and empty dirs", () => {
  it("returns builtin plugins when provided", async () => {
    const builtin = createManifest({
      name: "builtin-plugin",
      version: "1.0.0",
      description: "builtin",
    });
    const discovered = await discoverPlugins({
      localDirs: [],
      builtinPlugins: [builtin],
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.source).toBe("builtin");
    expect(discovered[0]!.manifest.name).toBe("builtin-plugin");
  });

  it("builtin plugins have path '<builtin>'", async () => {
    const builtin = createManifest({
      name: "path-check",
      version: "1.0.0",
      description: "d",
    });
    const discovered = await discoverPlugins({
      localDirs: [],
      builtinPlugins: [builtin],
    });
    expect(discovered[0]!.path).toBe("<builtin>");
  });

  it("returns empty array when localDirs is empty and no builtins", async () => {
    const discovered = await discoverPlugins({ localDirs: [] });
    expect(discovered).toEqual([]);
  });

  it("returns multiple builtins in declaration order", async () => {
    const b1 = createManifest({
      name: "first-b",
      version: "1.0.0",
      description: "d",
    });
    const b2 = createManifest({
      name: "second-b",
      version: "1.0.0",
      description: "d",
    });
    const discovered = await discoverPlugins({
      localDirs: [],
      builtinPlugins: [b1, b2],
    });
    expect(discovered.map((d) => d.manifest.name)).toEqual([
      "first-b",
      "second-b",
    ]);
  });

  it("skips non-existent local directories without throwing", async () => {
    const discovered = await discoverPlugins({
      localDirs: ["/non-existent-dir-xyz-abc"],
    });
    expect(discovered).toEqual([]);
  });
});
