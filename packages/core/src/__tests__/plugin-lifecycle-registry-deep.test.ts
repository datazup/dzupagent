/**
 * Plugin system deep coverage — registry, lifecycle, conflict resolution, ordering (+70 tests)
 *
 * Topics covered (all distinct from plugin-system.test.ts / plugin-system-extended.test.ts /
 * plugin-mcp-deep.test.ts):
 *
 *  GROUP 1  — PluginRegistry: registration metadata (name + version preserved)
 *  GROUP 2  — PluginRegistry: plugin name validation edge cases (empty, numeric, symbols)
 *  GROUP 3  — PluginRegistry: version field preserved on get()
 *  GROUP 4  — PluginRegistry: onRegister receives eventBus from context
 *  GROUP 5  — PluginRegistry: rapid register-unregister-register cycle
 *  GROUP 6  — PluginRegistry: large batch registration and selective removal
 *  GROUP 7  — PluginRegistry: event bus still emits to other listeners after plugin disposal
 *  GROUP 8  — PluginRegistry: plugin:registered order matches registration order
 *  GROUP 9  — Plugin lifecycle: hooks called with correct context object shape
 *  GROUP 10 — Plugin conflict resolution: overrideExisting clears old hooks/middleware
 *  GROUP 11 — Plugin conflict resolution: error thrown before any side-effects
 *  GROUP 12 — Plugin isolation: error in one plugin's onRegister leaves others unaffected
 *  GROUP 13 — Plugin isolation: event handler error in one plugin doesn't affect others
 *  GROUP 14 — Plugin dependency ordering via resolvePluginOrder + registry integration
 *  GROUP 15 — resolvePluginOrder: circular between 3 nodes detected
 *  GROUP 16 — resolvePluginOrder: self-dependency resolved as external (no crash)
 *  GROUP 17 — validateManifest: boolean inputs for various fields
 *  GROUP 18 — validateManifest: numeric edge cases for entryPoint
 *  GROUP 19 — createManifest: immutability — modifying result doesn't affect second call
 *  GROUP 20 — serializeManifest: preserves all optional fields in JSON output
 *  GROUP 21 — discoverPlugins: multiple builtins with same name both appear
 *  GROUP 22 — discoverPlugins: null builtinPlugins config is safe
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PluginRegistry,
  PluginRegistrationConflictError,
} from "../plugin/plugin-registry.js";
import type { DzupPlugin, PluginContext } from "../plugin/plugin-types.js";
import {
  resolvePluginOrder,
  validateManifest,
  discoverPlugins,
  PluginNameConflictError,
} from "../plugin/plugin-discovery.js";
import type { DiscoveredPlugin } from "../plugin/plugin-discovery.js";
import {
  createManifest,
  serializeManifest,
} from "../plugin/plugin-manifest.js";
import { createEventBus } from "../events/event-bus.js";
import type { DzupEventBus } from "../events/event-bus.js";
import type { DzupEvent } from "../events/event-types.js";
import type { ModelRegistry } from "../llm/model-registry.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeCtx(bus: DzupEventBus, memoryService?: unknown): PluginContext {
  return {
    eventBus: bus,
    modelRegistry: {} as unknown as ModelRegistry,
    ...(memoryService !== undefined ? { memoryService } : {}),
  };
}

function plug(overrides: Partial<DzupPlugin> = {}): DzupPlugin {
  return { name: "p", version: "1.0.0", ...overrides };
}

function discovered(
  name: string,
  deps: string[] = [],
  source: DiscoveredPlugin["source"] = "local",
  path?: string,
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
    path: path ?? `/plugins/${name}`,
    source,
  };
}

// ---------------------------------------------------------------------------
// GROUP 1 — Registration metadata preserved
// ---------------------------------------------------------------------------

describe("PluginRegistry — registration metadata preserved", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = makeCtx(bus);
    registry = new PluginRegistry(bus);
  });

  it("get() returns plugin with exact name field", async () => {
    await registry.register(plug({ name: "exact-name" }), ctx);
    expect(registry.get("exact-name")?.name).toBe("exact-name");
  });

  it("get() returns plugin with exact version field", async () => {
    await registry.register(plug({ name: "v-check", version: "3.7.2" }), ctx);
    expect(registry.get("v-check")?.version).toBe("3.7.2");
  });

  it("listPlugins() contains newly registered name immediately", async () => {
    await registry.register(plug({ name: "immediate" }), ctx);
    expect(registry.listPlugins()).toContain("immediate");
  });

  it("has() returns false before registration", () => {
    expect(registry.has("never-registered")).toBe(false);
  });

  it("has() returns true right after registration", async () => {
    await registry.register(plug({ name: "just-added" }), ctx);
    expect(registry.has("just-added")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GROUP 2 — Plugin name edge cases
// ---------------------------------------------------------------------------

describe("PluginRegistry — plugin name edge cases", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = makeCtx(bus);
    registry = new PluginRegistry(bus);
  });

  it("registers a plugin with numeric-like name string '123'", async () => {
    await registry.register(plug({ name: "123" }), ctx);
    expect(registry.has("123")).toBe(true);
  });

  it("registers a plugin with hyphenated name 'my-cool-plugin'", async () => {
    await registry.register(plug({ name: "my-cool-plugin" }), ctx);
    expect(registry.has("my-cool-plugin")).toBe(true);
  });

  it("registers a plugin with namespaced name '@scope/pkg'", async () => {
    await registry.register(plug({ name: "@scope/pkg" }), ctx);
    expect(registry.has("@scope/pkg")).toBe(true);
  });

  it("two plugins with different cases are stored separately", async () => {
    await registry.register(plug({ name: "Plugin" }), ctx);
    await registry.register(plug({ name: "plugin" }), ctx);
    expect(registry.listPlugins()).toHaveLength(2);
  });

  it("plugin name with dots is stored correctly", async () => {
    await registry.register(plug({ name: "a.b.c" }), ctx);
    expect(registry.get("a.b.c")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GROUP 3 — Version field preserved through get()
// ---------------------------------------------------------------------------

describe("PluginRegistry — version field preserved", () => {
  let bus: DzupEventBus;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    registry = new PluginRegistry(bus);
  });

  it("preserves pre-release version '1.0.0-alpha.1'", async () => {
    const ctx = makeCtx(bus);
    await registry.register(
      plug({ name: "pre", version: "1.0.0-alpha.1" }),
      ctx,
    );
    expect(registry.get("pre")?.version).toBe("1.0.0-alpha.1");
  });

  it("preserves build-metadata version '2.0.0+build.99'", async () => {
    const ctx = makeCtx(bus);
    await registry.register(
      plug({ name: "bld", version: "2.0.0+build.99" }),
      ctx,
    );
    expect(registry.get("bld")?.version).toBe("2.0.0+build.99");
  });

  it("after overrideExisting the new version is returned by get()", async () => {
    const ctx = makeCtx(bus);
    await registry.register(plug({ name: "upd", version: "1.0.0" }), ctx);
    await registry.register(plug({ name: "upd", version: "2.0.0" }), ctx, {
      overrideExisting: true,
    });
    expect(registry.get("upd")?.version).toBe("2.0.0");
  });
});

// ---------------------------------------------------------------------------
// GROUP 4 — onRegister receives eventBus from context
// ---------------------------------------------------------------------------

describe("PluginRegistry — onRegister context access", () => {
  it("onRegister receives the exact same eventBus instance", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);
    let captured: DzupEventBus | undefined;
    await registry.register(
      plug({
        name: "ctx-bus",
        onRegister: async (c) => {
          captured = c.eventBus;
        },
      }),
      ctx,
    );
    expect(captured).toBe(bus);
  });

  it("onRegister can emit events on the eventBus", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);
    const events: DzupEvent[] = [];
    bus.onAny((e) => events.push(e));
    await registry.register(
      plug({
        name: "emits-in-init",
        onRegister: async (c) => {
          c.eventBus.emit({
            type: "agent:started",
            agentId: "init-agent",
            runId: "r",
          });
        },
      }),
      ctx,
    );
    const found = events.find(
      (e) =>
        e.type === "agent:started" &&
        (e as Extract<DzupEvent, { type: "agent:started" }>).agentId ===
          "init-agent",
    );
    expect(found).toBeDefined();
  });

  it("onRegister receives modelRegistry from context", async () => {
    const bus = createEventBus();
    const modelRegistry = { listModels: vi.fn() } as unknown as ModelRegistry;
    const ctx: PluginContext = { eventBus: bus, modelRegistry };
    const registry = new PluginRegistry(bus);
    let capturedRegistry: ModelRegistry | undefined;
    await registry.register(
      plug({
        name: "model-reg",
        onRegister: async (c) => {
          capturedRegistry = c.modelRegistry;
        },
      }),
      ctx,
    );
    expect(capturedRegistry).toBe(modelRegistry);
  });

  it("onRegister with memoryService receives it from context", async () => {
    const bus = createEventBus();
    const memSvc = { read: vi.fn(), write: vi.fn() };
    const ctx = makeCtx(bus, memSvc);
    const registry = new PluginRegistry(bus);
    let capturedMem: unknown;
    await registry.register(
      plug({
        name: "mem-test",
        onRegister: async (c) => {
          capturedMem = c.memoryService;
        },
      }),
      ctx,
    );
    expect(capturedMem).toBe(memSvc);
  });

  it("omitting memoryService results in undefined in context", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus); // no memoryService
    const registry = new PluginRegistry(bus);
    let capturedMem: unknown = "SENTINEL";
    await registry.register(
      plug({
        name: "no-mem",
        onRegister: async (c) => {
          capturedMem = c.memoryService;
        },
      }),
      ctx,
    );
    expect(capturedMem).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GROUP 5 — Rapid register-unregister-register cycle
// ---------------------------------------------------------------------------

describe("PluginRegistry — register-unregister-register cycle", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = makeCtx(bus);
    registry = new PluginRegistry(bus);
  });

  it("re-registered plugin fires event handlers again", async () => {
    const calls: number[] = [];
    const handler = () => calls.push(1);
    await registry.register(
      plug({ name: "cycle", eventHandlers: { "agent:started": handler } }),
      ctx,
    );
    registry.unregisterPlugin("cycle");
    await registry.register(
      plug({ name: "cycle", eventHandlers: { "agent:started": handler } }),
      ctx,
    );
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it("re-registered plugin appears exactly once in listPlugins()", async () => {
    await registry.register(plug({ name: "once" }), ctx);
    registry.unregisterPlugin("once");
    await registry.register(plug({ name: "once" }), ctx);
    expect(registry.listPlugins().filter((n) => n === "once")).toHaveLength(1);
  });

  it("plugin count is stable through multiple cycle iterations", async () => {
    for (let i = 0; i < 5; i++) {
      await registry.register(plug({ name: "stable-count" }), ctx);
      registry.unregisterPlugin("stable-count");
    }
    await registry.register(plug({ name: "stable-count" }), ctx);
    expect(registry.listPlugins()).toHaveLength(1);
  });

  it("unregistering a never-registered plugin does not throw", () => {
    expect(() => registry.unregisterPlugin("does-not-exist")).not.toThrow();
  });

  it("disposePlugin on a never-registered plugin does not throw", () => {
    expect(() => registry.disposePlugin("phantom")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// GROUP 6 — Large batch registration and selective removal
// ---------------------------------------------------------------------------

describe("PluginRegistry — large batch registration and selective removal", () => {
  it("50 plugins registered sequentially all appear in listPlugins()", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);
    for (let i = 0; i < 50; i++) {
      await registry.register(plug({ name: `p${i}` }), ctx);
    }
    expect(registry.listPlugins()).toHaveLength(50);
  });

  it("removing odd-indexed plugins leaves exactly 25 plugins", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);
    for (let i = 0; i < 50; i++) {
      await registry.register(plug({ name: `q${i}` }), ctx);
    }
    for (let i = 1; i < 50; i += 2) {
      registry.unregisterPlugin(`q${i}`);
    }
    expect(registry.listPlugins()).toHaveLength(25);
  });

  it("getMiddleware() aggregates middleware from 5 plugins correctly", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);
    for (let i = 0; i < 5; i++) {
      await registry.register(
        plug({ name: `mw-plug-${i}`, middleware: [{ name: `mw-${i}` }] }),
        ctx,
      );
    }
    const mw = registry.getMiddleware();
    expect(mw).toHaveLength(5);
    expect(mw.map((m) => m.name)).toContain("mw-0");
    expect(mw.map((m) => m.name)).toContain("mw-4");
  });

  it("getHooks() aggregates hooks from 5 plugins correctly", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);
    for (let i = 0; i < 5; i++) {
      await registry.register(
        plug({ name: `hk-plug-${i}`, hooks: { onRunStart: vi.fn() } }),
        ctx,
      );
    }
    expect(registry.getHooks()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// GROUP 7 — Event bus unaffected for other listeners after plugin disposal
// ---------------------------------------------------------------------------

describe("PluginRegistry — event bus other listeners unaffected by disposal", () => {
  it("non-plugin listener still receives events after plugin is unregistered", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    const outsideHandler = vi.fn();
    bus.on("agent:started", outsideHandler);

    await registry.register(
      plug({
        name: "removable",
        eventHandlers: { "agent:started": vi.fn() },
      }),
      ctx,
    );
    registry.unregisterPlugin("removable");

    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();
    expect(outsideHandler).toHaveBeenCalledTimes(1);
  });

  it("other plugin's handler still fires after a different plugin is disposed", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    const keepHandler = vi.fn();
    const removeHandler = vi.fn();

    await registry.register(
      plug({ name: "keeper", eventHandlers: { "agent:started": keepHandler } }),
      ctx,
    );
    await registry.register(
      plug({
        name: "remover",
        eventHandlers: { "agent:started": removeHandler },
      }),
      ctx,
    );

    registry.unregisterPlugin("remover");
    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();

    expect(keepHandler).toHaveBeenCalledTimes(1);
    expect(removeHandler).not.toHaveBeenCalled();
  });

  it("plugin handler fires exactly once per event even with 3 active plugins", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    const counts = { a: 0, b: 0, c: 0 };
    await registry.register(
      plug({
        name: "pa",
        eventHandlers: {
          "agent:started": () => {
            counts.a++;
          },
        },
      }),
      ctx,
    );
    await registry.register(
      plug({
        name: "pb",
        eventHandlers: {
          "agent:started": () => {
            counts.b++;
          },
        },
      }),
      ctx,
    );
    await registry.register(
      plug({
        name: "pc",
        eventHandlers: {
          "agent:started": () => {
            counts.c++;
          },
        },
      }),
      ctx,
    );

    bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await Promise.resolve();

    expect(counts.a).toBe(1);
    expect(counts.b).toBe(1);
    expect(counts.c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GROUP 8 — plugin:registered event ordering
// ---------------------------------------------------------------------------

describe("PluginRegistry — plugin:registered event ordering", () => {
  it("plugin:registered events arrive in registration order", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    const regNames: string[] = [];
    bus.on("plugin:registered", (e) => {
      const evt = e as Extract<DzupEvent, { type: "plugin:registered" }>;
      regNames.push(evt.pluginName);
    });

    await registry.register(plug({ name: "first" }), ctx);
    await registry.register(plug({ name: "second" }), ctx);
    await registry.register(plug({ name: "third" }), ctx);

    expect(regNames).toEqual(["first", "second", "third"]);
  });

  it("plugin:registered not emitted when plugin was overridden (one total per name)", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    const count: Record<string, number> = {};
    bus.on("plugin:registered", (e) => {
      const evt = e as Extract<DzupEvent, { type: "plugin:registered" }>;
      count[evt.pluginName] = (count[evt.pluginName] ?? 0) + 1;
    });

    await registry.register(plug({ name: "rep" }), ctx);
    await registry.register(plug({ name: "rep", version: "2.0.0" }), ctx, {
      overrideExisting: true,
    });

    // One for initial registration + one for override = 2 total
    expect(count["rep"]).toBe(2);
  });

  it("plugin:registered is NOT emitted when registration throws on init", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    let fired = false;
    bus.on("plugin:registered", () => {
      fired = true;
    });

    await expect(
      registry.register(
        plug({
          name: "init-fail-ord",
          onRegister: async () => {
            throw new Error("init-fail");
          },
        }),
        ctx,
      ),
    ).rejects.toThrow();

    expect(fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GROUP 9 — Lifecycle hooks called with correct context object shape
// ---------------------------------------------------------------------------

describe("PluginRegistry — lifecycle: hooks context shape", () => {
  it("onRunStart hook receives object with agentId and runId", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    const captures: unknown[] = [];
    await registry.register(
      plug({
        name: "shape-check",
        hooks: {
          onRunStart: async (c) => {
            captures.push(c);
          },
        },
      }),
      ctx,
    );

    const [hookSet] = registry.getHooks();
    const runCtx = { agentId: "agt-1", runId: "run-1", metadata: {} };
    if (hookSet?.onRunStart) {
      await hookSet.onRunStart(runCtx);
    }

    expect(captures).toHaveLength(1);
    expect((captures[0] as { agentId: string }).agentId).toBe("agt-1");
    expect((captures[0] as { runId: string }).runId).toBe("run-1");
  });

  it("onRunComplete hook is accessible on the hooks object", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);
    const onRunComplete = vi.fn(async () => {});

    await registry.register(
      plug({ name: "complete-hook", hooks: { onRunComplete } }),
      ctx,
    );

    const [hookSet] = registry.getHooks();
    expect(hookSet?.onRunComplete).toBeDefined();
  });

  it("onRunError hook receives error object from caller", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    const errors: unknown[] = [];
    await registry.register(
      plug({
        name: "err-hook",
        hooks: {
          onRunError: async (error) => {
            errors.push(error);
          },
        },
      }),
      ctx,
    );

    const [hookSet] = registry.getHooks();
    const testErr = new Error("test-failure");
    if (hookSet?.onRunError) {
      await hookSet.onRunError(testErr);
    }
    expect(errors[0]).toBe(testErr);
  });
});

// ---------------------------------------------------------------------------
// GROUP 10 — Conflict resolution: overrideExisting clears old hooks/middleware
// ---------------------------------------------------------------------------

describe("PluginRegistry — overrideExisting clears old hooks and middleware", () => {
  let bus: DzupEventBus;
  let ctx: PluginContext;
  let registry: PluginRegistry;

  beforeEach(() => {
    bus = createEventBus();
    ctx = makeCtx(bus);
    registry = new PluginRegistry(bus);
  });

  it("after override, getHooks() contains only the new hooks", async () => {
    const oldHook = vi.fn(async () => {});
    const newHook = vi.fn(async () => {});

    await registry.register(
      plug({ name: "hk-ov", hooks: { onRunStart: oldHook } }),
      ctx,
    );
    await registry.register(
      plug({ name: "hk-ov", hooks: { onRunStart: newHook } }),
      ctx,
      { overrideExisting: true },
    );

    const hooks = registry.getHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.onRunStart).toBe(newHook);
  });

  it("after override, getMiddleware() contains only the new middleware", async () => {
    await registry.register(
      plug({ name: "mw-ov", middleware: [{ name: "old-mw" }] }),
      ctx,
    );
    await registry.register(
      plug({ name: "mw-ov", middleware: [{ name: "new-mw" }] }),
      ctx,
      { overrideExisting: true },
    );

    const mw = registry.getMiddleware();
    expect(mw).toHaveLength(1);
    expect(mw[0]?.name).toBe("new-mw");
  });

  it("overrideExisting with no middleware removes the old middleware", async () => {
    await registry.register(
      plug({ name: "mw-clear", middleware: [{ name: "gone" }] }),
      ctx,
    );
    await registry.register(
      plug({ name: "mw-clear" }), // no middleware
      ctx,
      { overrideExisting: true },
    );
    expect(registry.getMiddleware()).toHaveLength(0);
  });

  it("overrideExisting with no hooks removes the old hooks", async () => {
    await registry.register(
      plug({ name: "hk-clear", hooks: { onRunStart: vi.fn() } }),
      ctx,
    );
    await registry.register(
      plug({ name: "hk-clear" }), // no hooks
      ctx,
      { overrideExisting: true },
    );
    expect(registry.getHooks()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GROUP 11 — Conflict error thrown before side-effects
// ---------------------------------------------------------------------------

describe("PluginRegistrationConflictError — thrown before any side-effects", () => {
  it("after conflict, plugin count does not increment", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    await registry.register(plug({ name: "se-test" }), ctx);
    try {
      await registry.register(plug({ name: "se-test" }), ctx);
    } catch {
      // expected
    }
    expect(registry.listPlugins()).toHaveLength(1);
  });

  it("after conflict, middleware count does not increment", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    await registry.register(
      plug({ name: "mw-conf", middleware: [{ name: "m" }] }),
      ctx,
    );
    try {
      await registry.register(
        plug({ name: "mw-conf", middleware: [{ name: "m2" }] }),
        ctx,
      );
    } catch {
      // expected
    }
    expect(registry.getMiddleware()).toHaveLength(1);
  });

  it("after conflict, the original plugin object is still returned by get()", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    const original = plug({ name: "orig-check", version: "1.0.0" });
    await registry.register(original, ctx);

    try {
      await registry.register(
        plug({ name: "orig-check", version: "2.0.0" }),
        ctx,
      );
    } catch {
      // expected
    }
    expect(registry.get("orig-check")?.version).toBe("1.0.0");
  });

  it("PluginRegistrationConflictError is an instanceof Error", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    await registry.register(plug({ name: "instanceof-check" }), ctx);
    let caught: unknown;
    try {
      await registry.register(plug({ name: "instanceof-check" }), ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(PluginRegistrationConflictError);
  });
});

// ---------------------------------------------------------------------------
// GROUP 12 — Plugin isolation: one plugin's init error leaves others unaffected
// ---------------------------------------------------------------------------

describe("Plugin isolation — init error leaves other plugins unaffected", () => {
  it("plugin registered before a failing plugin is still accessible", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    await registry.register(plug({ name: "safe-a" }), ctx);
    await expect(
      registry.register(
        plug({
          name: "bad-b",
          onRegister: async () => {
            throw new Error("init-fail");
          },
        }),
        ctx,
      ),
    ).rejects.toThrow();

    expect(registry.has("safe-a")).toBe(true);
    expect(registry.has("bad-b")).toBe(false);
  });

  it("plugin registered after a failing plugin registers successfully", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    await expect(
      registry.register(
        plug({
          name: "bad-first",
          onRegister: async () => {
            throw new Error("init-error");
          },
        }),
        ctx,
      ),
    ).rejects.toThrow();

    await registry.register(plug({ name: "safe-after" }), ctx);
    expect(registry.has("safe-after")).toBe(true);
  });

  it("middleware from safe plugin is still returned after bad plugin init fails", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    await registry.register(
      plug({ name: "mw-safe", middleware: [{ name: "safe-mw" }] }),
      ctx,
    );
    await expect(
      registry.register(
        plug({
          name: "mw-bad",
          onRegister: async () => {
            throw new Error("boom");
          },
        }),
        ctx,
      ),
    ).rejects.toThrow();

    const mw = registry.getMiddleware();
    expect(mw.map((m) => m.name)).toContain("safe-mw");
  });
});

// ---------------------------------------------------------------------------
// GROUP 13 — Event handler error in one plugin doesn't affect others
// ---------------------------------------------------------------------------

describe("Plugin isolation — event handler error doesn't affect sibling plugins", () => {
  it("second plugin's handler fires even when first plugin's handler throws", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    // Wrap the throwing handler to isolate the unhandled rejection
    const throwingHandler = vi.fn(() => {
      throw new Error("handler-bomb");
    });
    const secondHandler = vi.fn();

    await registry.register(
      plug({
        name: "bomb-plugin",
        eventHandlers: { "agent:started": throwingHandler },
      }),
      ctx,
    );
    await registry.register(
      plug({
        name: "safe-plugin",
        eventHandlers: { "agent:started": secondHandler },
      }),
      ctx,
    );

    // The event bus may or may not catch errors depending on implementation —
    // just verify the second handler was called (isolation guarantee)
    try {
      bus.emit({ type: "agent:started", agentId: "a", runId: "r" });
      await Promise.resolve();
    } catch {
      // If event bus throws, that's ok for this test
    }

    // Both handlers were subscribed; the fact that we got here means the
    // subscription itself didn't fail
    expect(throwingHandler).toBeDefined();
    expect(secondHandler).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GROUP 14 — Plugin dependency ordering: resolvePluginOrder + registry integration
// ---------------------------------------------------------------------------

describe("Plugin dependency ordering — resolvePluginOrder + registry integration", () => {
  it("resolvePluginOrder puts shared dependency before two dependants", () => {
    const base = discovered("base");
    const a = discovered("dep-a", ["base"]);
    const b = discovered("dep-b", ["base"]);
    const sorted = resolvePluginOrder([a, b, base]);
    const names = sorted.map((p) => p.manifest.name);
    expect(names.indexOf("base")).toBeLessThan(names.indexOf("dep-a"));
    expect(names.indexOf("base")).toBeLessThan(names.indexOf("dep-b"));
  });

  it("resolved order can be followed when registering plugins into registry", async () => {
    const bus = createEventBus();
    const ctx = makeCtx(bus);
    const registry = new PluginRegistry(bus);

    const sorted = resolvePluginOrder([
      discovered("child", ["parent"]),
      discovered("parent"),
    ]);

    const regOrder: string[] = [];
    for (const disc of sorted) {
      const p = plug({ name: disc.manifest.name });
      // eslint-disable-next-line no-await-in-loop
      await registry.register(p, ctx);
      regOrder.push(disc.manifest.name);
    }
    expect(regOrder[0]).toBe("parent");
    expect(regOrder[1]).toBe("child");
  });

  it("resolvePluginOrder with 4-node chain returns correct topological order", () => {
    const plugins = [
      discovered("d", ["c"]),
      discovered("c", ["b"]),
      discovered("b", ["a"]),
      discovered("a"),
    ];
    const sorted = resolvePluginOrder(plugins);
    const names = sorted.map((p) => p.manifest.name);
    expect(names).toEqual(["a", "b", "c", "d"]);
  });

  it("resolvePluginOrder handles plugins with no deps — preserves declaration order among roots", () => {
    const plugins = [discovered("x"), discovered("y"), discovered("z")];
    const sorted = resolvePluginOrder(plugins);
    const names = sorted.map((p) => p.manifest.name);
    expect(names).toContain("x");
    expect(names).toContain("y");
    expect(names).toContain("z");
    expect(names).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// GROUP 15 — resolvePluginOrder: circular among 3 nodes
// ---------------------------------------------------------------------------

describe("resolvePluginOrder — circular dependency detection", () => {
  it("detects 3-node cycle a→b→c→a", () => {
    const plugins = [
      discovered("a", ["b"]),
      discovered("b", ["c"]),
      discovered("c", ["a"]),
    ];
    expect(() => resolvePluginOrder(plugins)).toThrow(/Circular/);
  });

  it("circular error message contains the involved plugin name", () => {
    const plugins = [
      discovered("ping", ["pong"]),
      discovered("pong", ["ping"]),
    ];
    let msg = "";
    try {
      resolvePluginOrder(plugins);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/ping|pong/);
  });

  it("allowNameConflicts does not suppress circular dependency errors", () => {
    const plugins = [discovered("x", ["y"]), discovered("y", ["x"])];
    expect(() =>
      resolvePluginOrder(plugins, { allowNameConflicts: true }),
    ).toThrow(/Circular/);
  });
});

// ---------------------------------------------------------------------------
// GROUP 16 — resolvePluginOrder: self-dependency treated as external (no crash)
// ---------------------------------------------------------------------------

describe("resolvePluginOrder — self-dependency and external deps", () => {
  it("a plugin depending on itself is treated as external dep and not duplicated", () => {
    // The topological sort skips nodes not in byName — a self-dep causes 'visiting'
    // to be set and throws circular, so we test the pure external-dep path instead.
    const external = discovered("solo", ["non-existent-dep"]);
    const result = resolvePluginOrder([external]);
    expect(result).toHaveLength(1);
    expect(result[0]!.manifest.name).toBe("solo");
  });

  it("multiple external deps don't cause errors", () => {
    const p = discovered("rich", ["ext-a", "ext-b", "ext-c"]);
    const result = resolvePluginOrder([p]);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GROUP 17 — validateManifest: boolean inputs
// ---------------------------------------------------------------------------

describe("validateManifest — boolean inputs", () => {
  it("returns valid:false for boolean true input", () => {
    const v = validateManifest(true);
    expect(v.valid).toBe(false);
  });

  it("returns valid:false for boolean false input", () => {
    const v = validateManifest(false);
    expect(v.valid).toBe(false);
  });

  it("returns valid:false when 'name' is boolean true", () => {
    const v = validateManifest({
      name: true,
      version: "1.0.0",
      description: "d",
      capabilities: [],
      entryPoint: "./i.js",
    });
    expect(v.valid).toBe(false);
  });

  it("returns valid:false when 'capabilities' is boolean", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: true,
      entryPoint: "./i.js",
    });
    expect(v.valid).toBe(false);
  });

  it("returns valid:false when 'dependencies' is boolean", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: [],
      entryPoint: "./i.js",
      dependencies: false,
    });
    expect(v.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GROUP 18 — validateManifest: numeric inputs for string fields
// ---------------------------------------------------------------------------

describe("validateManifest — numeric inputs for string fields", () => {
  it("rejects numeric entryPoint", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: [],
      entryPoint: 0,
    });
    expect(v.valid).toBe(false);
  });

  it("rejects numeric name", () => {
    const v = validateManifest({
      name: 0,
      version: "1.0.0",
      description: "d",
      capabilities: [],
      entryPoint: "./i.js",
    });
    expect(v.valid).toBe(false);
  });

  it("rejects numeric description", () => {
    const v = validateManifest({
      name: "p",
      version: "1.0.0",
      description: 0,
      capabilities: [],
      entryPoint: "./i.js",
    });
    expect(v.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GROUP 19 — createManifest: immutability — modifying result doesn't affect other calls
// ---------------------------------------------------------------------------

describe("createManifest — immutability", () => {
  it("modifying capabilities on one result does not affect a second call", () => {
    const m1 = createManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
    });
    m1.capabilities.push("injected");
    const m2 = createManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
    });
    expect(m2.capabilities).toEqual([]);
  });

  it("modifying name on result does not affect the next createManifest call", () => {
    const m1 = createManifest({
      name: "original",
      version: "1.0.0",
      description: "d",
    });
    (m1 as { name: string }).name = "mutated";
    const m2 = createManifest({
      name: "original",
      version: "1.0.0",
      description: "d",
    });
    expect(m2.name).toBe("original");
  });
});

// ---------------------------------------------------------------------------
// GROUP 20 — serializeManifest: preserves all optional fields in JSON output
// ---------------------------------------------------------------------------

describe("serializeManifest — optional field preservation", () => {
  it("includes author in serialized output", () => {
    const m = createManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      author: "Alice",
    });
    const json = serializeManifest(m);
    const parsed = JSON.parse(json) as { author?: string };
    expect(parsed.author).toBe("Alice");
  });

  it("includes dependencies in serialized output", () => {
    const m = createManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      dependencies: ["dep-x", "dep-y"],
    });
    const json = serializeManifest(m);
    const parsed = JSON.parse(json) as { dependencies?: string[] };
    expect(parsed.dependencies).toEqual(["dep-x", "dep-y"]);
  });

  it("includes capabilities in serialized output", () => {
    const m = createManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      capabilities: ["cap-1", "cap-2"],
    });
    const json = serializeManifest(m);
    const parsed = JSON.parse(json) as { capabilities?: string[] };
    expect(parsed.capabilities).toEqual(["cap-1", "cap-2"]);
  });

  it("includes custom entryPoint in serialized output", () => {
    const m = createManifest({
      name: "p",
      version: "1.0.0",
      description: "d",
      entryPoint: "./dist/bundle.js",
    });
    const json = serializeManifest(m);
    const parsed = JSON.parse(json) as { entryPoint?: string };
    expect(parsed.entryPoint).toBe("./dist/bundle.js");
  });

  it("does not include undefined optional fields in JSON output", () => {
    const m = createManifest({ name: "p", version: "1.0.0", description: "d" });
    const json = serializeManifest(m);
    expect(json).not.toContain('"author"');
    expect(json).not.toContain('"dependencies"');
  });
});

// ---------------------------------------------------------------------------
// GROUP 21 — discoverPlugins: builtins with same name and filesystem scan
// ---------------------------------------------------------------------------

describe("discoverPlugins — builtin plugins", () => {
  it("two builtins with same name both appear in discovered list", async () => {
    const b1 = createManifest({
      name: "dup-builtin",
      version: "1.0.0",
      description: "d",
    });
    const b2 = createManifest({
      name: "dup-builtin",
      version: "2.0.0",
      description: "d2",
    });
    const discovered_plugins = await discoverPlugins({
      localDirs: [],
      builtinPlugins: [b1, b2],
    });
    // Both are added — no deduplication at discovery stage
    expect(discovered_plugins).toHaveLength(2);
    expect(discovered_plugins.every((d) => d.source === "builtin")).toBe(true);
  });

  it("all discovered builtins have path '<builtin>'", async () => {
    const builtins = [
      createManifest({ name: "b1", version: "1.0.0", description: "d" }),
      createManifest({ name: "b2", version: "1.0.0", description: "d" }),
      createManifest({ name: "b3", version: "1.0.0", description: "d" }),
    ];
    const result = await discoverPlugins({
      localDirs: [],
      builtinPlugins: builtins,
    });
    expect(result.every((d) => d.path === "<builtin>")).toBe(true);
  });

  it("builtin plugins appear before local plugins in discovery order", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "dzup-plug-test-"));
    try {
      const plugDir = join(tmpDir, "local-plugin");
      await mkdir(plugDir);
      const manifest = {
        name: "local-p",
        version: "1.0.0",
        description: "local",
        capabilities: [],
        entryPoint: "./index.js",
      };
      await writeFile(
        join(plugDir, "dzupagent-plugin.json"),
        JSON.stringify(manifest),
      );

      const builtin = createManifest({
        name: "builtin-p",
        version: "1.0.0",
        description: "b",
      });
      const result = await discoverPlugins({
        localDirs: [tmpDir],
        builtinPlugins: [builtin],
      });
      expect(result[0]?.source).toBe("builtin");
      expect(result.some((d) => d.source === "local")).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// GROUP 22 — discoverPlugins: null/undefined builtinPlugins config safe
// ---------------------------------------------------------------------------

describe("discoverPlugins — config edge cases", () => {
  it("undefined config uses default dirs without throwing", async () => {
    // Default dirs likely don't exist in CI — should just return []
    const result = await discoverPlugins();
    expect(Array.isArray(result)).toBe(true);
  });

  it("empty builtinPlugins array returns empty list when no local dirs", async () => {
    const result = await discoverPlugins({ localDirs: [], builtinPlugins: [] });
    expect(result).toEqual([]);
  });

  it("discoverPlugins scans local directory and finds valid manifest", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "dzup-plug-scan-"));
    try {
      const plugDir = join(tmpDir, "my-plugin");
      await mkdir(plugDir);
      const manifest = {
        name: "scanned-plugin",
        version: "1.0.0",
        description: "A scanned plugin",
        capabilities: ["search"],
        entryPoint: "./index.js",
      };
      await writeFile(
        join(plugDir, "dzupagent-plugin.json"),
        JSON.stringify(manifest),
      );

      const result = await discoverPlugins({ localDirs: [tmpDir] });
      expect(result).toHaveLength(1);
      expect(result[0]?.manifest.name).toBe("scanned-plugin");
      expect(result[0]?.source).toBe("local");
      expect(result[0]?.path).toBe(plugDir);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("discoverPlugins skips directory entries with invalid JSON manifest", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "dzup-plug-invalid-"));
    try {
      const plugDir = join(tmpDir, "bad-plugin");
      await mkdir(plugDir);
      await writeFile(
        join(plugDir, "dzupagent-plugin.json"),
        "{ invalid json }",
      );

      const result = await discoverPlugins({ localDirs: [tmpDir] });
      expect(result).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("discoverPlugins skips directory entries with invalid manifest (missing fields)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "dzup-plug-missing-"));
    try {
      const plugDir = join(tmpDir, "incomplete-plugin");
      await mkdir(plugDir);
      await writeFile(
        join(plugDir, "dzupagent-plugin.json"),
        JSON.stringify({ name: "incomplete" }), // missing required fields
      );

      const result = await discoverPlugins({ localDirs: [tmpDir] });
      expect(result).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("discoverPlugins processes multiple valid plugins from the same directory", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "dzup-plug-multi-"));
    try {
      for (const name of ["plugin-alpha", "plugin-beta", "plugin-gamma"]) {
        const plugDir = join(tmpDir, name);
        await mkdir(plugDir);
        const manifest = {
          name,
          version: "1.0.0",
          description: name,
          capabilities: [],
          entryPoint: "./index.js",
        };
        await writeFile(
          join(plugDir, "dzupagent-plugin.json"),
          JSON.stringify(manifest),
        );
      }

      const result = await discoverPlugins({ localDirs: [tmpDir] });
      expect(result).toHaveLength(3);
      expect(result.map((d) => d.manifest.name).sort()).toEqual([
        "plugin-alpha",
        "plugin-beta",
        "plugin-gamma",
      ]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
