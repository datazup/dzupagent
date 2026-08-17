/**
 * Plugin contributions reaching a REAL agent run — via `DzupAgentConfig.pluginRegistry`.
 *
 * `PluginRegistry.getHooks()` and `getMiddleware()` shipped with zero
 * production consumers. A plugin's `hooks` / `middleware` could be declared,
 * registered and aggregated, and nothing anywhere handed them to an agent — so
 * `onRunStart`, `beforeModelCall` and `beforeAgent` were *declared but never
 * dispatched*. `PluginRegistry.toAgentHooks()` later supplied the missing
 * collapse from `Partial<AgentHooks>[]` to the single `AgentHooks` object the
 * config declares, but only as an opt-in helper the caller had to remember;
 * a caller passing `hooks: myOwnHooks` (which is what every doc example does)
 * still got plugin hooks that never ran.
 *
 * ## What every test here must do, and why
 *
 * Asserting on a merged config object would reproduce the exact defect class
 * one level up: "present in an object" is precisely what was already true and
 * still never dispatched. So every spec below
 *
 *   - passes ONLY `pluginRegistry` on the config (never `hooks: registry.
 *     toAgentHooks(...)` at the call site),
 *   - drives a REAL `DzupAgent.generate()`,
 *   - asserts the plugin's contribution fired as a CONSEQUENCE — call counts
 *     and arguments, not existence,
 *   - and, where the point is that something fires, carries a CONTROL arm in
 *     which the registry is not passed and the same spy must be at zero.
 *
 * Deleting `applyPluginRegistry` from the constructor, or flipping the merge
 * order, must make specs here fail.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createEventBus } from "@dzupagent/core/events";
import type { DzupEventBus } from "@dzupagent/core/events";
import { PluginRegistry } from "@dzupagent/core/plugins";
import type { DzupPlugin, PluginContext } from "@dzupagent/core/plugins";
import type { AgentMiddleware, ModelRegistry } from "@dzupagent/core/llm";
import type { HookContext } from "@dzupagent/core/orchestration";
import { DzupAgent } from "../agent/dzip-agent.js";
import type { DzupAgentConfig } from "../agent/agent-types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type MockChatModel = BaseChatModel & {
  invoke: ReturnType<typeof vi.fn>;
  /** Per-call SNAPSHOT of the transcript the run handed the provider. */
  sent: BaseMessage[][];
};

/**
 * Non-streaming model; `invoke` is a spy so we can read what the run sent it.
 *
 * The transcript is snapshotted (`[...messages]`) rather than read back off
 * `invoke.mock.calls`: the tool loop APPENDS the response to the very array it
 * passed in, so a by-reference read shows the assistant reply sitting in the
 * "input" and any assertion over it is measuring the wrong moment.
 */
function createMockModel(content = "hello"): MockChatModel {
  const sent: BaseMessage[][] = [];
  return {
    sent,
    invoke: vi.fn(async (messages: BaseMessage[]) => {
      sent.push([...messages]);
      return new AIMessage(content);
    }),
    bindTools: vi.fn().mockReturnThis(),
  } as unknown as MockChatModel;
}

function stubContext(eventBus: DzupEventBus): PluginContext {
  return { eventBus, modelRegistry: {} as unknown as ModelRegistry };
}

/** Registry on its own fresh bus, with `plugins` registered in array order. */
async function registryWith(
  plugins: DzupPlugin[],
  bus: DzupEventBus = createEventBus()
): Promise<PluginRegistry> {
  const registry = new PluginRegistry(bus);
  for (const plugin of plugins) {
    await registry.register(plugin, stubContext(bus));
  }
  return registry;
}

/**
 * Base config for a one-shot run. Deliberately carries NO `hooks` and NO
 * `middleware` — anything a spec observes must have arrived via the registry.
 */
function baseConfig(id: string, model: MockChatModel): DzupAgentConfig {
  return { id, instructions: "test", model };
}

// ---------------------------------------------------------------------------
// 1. The lane's point: a registered plugin's run hook FIRES during a real run
// ---------------------------------------------------------------------------

describe("pluginRegistry — plugin run hooks dispatch during a real generate()", () => {
  it("fires a plugin's onRunStart, with the run's real context", async () => {
    const onRunStart = vi.fn(async (_ctx: HookContext) => {});
    const plugin: DzupPlugin = {
      name: "observer",
      version: "1.0.0",
      hooks: { onRunStart },
    };
    const registry = await registryWith([plugin]);

    const agent = new DzupAgent({
      ...baseConfig("plugin-hook-fires", createMockModel()),
      pluginRegistry: registry,
      // NOTE: no `hooks:` here. The whole point is that registering the
      // plugin is sufficient.
    });

    await agent.generate([new HumanMessage("hi")], { runId: "run-plugin-1" });

    expect(onRunStart).toHaveBeenCalledTimes(1);
    // Argument, not just arity: a stub dispatch handing over an empty context
    // would pass a bare call-count assertion. The fixture DISAGREES with any
    // default — nothing else in this run is named `plugin-hook-fires`.
    const ctx = onRunStart.mock.calls[0]![0];
    expect(ctx.agentId).toBe("plugin-hook-fires");
    expect(ctx.runId).toBe("run-plugin-1");
  });

  it("CONTROL — the same plugin registered but the registry NOT passed: zero calls", async () => {
    const onRunStart = vi.fn(async (_ctx: HookContext) => {});
    const plugin: DzupPlugin = {
      name: "observer",
      version: "1.0.0",
      hooks: { onRunStart },
    };
    // Registered exactly as above; simply never handed to the agent.
    await registryWith([plugin]);

    const agent = new DzupAgent(
      baseConfig("plugin-hook-control", createMockModel())
    );
    await agent.generate([new HumanMessage("hi")], { runId: "run-plugin-1" });

    expect(onRunStart).toHaveBeenCalledTimes(0);
  });

  it("fires a plugin's onRunComplete with the very GenerateResult the caller receives", async () => {
    const onRunComplete = vi.fn(async (_ctx: HookContext, _result: unknown) => {});
    const registry = await registryWith([
      { name: "completer", version: "1.0.0", hooks: { onRunComplete } },
    ]);

    const agent = new DzupAgent({
      ...baseConfig("plugin-complete", createMockModel("payload-content")),
      pluginRegistry: registry,
    });

    const result = await agent.generate([new HumanMessage("hi")]);

    expect(onRunComplete).toHaveBeenCalledTimes(1);
    // Identity, not shape — the hook must see the same object, not a copy.
    expect(onRunComplete.mock.calls[0]![1]).toBe(result);
  });

  it("fans out to EVERY registered plugin, in registration order", async () => {
    const log: string[] = [];
    const registry = await registryWith([
      {
        name: "first",
        version: "1.0.0",
        hooks: { onRunStart: async () => void log.push("first") },
      },
      {
        name: "second",
        version: "1.0.0",
        hooks: { onRunStart: async () => void log.push("second") },
      },
    ]);

    const agent = new DzupAgent({
      ...baseConfig("plugin-fanout", createMockModel()),
      pluginRegistry: registry,
    });
    await agent.generate([new HumanMessage("hi")]);

    expect(log).toEqual(["first", "second"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Precedence: plugins first, the config's own hooks LAST
// ---------------------------------------------------------------------------

describe("pluginRegistry — hook precedence", () => {
  it("runs plugin hooks BEFORE the config's own hook", async () => {
    const log: string[] = [];
    const registry = await registryWith([
      {
        name: "ambient",
        version: "1.0.0",
        hooks: { onRunStart: async () => void log.push("plugin") },
      },
    ]);

    const agent = new DzupAgent({
      ...baseConfig("hook-order", createMockModel()),
      pluginRegistry: registry,
      hooks: { onRunStart: async () => void log.push("config") },
    });
    await agent.generate([new HumanMessage("hi")]);

    // Both ran (neither was dropped by the merge) AND in this exact order.
    // Flipping the merge order in `applyPluginRegistry` inverts this array.
    expect(log).toEqual(["plugin", "config"]);
  });

  it("on a CONFLICTING return value the config's own modifier hook wins", async () => {
    // `beforeModelCall` is a modifier: each contributor receives the previous
    // one's output and the LAST non-void return is what reaches the model.
    // Plugins running first therefore means an ambient plugin can never
    // silently overrule the application author.
    const pluginSaw: BaseMessage[][] = [];
    const configSaw: BaseMessage[][] = [];

    const registry = await registryWith([
      {
        name: "rewriter",
        version: "1.0.0",
        hooks: {
          beforeModelCall: async (messages) => {
            pluginSaw.push(messages);
            return [new HumanMessage("from-plugin")];
          },
        },
      },
    ]);

    const model = createMockModel();
    const agent = new DzupAgent({
      ...baseConfig("hook-conflict", model),
      pluginRegistry: registry,
      hooks: {
        beforeModelCall: async (messages) => {
          configSaw.push(messages);
          return [new HumanMessage("from-config")];
        },
      },
    });
    await agent.generate([new HumanMessage("original")]);

    // Both fired exactly once.
    expect(pluginSaw).toHaveLength(1);
    expect(configSaw).toHaveLength(1);

    // Threading order: the plugin saw the ORIGINAL transcript; the config hook
    // saw the PLUGIN's output. Flip the merge order and both of these invert.
    expect(pluginSaw[0]!.some((m) => m.content === "from-plugin")).toBe(false);
    expect(configSaw[0]!.map((m) => m.content)).toEqual(["from-plugin"]);

    // And the value that escaped to the provider is the CONFIG's.
    expect(model.sent).toHaveLength(1);
    expect(model.sent[0]!.map((m) => m.content)).toEqual(["from-config"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Middleware: same registry, same construction-time merge
// ---------------------------------------------------------------------------

describe("pluginRegistry — plugin middleware reaches the run", () => {
  it("a plugin's beforeAgent joins the EXISTING state flow (seeded in, merged out)", async () => {
    // Point of this spec: plugin middleware must ride the same
    // `prepareRunState` -> `GenerateResult.middlewareState` channel the config
    // middleware already uses, not a parallel one.
    const seen: Record<string, unknown>[] = [];
    const middleware: AgentMiddleware = {
      name: "plugin-mw",
      beforeAgent: async (state) => {
        seen.push(state);
        return { contributedByPlugin: true };
      },
    };
    const registry = await registryWith([
      { name: "mw-plugin", version: "1.0.0", middleware: [middleware] },
    ]);

    const agent = new DzupAgent({
      ...baseConfig("plugin-mw-state", createMockModel()),
      pluginRegistry: registry,
    });
    const result = await agent.generate([new HumanMessage("hi")], {
      runId: "run-mw-1",
    });

    expect(seen).toHaveLength(1);
    // INBOUND half: the run's seeded facts, not a bare `{}`.
    expect(seen[0]!["agentId"]).toBe("plugin-mw-state");
    expect(seen[0]!["runId"]).toBe("run-mw-1");
    expect(seen[0]!).toHaveProperty("maxIterations");
    // OUTBOUND half: the patch reaches the caller's result.
    expect(result.middlewareState?.["contributedByPlugin"]).toBe(true);
  });

  it("CONTROL — registry not passed: the middleware never runs and nothing is contributed", async () => {
    const beforeAgent = vi.fn(async () => ({ contributedByPlugin: true }));
    await registryWith([
      {
        name: "mw-plugin",
        version: "1.0.0",
        middleware: [{ name: "plugin-mw", beforeAgent }],
      },
    ]);

    const agent = new DzupAgent(
      baseConfig("plugin-mw-control", createMockModel())
    );
    const result = await agent.generate([new HumanMessage("hi")]);

    expect(beforeAgent).toHaveBeenCalledTimes(0);
    expect(result.middlewareState?.["contributedByPlugin"]).toBeUndefined();
  });

  it("plugin middleware runs BEFORE config middleware, and the config's patch wins a key conflict", async () => {
    const log: string[] = [];
    const registry = await registryWith([
      {
        name: "mw-plugin",
        version: "1.0.0",
        middleware: [
          {
            name: "plugin-mw",
            beforeAgent: async () => {
              log.push("plugin");
              return { owner: "plugin", fromPlugin: true };
            },
          },
        ],
      },
    ]);

    const agent = new DzupAgent({
      ...baseConfig("mw-order", createMockModel()),
      pluginRegistry: registry,
      middleware: [
        {
          name: "config-mw",
          beforeAgent: async (state) => {
            log.push("config");
            // Proves threading, not just ordering: the config middleware
            // observes the plugin's patch.
            expect(state["fromPlugin"]).toBe(true);
            return { owner: "config" };
          },
        },
      ],
    });
    const result = await agent.generate([new HumanMessage("hi")]);

    expect(log).toEqual(["plugin", "config"]);
    // `runBeforeAgentHooks` is last-wins, so config-last means config wins.
    expect(result.middlewareState?.["owner"]).toBe("config");
  });

  it("pins the ONE first-wins seam: a plugin's wrapModelCall PRE-EMPTS the config's", async () => {
    // `AgentMiddlewareRuntime.invokeModel` selects with `.find(...)`, i.e.
    // FIRST-wins — the opposite of the other three seams. Plugins-first
    // therefore lets a plugin pre-empt the app here. That asymmetry is
    // pre-existing behaviour of the middleware runtime, and reordering the
    // merge to hide it would break the three last-wins seams. It is locked
    // here rather than silently inherited: if this expectation ever flips,
    // the merge order or `invokeModel` changed and the config JSDoc is stale.
    const pluginWrap = vi.fn(async () => new AIMessage("from-plugin-wrapper"));
    const configWrap = vi.fn(async () => new AIMessage("from-config-wrapper"));

    const registry = await registryWith([
      {
        name: "wrap-plugin",
        version: "1.0.0",
        middleware: [{ name: "plugin-wrap", wrapModelCall: pluginWrap }],
      },
    ]);

    const agent = new DzupAgent({
      ...baseConfig("mw-wrap", createMockModel()),
      pluginRegistry: registry,
      middleware: [{ name: "config-wrap", wrapModelCall: configWrap }],
    });
    const result = await agent.generate([new HumanMessage("hi")]);

    expect(pluginWrap).toHaveBeenCalled();
    expect(configWrap).not.toHaveBeenCalled();
    expect(result.content).toBe("from-plugin-wrapper");
  });
});

// ---------------------------------------------------------------------------
// 4. Nothing regresses when `pluginRegistry` is absent
// ---------------------------------------------------------------------------

describe("pluginRegistry — absent", () => {
  it("passes the config through BY IDENTITY (not a clone, not a composition)", async () => {
    // The strongest available statement of 'byte-identical to today': the
    // effective config is the very object the caller handed in, so no key can
    // have been added, dropped or rewritten.
    const config = baseConfig("no-registry", createMockModel());
    const agent = new DzupAgent(config);
    expect(agent.agentConfig).toBe(config);
  });

  it("leaves config hooks and middleware exactly as supplied", async () => {
    const hooks = { onRunStart: vi.fn(async () => {}) };
    const middleware: AgentMiddleware[] = [{ name: "only-mine" }];
    const config: DzupAgentConfig = {
      ...baseConfig("no-registry-2", createMockModel()),
      hooks,
      middleware,
    };
    const agent = new DzupAgent(config);

    // Same references — not wrapped in a fan-out, not re-arrayed.
    expect(agent.agentConfig.hooks).toBe(hooks);
    expect(agent.agentConfig.middleware).toBe(middleware);

    await agent.generate([new HumanMessage("hi")]);
    expect(hooks.onRunStart).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Idempotence — the effective config must not re-compose
// ---------------------------------------------------------------------------

describe("pluginRegistry — idempotence of the effective config", () => {
  it("strips pluginRegistry, so an agent derived from agentConfig does not double-fire", async () => {
    const onRunStart = vi.fn(async () => {});
    const registry = await registryWith([
      { name: "once", version: "1.0.0", hooks: { onRunStart } },
    ]);

    const agent = new DzupAgent({
      ...baseConfig("idempotent", createMockModel()),
      pluginRegistry: registry,
    });
    // The documented derivation: `new DzupAgent({ ...agent.agentConfig, ... })`.
    expect(agent.agentConfig.pluginRegistry).toBeUndefined();

    const derived = new DzupAgent({
      ...agent.agentConfig,
      id: "idempotent-derived",
    });
    await derived.generate([new HumanMessage("hi")]);

    // Once per run, not twice. Leaving the registry on the effective config
    // would compose the same plugin hook a second time here.
    expect(onRunStart).toHaveBeenCalledTimes(1);
  });

  it("does not mutate the caller's config object", async () => {
    const registry = await registryWith([
      { name: "p", version: "1.0.0", hooks: { onRunStart: async () => {} } },
    ]);
    const config: DzupAgentConfig = {
      ...baseConfig("no-mutate", createMockModel()),
      pluginRegistry: registry,
    };
    new DzupAgent(config);

    // A shared registry is reused across agents; clobbering the caller's
    // object would make the second `new DzupAgent(config)` behave differently.
    expect(config.pluginRegistry).toBe(registry);
    expect(config.hooks).toBeUndefined();
  });

  it("one registry serves several agents independently", async () => {
    const onRunStart = vi.fn(async (ctx: HookContext) => {
      void ctx;
    });
    const registry = await registryWith([
      { name: "shared", version: "1.0.0", hooks: { onRunStart } },
    ]);

    const a = new DzupAgent({
      ...baseConfig("shared-a", createMockModel()),
      pluginRegistry: registry,
    });
    const b = new DzupAgent({
      ...baseConfig("shared-b", createMockModel()),
      pluginRegistry: registry,
    });
    await a.generate([new HumanMessage("hi")]);
    await b.generate([new HumanMessage("hi")]);

    expect(onRunStart).toHaveBeenCalledTimes(2);
    expect(onRunStart.mock.calls.map((c) => c[0].agentId)).toEqual([
      "shared-a",
      "shared-b",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. Bus ownership for hook errors
// ---------------------------------------------------------------------------

describe("pluginRegistry — which bus receives hook:error", () => {
  it("reports a throwing plugin hook on the AGENT's bus when the agent has one", async () => {
    const registryBus = createEventBus();
    const agentBus = createEventBus();
    const onRegistryBus: unknown[] = [];
    const onAgentBus: unknown[] = [];
    registryBus.on("hook:error", (e) => void onRegistryBus.push(e));
    agentBus.on("hook:error", (e) => void onAgentBus.push(e));

    const registry = await registryWith(
      [
        {
          name: "thrower",
          version: "1.0.0",
          hooks: {
            onRunStart: async () => {
              throw new Error("boom");
            },
          },
        },
      ],
      registryBus
    );

    const agent = new DzupAgent({
      ...baseConfig("bus-agent", createMockModel()),
      pluginRegistry: registry,
      eventBus: agentBus,
    });

    // Non-fatal: the run still completes.
    const result = await agent.generate([new HumanMessage("hi")]);
    expect(result.content).toBe("hello");

    // The error belongs on the bus this agent's telemetry goes to.
    expect(onAgentBus).toHaveLength(1);
    expect(onRegistryBus).toHaveLength(0);
  });

  it("falls back to the REGISTRY's bus when the agent has none, so nothing is dropped", async () => {
    const registryBus = createEventBus();
    const onRegistryBus: unknown[] = [];
    registryBus.on("hook:error", (e) => void onRegistryBus.push(e));

    const registry = await registryWith(
      [
        {
          name: "thrower",
          version: "1.0.0",
          hooks: {
            onRunStart: async () => {
              throw new Error("boom");
            },
          },
        },
      ],
      registryBus
    );

    const agent = new DzupAgent({
      ...baseConfig("bus-none", createMockModel()),
      pluginRegistry: registry,
      // deliberately no eventBus
    });
    await agent.generate([new HumanMessage("hi")]);

    expect(onRegistryBus).toHaveLength(1);
  });
});
