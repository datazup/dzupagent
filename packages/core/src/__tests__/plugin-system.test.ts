/**
 * W32-B — Plugin System Deep Coverage (+70 tests)
 *
 * Topics covered:
 *  - PluginRegistry: register, unregister, dispose, overrideExisting, conflict detection
 *  - Plugin lifecycle: init (onRegister) → active (event handlers) → teardown (disposePlugin/unregisterPlugin)
 *  - Plugin that throws during init (graceful error handling, no partial registration)
 *  - Plugin that throws during teardown (best-effort isolation)
 *  - Querying registered plugins (has, get, listPlugins, getMiddleware, getHooks)
 *  - Plugin priority/ordering when multiple plugins handle same hook type
 *  - PluginRegistrationConflictError diagnostic shape
 *  - resolvePluginOrder with allowNameConflicts option and PluginNameConflictError
 *  - validateManifest edge cases (semver, entryPoint path traversal, author, source)
 *  - createManifest defaults and serializeManifest round-trip
 *  - PluginDisposeResult telemetry shape
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PluginRegistry,
  PluginRegistrationConflictError,
} from "../plugin/plugin-registry.js";
import type {
  DzupPlugin,
  PluginContext,
  PluginDisposeResult,
} from "../plugin/plugin-types.js";
import {
  resolvePluginOrder,
  validateManifest,
  PluginNameConflictError,
} from "../plugin/plugin-discovery.js";
import type {
  DiscoveredPlugin,
  PluginManifest,
} from "../plugin/plugin-discovery.js";
import {
  createManifest,
  serializeManifest,
} from "../plugin/plugin-manifest.js";
import { createEventBus } from "../events/event-bus.js";
import type { DzupEventBus } from "../events/event-bus.js";
import type { DzupEvent } from "../events/event-types.js";
import type { ModelRegistry } from "../llm/model-registry.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubContext(eventBus: DzupEventBus): PluginContext {
  return { eventBus, modelRegistry: {} as unknown as ModelRegistry };
}

function makePlugin(overrides: Partial<DzupPlugin> = {}): DzupPlugin {
  return {
    name: "test-plugin",
    version: "1.0.0",
    ...overrides,
  };
}

function makeDiscovered(
  name: string,
  dependencies: string[] = [],
  source: DiscoveredPlugin["source"] = "local",
): DiscoveredPlugin {
  return {
    manifest: {
      name,
      version: "1.0.0",
      description: name,
      capabilities: [],
      entryPoint: "./index.js",
      dependencies,
    },
    path: `/plugins/${name}`,
    source,
  };
}

// ---------------------------------------------------------------------------
// PluginRegistry — unregisterPlugin and disposePlugin
// ---------------------------------------------------------------------------

describe("PluginRegistry — unregisterPlugin", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("unregisterPlugin removes the plugin so has() returns false", async () => {
    await registry.register(makePlugin({ name: "to-remove" }), ctx);
    expect(registry.has("to-remove")).toBe(true);
    registry.unregisterPlugin("to-remove");
    expect(registry.has("to-remove")).toBe(false);
  });

  it("unregisterPlugin removes the plugin from listPlugins()", async () => {
    await registry.register(makePlugin({ name: "alpha" }), ctx);
    await registry.register(makePlugin({ name: "beta" }), ctx);
    registry.unregisterPlugin("alpha");
    expect(registry.listPlugins()).toEqual(["beta"]);
  });

  it("unregisterPlugin returns disposed=true for known plugin", async () => {
    await registry.register(makePlugin({ name: "p" }), ctx);
    const result = registry.unregisterPlugin("p");
    expect(result.disposed).toBe(true);
  });

  it("unregisterPlugin returns disposed=false for unknown plugin", () => {
    const result = registry.unregisterPlugin("ghost");
    expect(result.disposed).toBe(false);
    expect(result.disposerCount).toBe(0);
  });

  it("unregisterPlugin returns telemetry with correct pluginName", async () => {
    await registry.register(makePlugin({ name: "telemetry-test" }), ctx);
    const result = registry.unregisterPlugin("telemetry-test");
    expect(result.telemetry.pluginName).toBe("telemetry-test");
    expect(result.telemetry.signal).toBe("plugin_disposer_cleanup_count");
  });

  it("unregisterPlugin cancels event subscriptions so handlers no longer fire", async () => {
    const handler = vi.fn();
    await registry.register(
      makePlugin({
        name: "evt-plugin",
        eventHandlers: { "agent:started": handler },
      }),
      ctx,
    );
    registry.unregisterPlugin("evt-plugin");
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it("after unregistering, re-registering the same name succeeds", async () => {
    await registry.register(makePlugin({ name: "re-register" }), ctx);
    registry.unregisterPlugin("re-register");
    await expect(
      registry.register(makePlugin({ name: "re-register" }), ctx),
    ).resolves.toBeUndefined();
    expect(registry.has("re-register")).toBe(true);
  });

  it("unregistering one plugin does not affect others", async () => {
    await registry.register(makePlugin({ name: "keep" }), ctx);
    await registry.register(makePlugin({ name: "remove" }), ctx);
    registry.unregisterPlugin("remove");
    expect(registry.has("keep")).toBe(true);
    expect(registry.get("keep")).toBeDefined();
  });

  it("unregisterPlugin reports disposerCount matching event handlers", async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    await registry.register(
      makePlugin({
        name: "two-handlers",
        eventHandlers: {
          "agent:started": handler1,
          "agent:completed": handler2,
        },
      }),
      ctx,
    );
    const result = registry.unregisterPlugin("two-handlers");
    expect(result.disposerCount).toBe(2);
  });

  it("unregisterPlugin with no event handlers has disposerCount 0", async () => {
    await registry.register(makePlugin({ name: "no-events" }), ctx);
    const result = registry.unregisterPlugin("no-events");
    expect(result.disposed).toBe(true);
    expect(result.disposerCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry — disposePlugin (preserves registration)
// ---------------------------------------------------------------------------

describe("PluginRegistry — disposePlugin", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("disposePlugin keeps the plugin in has() after calling", async () => {
    await registry.register(makePlugin({ name: "dispose-me" }), ctx);
    registry.disposePlugin("dispose-me");
    expect(registry.has("dispose-me")).toBe(true);
  });

  it("disposePlugin stops event handlers without removing from registry", async () => {
    const handler = vi.fn();
    await registry.register(
      makePlugin({
        name: "dispose-only",
        eventHandlers: { "agent:started": handler },
      }),
      ctx,
    );
    registry.disposePlugin("dispose-only");
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    // Plugin still visible
    expect(registry.has("dispose-only")).toBe(true);
  });

  it("disposePlugin on unknown name returns disposed=false", () => {
    const result = registry.disposePlugin("no-such-plugin");
    expect(result.disposed).toBe(false);
    expect(result.disposerCount).toBe(0);
    expect(result.telemetry.pluginName).toBe("no-such-plugin");
  });

  it("double dispose is idempotent (second call returns disposerCount 0)", async () => {
    const handler = vi.fn();
    await registry.register(
      makePlugin({
        name: "double-dispose",
        eventHandlers: { "agent:started": handler },
      }),
      ctx,
    );
    const first = registry.disposePlugin("double-dispose");
    const second = registry.disposePlugin("double-dispose");
    expect(first.disposerCount).toBe(1);
    expect(second.disposerCount).toBe(0);
  });

  it("disposePlugin result telemetry carries correct signal", async () => {
    await registry.register(makePlugin({ name: "signal-check" }), ctx);
    const result: PluginDisposeResult = registry.disposePlugin("signal-check");
    expect(result.telemetry.signal).toBe("plugin_disposer_cleanup_count");
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry — overrideExisting option
// ---------------------------------------------------------------------------

describe("PluginRegistry — overrideExisting", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("overrideExisting: true replaces a previously registered plugin", async () => {
    const v1 = makePlugin({ name: "override-me", version: "1.0.0" });
    const v2 = makePlugin({ name: "override-me", version: "2.0.0" });
    await registry.register(v1, ctx);
    await registry.register(v2, ctx, { overrideExisting: true });
    expect(registry.get("override-me")?.version).toBe("2.0.0");
  });

  it("overrideExisting: true disposes old event handlers before replacing", async () => {
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    await registry.register(
      makePlugin({
        name: "ov",
        eventHandlers: { "agent:started": oldHandler },
      }),
      ctx,
    );
    await registry.register(
      makePlugin({
        name: "ov",
        eventHandlers: { "agent:started": newHandler },
      }),
      ctx,
      { overrideExisting: true },
    );
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();
    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).toHaveBeenCalledTimes(1);
  });

  it("overrideExisting: false (default) throws PluginRegistrationConflictError", async () => {
    await registry.register(makePlugin({ name: "conflict" }), ctx);
    await expect(
      registry.register(makePlugin({ name: "conflict" }), ctx, {
        overrideExisting: false,
      }),
    ).rejects.toThrow(PluginRegistrationConflictError);
  });

  it("plugin count does not grow when overrideExisting replaces an existing plugin", async () => {
    await registry.register(makePlugin({ name: "stable-count" }), ctx);
    await registry.register(makePlugin({ name: "other" }), ctx);
    await registry.register(
      makePlugin({ name: "stable-count", version: "2.0.0" }),
      ctx,
      { overrideExisting: true },
    );
    expect(registry.listPlugins()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry — PluginRegistrationConflictError diagnostic
// ---------------------------------------------------------------------------

describe("PluginRegistrationConflictError", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("conflict error carries the correct plugin name in diagnostic", async () => {
    await registry.register(makePlugin({ name: "dup" }), ctx);
    let caught: PluginRegistrationConflictError | undefined;
    try {
      await registry.register(makePlugin({ name: "dup" }), ctx, {
        source: "local",
        path: "/new/path",
      });
    } catch (err) {
      caught = err as PluginRegistrationConflictError;
    }
    expect(caught).toBeDefined();
    expect(caught?.diagnostic.name).toBe("dup");
  });

  it("conflict error message includes the plugin name", async () => {
    await registry.register(makePlugin({ name: "conflict-msg" }), ctx);
    await expect(
      registry.register(makePlugin({ name: "conflict-msg" }), ctx),
    ).rejects.toThrow(/conflict-msg/);
  });

  it("conflict diagnostic includes source and path from options", async () => {
    await registry.register(makePlugin({ name: "src-check" }), ctx, {
      source: "builtin",
      path: "/builtin/path",
    });
    let caught: PluginRegistrationConflictError | undefined;
    try {
      await registry.register(makePlugin({ name: "src-check" }), ctx, {
        source: "local",
        path: "/local/override",
      });
    } catch (err) {
      caught = err as PluginRegistrationConflictError;
    }
    expect(caught?.diagnostic.previousSource).toBe("builtin");
    expect(caught?.diagnostic.previousPath).toBe("/builtin/path");
    expect(caught?.diagnostic.source).toBe("local");
    expect(caught?.diagnostic.path).toBe("/local/override");
  });

  it("PluginRegistrationConflictError has correct error name", async () => {
    await registry.register(makePlugin({ name: "err-name" }), ctx);
    await expect(
      registry.register(makePlugin({ name: "err-name" }), ctx),
    ).rejects.toMatchObject({ name: "PluginRegistrationConflictError" });
  });

  it("conflict diagnostic contains the correct signal field", async () => {
    await registry.register(makePlugin({ name: "signal-p" }), ctx);
    let caught: PluginRegistrationConflictError | undefined;
    try {
      await registry.register(makePlugin({ name: "signal-p" }), ctx);
    } catch (err) {
      caught = err as PluginRegistrationConflictError;
    }
    expect(caught?.diagnostic.signal).toBe(
      "plugin_registration_conflict_count",
    );
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry — plugin lifecycle: init → active → teardown
// ---------------------------------------------------------------------------

describe("PluginRegistry — full lifecycle simulation", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;
  let events: DzupEvent[];

  beforeEach(() => {
    bus = createEventBus();
    events = [];
    bus.onAny((e) => {
      events.push(e);
    });
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("init phase: onRegister is called during register()", async () => {
    const lifecycle: string[] = [];
    await registry.register(
      makePlugin({
        name: "lifecycle",
        onRegister: async () => {
          lifecycle.push("init");
        },
      }),
      ctx,
    );
    expect(lifecycle).toContain("init");
  });

  it("active phase: event handlers fire after successful registration", async () => {
    const fired: string[] = [];
    await registry.register(
      makePlugin({
        name: "active",
        eventHandlers: {
          "agent:started": () => {
            fired.push("started");
          },
        },
      }),
      ctx,
    );
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();
    expect(fired).toContain("started");
  });

  it("teardown phase: disposePlugin stops all handlers", async () => {
    const counts = { before: 0, after: 0 };
    await registry.register(
      makePlugin({
        name: "teardown",
        eventHandlers: {
          "agent:started": () => {
            counts.before++;
          },
        },
      }),
      ctx,
    );
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();
    registry.disposePlugin("teardown");
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();
    expect(counts.before).toBe(1);
  });

  it("plugin:registered event fires during init phase", async () => {
    events.length = 0;
    await registry.register(makePlugin({ name: "evt-lifecycle" }), ctx);
    const reg = events.find((e) => e.type === "plugin:registered");
    expect(reg).toBeDefined();
  });

  it("init throws → plugin is NOT in active state", async () => {
    const onRegister = async (): Promise<void> => {
      throw new Error("init-boom");
    };
    await expect(
      registry.register(makePlugin({ name: "init-throw", onRegister }), ctx),
    ).rejects.toThrow("init-boom");
    expect(registry.has("init-throw")).toBe(false);
  });

  it("init throws → event handlers are NOT subscribed", async () => {
    const handler = vi.fn();
    const onRegister = async (): Promise<void> => {
      throw new Error("no-sub");
    };
    await expect(
      registry.register(
        makePlugin({
          name: "no-sub",
          onRegister,
          eventHandlers: { "agent:started": handler },
        }),
        ctx,
      ),
    ).rejects.toThrow();
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it("teardown via unregisterPlugin: plugin removed AND handlers stopped", async () => {
    const handler = vi.fn();
    await registry.register(
      makePlugin({
        name: "full-teardown",
        eventHandlers: { "agent:completed": handler },
      }),
      ctx,
    );
    registry.unregisterPlugin("full-teardown");
    bus.emit({ type: "agent:completed", agentId: "a", runId: "r" });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    expect(registry.has("full-teardown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry — teardown error isolation
// ---------------------------------------------------------------------------

describe("PluginRegistry — teardown error isolation", () => {
  it("disposePlugin silently catches disposal errors", async () => {
    const bus = createEventBus();
    const ctx = stubContext(bus);
    const registry = new PluginRegistry(bus);

    // Register a plugin with a handler, then mock one disposer to throw
    const handler = vi.fn();
    await registry.register(
      makePlugin({
        name: "throw-on-dispose",
        eventHandlers: { "agent:started": handler },
      }),
      ctx,
    );

    // Grab internal state to inject a throwing disposer
    const realPlugin = (
      registry as unknown as {
        plugins: Map<string, { eventDisposers: Array<() => void> }>;
      }
    ).plugins.get("throw-on-dispose");
    if (realPlugin) {
      realPlugin.eventDisposers.push(() => {
        throw new Error("disposer-bomb");
      });
    }

    // disposePlugin must not throw
    expect(() => registry.disposePlugin("throw-on-dispose")).not.toThrow();
  });

  it("unregisterPlugin silently catches disposal errors", async () => {
    const bus = createEventBus();
    const ctx = stubContext(bus);
    const registry = new PluginRegistry(bus);

    await registry.register(makePlugin({ name: "unreg-throw" }), ctx);

    const realPlugin = (
      registry as unknown as {
        plugins: Map<string, { eventDisposers: Array<() => void> }>;
      }
    ).plugins.get("unreg-throw");
    if (realPlugin) {
      realPlugin.eventDisposers.push(() => {
        throw new Error("unregister-bomb");
      });
    }

    expect(() => registry.unregisterPlugin("unreg-throw")).not.toThrow();
    expect(registry.has("unreg-throw")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry — querying registered plugins
// ---------------------------------------------------------------------------

describe("PluginRegistry — querying", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("get() returns the exact plugin object that was registered", async () => {
    const plugin = makePlugin({ name: "exact" });
    await registry.register(plugin, ctx);
    expect(registry.get("exact")).toBe(plugin);
  });

  it("get() returns undefined after the plugin is unregistered", async () => {
    await registry.register(makePlugin({ name: "gone" }), ctx);
    registry.unregisterPlugin("gone");
    expect(registry.get("gone")).toBeUndefined();
  });

  it("listPlugins() returns empty array when nothing is registered", () => {
    expect(registry.listPlugins()).toEqual([]);
  });

  it("listPlugins() reflects registration order including gaps after removal", async () => {
    await registry.register(makePlugin({ name: "first" }), ctx);
    await registry.register(makePlugin({ name: "second" }), ctx);
    await registry.register(makePlugin({ name: "third" }), ctx);
    registry.unregisterPlugin("second");
    expect(registry.listPlugins()).toEqual(["first", "third"]);
  });

  it("getMiddleware() returns only middleware from plugins that have it", async () => {
    await registry.register(makePlugin({ name: "no-mw" }), ctx);
    await registry.register(
      makePlugin({
        name: "has-mw",
        middleware: [{ name: "my-mw" }],
      }),
      ctx,
    );
    const mw = registry.getMiddleware();
    expect(mw).toHaveLength(1);
    expect(mw[0]!.name).toBe("my-mw");
  });

  it("getMiddleware() excludes middleware from unregistered plugins", async () => {
    await registry.register(
      makePlugin({
        name: "removed-mw",
        middleware: [{ name: "gone-mw" }],
      }),
      ctx,
    );
    await registry.register(
      makePlugin({
        name: "kept-mw",
        middleware: [{ name: "stay-mw" }],
      }),
      ctx,
    );
    registry.unregisterPlugin("removed-mw");
    const mw = registry.getMiddleware();
    expect(mw.map((m) => m.name)).toEqual(["stay-mw"]);
  });

  it("getHooks() includes hooks from all registered plugins", async () => {
    const hooks1 = { onRunStart: vi.fn() };
    const hooks2 = { onRunError: vi.fn() };
    await registry.register(makePlugin({ name: "h1", hooks: hooks1 }), ctx);
    await registry.register(makePlugin({ name: "h2", hooks: hooks2 }), ctx);
    const hooks = registry.getHooks();
    expect(hooks).toHaveLength(2);
    expect(hooks).toContain(hooks1);
    expect(hooks).toContain(hooks2);
  });

  it("getHooks() excludes hooks from unregistered plugin", async () => {
    const hooks = { onRunStart: vi.fn() };
    await registry.register(makePlugin({ name: "hk-gone", hooks }), ctx);
    await registry.register(
      makePlugin({ name: "hk-keep", hooks: { onRunComplete: vi.fn() } }),
      ctx,
    );
    registry.unregisterPlugin("hk-gone");
    const all = registry.getHooks();
    expect(all).toHaveLength(1);
    expect(all[0]).not.toBe(hooks);
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry — hook priority/ordering when multiple plugins handle same hook
// ---------------------------------------------------------------------------

describe("PluginRegistry — hook priority/ordering", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = stubContext(bus);
    registry = new PluginRegistry(bus);
  });

  it("getHooks() preserves registration order across multiple plugins", async () => {
    const order: string[] = [];
    const hookA = {
      onRunStart: async () => {
        order.push("A");
      },
    };
    const hookB = {
      onRunStart: async () => {
        order.push("B");
      },
    };
    const hookC = {
      onRunStart: async () => {
        order.push("C");
      },
    };
    await registry.register(makePlugin({ name: "pA", hooks: hookA }), ctx);
    await registry.register(makePlugin({ name: "pB", hooks: hookB }), ctx);
    await registry.register(makePlugin({ name: "pC", hooks: hookC }), ctx);
    const hooks = registry.getHooks();
    // Simulate calling all onRunStart hooks in order
    const hooksCtx = { agentId: "a", runId: "r", metadata: {} };
    for (const h of hooks) {
      if (h.onRunStart) await h.onRunStart(hooksCtx);
    }
    expect(order).toEqual(["A", "B", "C"]);
  });

  it("getHooks() reflects insertion order when plugin C is registered before A", async () => {
    const hookC = { onRunStart: vi.fn() };
    const hookA = { onRunStart: vi.fn() };
    await registry.register(makePlugin({ name: "pC", hooks: hookC }), ctx);
    await registry.register(makePlugin({ name: "pA", hooks: hookA }), ctx);
    const hooks = registry.getHooks();
    expect(hooks[0]).toBe(hookC);
    expect(hooks[1]).toBe(hookA);
  });

  it("getMiddleware() preserves registration order for priority pipeline", async () => {
    await registry.register(
      makePlugin({ name: "m1", middleware: [{ name: "first-mw" }] }),
      ctx,
    );
    await registry.register(
      makePlugin({ name: "m2", middleware: [{ name: "second-mw" }] }),
      ctx,
    );
    const mw = registry.getMiddleware();
    expect(mw[0]!.name).toBe("first-mw");
    expect(mw[1]!.name).toBe("second-mw");
  });

  it("multiple middlewares from the same plugin keep their internal order", async () => {
    await registry.register(
      makePlugin({
        name: "multi-mw",
        middleware: [{ name: "mw-z" }, { name: "mw-a" }, { name: "mw-m" }],
      }),
      ctx,
    );
    const mw = registry.getMiddleware();
    expect(mw.map((m) => m.name)).toEqual(["mw-z", "mw-a", "mw-m"]);
  });

  it("event handlers from multiple plugins for same event type all fire", async () => {
    const calls: string[] = [];
    await registry.register(
      makePlugin({
        name: "p1",
        eventHandlers: {
          "agent:started": () => {
            calls.push("p1");
          },
        },
      }),
      ctx,
    );
    await registry.register(
      makePlugin({
        name: "p2",
        eventHandlers: {
          "agent:started": () => {
            calls.push("p2");
          },
        },
      }),
      ctx,
    );
    await registry.register(
      makePlugin({
        name: "p3",
        eventHandlers: {
          "agent:started": () => {
            calls.push("p3");
          },
        },
      }),
      ctx,
    );
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();
    expect(calls).toContain("p1");
    expect(calls).toContain("p2");
    expect(calls).toContain("p3");
  });
});

// ---------------------------------------------------------------------------
// resolvePluginOrder — conflict detection and allowNameConflicts
// ---------------------------------------------------------------------------

describe("resolvePluginOrder — conflict detection", () => {
  it("throws PluginNameConflictError when two plugins share a name", () => {
    const plugins = [
      makeDiscovered("same", [], "local"),
      makeDiscovered("same", [], "npm"),
    ];
    // Second entry has different path since makeDiscovered sets /plugins/<name>
    expect(() => resolvePluginOrder(plugins)).toThrow(PluginNameConflictError);
  });

  it("PluginNameConflictError has the correct error name", () => {
    const plugins = [
      makeDiscovered("dup", [], "local"),
      { ...makeDiscovered("dup", [], "builtin"), path: "/other/dup" },
    ];
    let caught: PluginNameConflictError | undefined;
    try {
      resolvePluginOrder(plugins);
    } catch (err) {
      caught = err as PluginNameConflictError;
    }
    expect(caught?.name).toBe("PluginNameConflictError");
  });

  it("PluginNameConflictError diagnostic carries the duplicate plugin name", () => {
    const plugins = [
      makeDiscovered("conflict-name", [], "local"),
      {
        ...makeDiscovered("conflict-name", [], "builtin"),
        path: "/another/path",
      },
    ];
    let caught: PluginNameConflictError | undefined;
    try {
      resolvePluginOrder(plugins);
    } catch (err) {
      caught = err as PluginNameConflictError;
    }
    expect(caught?.diagnostic.name).toBe("conflict-name");
  });

  it("allowNameConflicts: true allows duplicate names without throwing", () => {
    const plugins = [
      makeDiscovered("allow-dup", [], "local"),
      { ...makeDiscovered("allow-dup", [], "npm"), path: "/npm/allow-dup" },
    ];
    expect(() =>
      resolvePluginOrder(plugins, { allowNameConflicts: true }),
    ).not.toThrow();
  });

  it("allowNameConflicts: true — last writer wins for same name", () => {
    const v1: DiscoveredPlugin = {
      ...makeDiscovered("win", [], "local"),
      path: "/local/win",
    };
    const v2: DiscoveredPlugin = {
      ...makeDiscovered("win", [], "npm"),
      path: "/npm/win",
    };
    const sorted = resolvePluginOrder([v1, v2], { allowNameConflicts: true });
    const winner = sorted.find((p) => p.manifest.name === "win");
    expect(winner?.source).toBe("npm");
  });

  it("throws correctly when multiple circular groups exist", () => {
    const plugins = [
      makeDiscovered("a", ["b"]),
      makeDiscovered("b", ["a"]),
      makeDiscovered("c"),
    ];
    expect(() => resolvePluginOrder(plugins)).toThrow(
      /Circular plugin dependency/,
    );
  });

  it("resolves a diamond dependency without duplicates", () => {
    // a → b, a → c, b → d, c → d: d must appear once and before b, c, a
    const plugins = [
      makeDiscovered("a", ["b", "c"]),
      makeDiscovered("b", ["d"]),
      makeDiscovered("c", ["d"]),
      makeDiscovered("d"),
    ];
    const sorted = resolvePluginOrder(plugins);
    const names = sorted.map((p) => p.manifest.name);
    expect(names).toContain("d");
    expect(names.filter((n) => n === "d")).toHaveLength(1);
    expect(names.indexOf("d")).toBeLessThan(names.indexOf("b"));
    expect(names.indexOf("d")).toBeLessThan(names.indexOf("c"));
  });
});

// ---------------------------------------------------------------------------
// validateManifest — additional edge cases
// ---------------------------------------------------------------------------

describe("validateManifest — additional edge cases", () => {
  it("rejects invalid semver version (missing patch)", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0",
      description: "d",
      capabilities: [],
      entryPoint: "./i.js",
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("semver");
  });

  it("accepts pre-release semver (e.g. 1.0.0-alpha.1)", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0-alpha.1",
      description: "d",
      capabilities: [],
      entryPoint: "./i.js",
    });
    expect(v.valid).toBe(true);
  });

  it("rejects absolute entryPoint", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: [],
      entryPoint: "/absolute/path.js",
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("relative");
  });

  it("rejects entryPoint with parent directory traversal", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: [],
      entryPoint: "../../../etc/passwd",
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("..");
  });

  it("rejects entryPoint with Windows-style absolute path", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: [],
      entryPoint: "C:\\absolute\\path.js",
    });
    expect(v.valid).toBe(false);
  });

  it("rejects non-string version", () => {
    const v = validateManifest({
      name: "p",
      version: 1,
      description: "d",
      capabilities: [],
      entryPoint: "./i.js",
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain('"version" must be a string');
  });

  it("rejects non-string description", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: 42,
      capabilities: [],
      entryPoint: "./i.js",
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain('"description" must be a string');
  });

  it("rejects empty description", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "   ",
      capabilities: [],
      entryPoint: "./i.js",
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain('"description" must be non-empty');
  });

  it("rejects invalid source value", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: [],
      entryPoint: "./i.js",
      source: "unknown-src",
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("local, npm, builtin");
  });

  it("accepts valid source values: local, npm, builtin", () => {
    for (const source of ["local", "npm", "builtin"]) {
      const v = validateManifest({
        name: "p",
        version: "1.0.0",
        description: "d",
        capabilities: [],
        entryPoint: "./i.js",
        source,
      });
      expect(v.valid).toBe(true);
    }
  });

  it("rejects non-string author", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: [],
      entryPoint: "./i.js",
      author: 123,
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain('"author" must be a string');
  });

  it("accepts valid optional author string", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: [],
      entryPoint: "./i.js",
      author: "Datazup",
    });
    expect(v.valid).toBe(true);
  });

  it("rejects empty string items in capabilities array", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: [""],
      entryPoint: "./i.js",
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("capabilities[0]");
  });

  it("rejects non-string items in dependencies array", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: [],
      entryPoint: "./i.js",
      dependencies: [42],
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("dependencies[0]");
  });

  it("accumulates multiple errors in a single pass", () => {
    const v = validateManifest({
      name: 123,
      version: "bad",
      description: "",
      capabilities: "x",
      entryPoint: "",
    });
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThan(2);
  });

  it("rejects non-string entryPoint", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: [],
      entryPoint: 99,
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain('"entryPoint" must be a string');
  });
});

// ---------------------------------------------------------------------------
// createManifest and serializeManifest
// ---------------------------------------------------------------------------

describe("createManifest", () => {
  it("applies default entryPoint of ./index.js when not provided", () => {
    const m = createManifest({ name: "p", version: "1.0.0", description: "d" });
    expect(m.entryPoint).toBe("./index.js");
  });

  it("applies empty capabilities array by default", () => {
    const m = createManifest({ name: "p", version: "1.0.0", description: "d" });
    expect(m.capabilities).toEqual([]);
  });

  it("preserves provided capabilities", () => {
    const m = createManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: ["foo", "bar"],
    });
    expect(m.capabilities).toEqual(["foo", "bar"]);
  });

  it("preserves provided entryPoint", () => {
    const m = createManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      entryPoint: "./dist/main.js",
    });
    expect(m.entryPoint).toBe("./dist/main.js");
  });

  it("includes author when provided", () => {
    const m = createManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      author: "Alice",
    });
    expect(m.author).toBe("Alice");
  });

  it("does not include author when not provided", () => {
    const m = createManifest({ name: "p", version: "1.0.0", description: "d" });
    expect(m).not.toHaveProperty("author");
  });

  it("includes dependencies when provided", () => {
    const m = createManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      dependencies: ["other-plugin"],
    });
    expect(m.dependencies).toEqual(["other-plugin"]);
  });

  it("does not include dependencies when not provided", () => {
    const m = createManifest({ name: "p", version: "1.0.0", description: "d" });
    expect(m).not.toHaveProperty("dependencies");
  });
});

describe("serializeManifest", () => {
  it("produces valid JSON", () => {
    const m = createManifest({ name: "p", version: "1.0.0", description: "d" });
    expect(() => JSON.parse(serializeManifest(m))).not.toThrow();
  });

  it("round-trips through JSON.parse faithfully", () => {
    const m = createManifest({
      name: "round-trip",
      version: "2.3.4",
      description: "A plugin",
      capabilities: ["cap-x"],
      author: "Ninel",
      entryPoint: "./src/index.js",
    });
    const parsed = JSON.parse(serializeManifest(m)) as PluginManifest;
    expect(parsed.name).toBe("round-trip");
    expect(parsed.version).toBe("2.3.4");
    expect(parsed.capabilities).toEqual(["cap-x"]);
    expect(parsed.author).toBe("Ninel");
    expect(parsed.entryPoint).toBe("./src/index.js");
  });

  it("produces pretty-printed JSON (indented)", () => {
    const m = createManifest({ name: "p", version: "1.0.0", description: "d" });
    const json = serializeManifest(m);
    expect(json).toContain("\n");
    expect(json).toContain("  ");
  });
});
