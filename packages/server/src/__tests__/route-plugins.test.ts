import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { createForgeApp, type ForgeServerConfig } from "../app.js";
import type {
  ServerRoutePlugin,
  ServerRoutePluginContext,
} from "../route-plugin.js";
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from "@dzupagent/core";

function createTestConfig(
  routePlugins: ServerRoutePlugin[] = []
): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    routePlugins,
  };
}

describe("Route plugins", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mounts plugin routes via createRoutes and calls onMount", async () => {
    const pluginApp = new Hono();
    pluginApp.get("/ping", (c) => c.json({ ok: true }));

    const createRoutes = vi.fn(() => pluginApp);
    const onMount = vi.fn();

    const app = createForgeApp(
      createTestConfig([
        {
          prefix: "/api/custom",
          createRoutes,
          onMount,
        },
      ])
    );

    const response = await app.request("/api/custom/ping");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    expect(createRoutes).toHaveBeenCalledTimes(1);
    expect(onMount).toHaveBeenCalledTimes(1);

    // RF-8 (ARCH-M-05): createRoutes receives a NARROW context — eventBus,
    // optional auth/metrics, and a declaredServices capability map — and NOT
    // the full ForgeServerConfig. There must be no `serverConfig` kitchen-sink
    // field and no host stores reachable through the context.
    const createCtx = createRoutes.mock
      .calls[0]?.[0] as ServerRoutePluginContext;
    expect(createCtx.eventBus).toBeDefined();
    expect(createCtx.declaredServices).toEqual({ auth: false, metrics: false });
    expect((createCtx as Record<string, unknown>).serverConfig).toBeUndefined();
    expect((createCtx as Record<string, unknown>).runStore).toBeUndefined();

    // onMount keeps the lifecycle escape hatch: arg[0] is the mounted host
    // config (broad), arg[1] is the SAME narrow context createRoutes received.
    const mountedConfig = onMount.mock.calls[0]?.[0] as ForgeServerConfig;
    const mountCtx = onMount.mock.calls[0]?.[1] as ServerRoutePluginContext;
    expect(mountedConfig.runStore).toBeDefined();
    expect(mountedConfig.runExecutor).toBeDefined();
    expect(mountCtx).toBe(createCtx);
  });

  it("skips plugin mount when prefix does not start with slash", async () => {
    const createRoutes = vi.fn(() => {
      const app = new Hono();
      app.get("/ping", (c) => c.json({ ok: true }));
      return app;
    });
    const onMount = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = createForgeApp(
      createTestConfig([
        {
          prefix: "api/invalid",
          createRoutes,
          onMount,
        },
      ])
    );

    const response = await app.request("/api/invalid/ping");
    expect(response.status).toBe(404);
    expect(createRoutes).not.toHaveBeenCalled();
    expect(onMount).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("api/invalid")
    );
  });
});
