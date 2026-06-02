/**
 * DZUPAGENT-SEC-M-03: Role-based access control for routing telemetry.
 *
 * Verifies that the operator/admin RBAC gate on
 * `GET /api/runs/routing-stats` is enforced by the centralised RBAC
 * middleware (not inline in the route handler). Viewer keys must be
 * rejected with 403 even though they can read other `/api/runs` paths;
 * operator and admin keys must still receive 200.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createForgeApp, type ForgeServerConfig } from "../app.js";
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from "@dzupagent/core";

interface KeyRecord {
  id: string;
  tenantId: string;
  role: "admin" | "operator" | "viewer";
}

const KEYS: Record<string, KeyRecord> = {
  "key-viewer": { id: "key-viewer", tenantId: "tenant-a", role: "viewer" },
  "key-operator": {
    id: "key-operator",
    tenantId: "tenant-a",
    role: "operator",
  },
  "key-admin": { id: "key-admin", tenantId: "tenant-a", role: "admin" },
};

function createAuthedConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    auth: {
      mode: "api-key",
      validateKey: async (token: string) => {
        const record = KEYS[token];
        return record ? ({ ...record } as Record<string, unknown>) : null;
      },
    },
  };
}

describe("Routing stats route — RBAC (DZUPAGENT-SEC-M-03)", () => {
  let config: ForgeServerConfig;
  let app: ReturnType<typeof createForgeApp>;

  beforeEach(async () => {
    config = createAuthedConfig();
    app = createForgeApp(config);
    await config.agentStore.save({
      id: "agent-1",
      name: "Test Agent",
      instructions: "test",
      modelTier: "chat",
    });
  });

  it("rejects viewer role with 403 FORBIDDEN", async () => {
    const res = await app.request("/api/runs/routing-stats", {
      headers: { Authorization: "Bearer key-viewer" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("routingTelemetry");
  });

  it("allows operator role with 200", async () => {
    await config.runStore.create({
      agentId: "agent-1",
      input: "test",
      ownerId: "key-operator",
      tenantId: "tenant-a",
      metadata: {
        modelTier: "chat",
        routingReason: "low_complexity",
        complexity: "low",
      },
    });

    const res = await app.request("/api/runs/routing-stats", {
      headers: { Authorization: "Bearer key-operator" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { totalRuns: number } };
    expect(body.data.totalRuns).toBe(1);
  });

  it("allows admin role with 200", async () => {
    const res = await app.request("/api/runs/routing-stats", {
      headers: { Authorization: "Bearer key-admin" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { totalRuns: number } };
    expect(body.data.totalRuns).toBe(0);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.request("/api/runs/routing-stats");
    expect(res.status).toBe(401);
  });

  it("still allows viewer to read the broader /api/runs list (no over-restriction)", async () => {
    // Sanity check: the more-specific routing-stats gate must NOT bleed
    // into the broader /api/runs prefix. A viewer should still see runs.
    const res = await app.request("/api/runs", {
      headers: { Authorization: "Bearer key-viewer" },
    });
    expect(res.status).toBe(200);
  });
});

describe("Routing stats route — legacy ownerless gate (DZUPAGENT-SEC-M-03)", () => {
  const LEGACY_SCOPE = "routing:legacy-ownerless";

  function configWith(
    keys: Record<string, Record<string, unknown>>
  ): ForgeServerConfig {
    return {
      runStore: new InMemoryRunStore(),
      agentStore: new InMemoryAgentStore(),
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
      auth: {
        mode: "api-key",
        validateKey: async (token: string) => {
          const record = keys[token];
          return record ? { ...record } : null;
        },
      },
    };
  }

  async function seedOwnerlessRun(config: ForgeServerConfig): Promise<void> {
    await config.agentStore.save({
      id: "agent-1",
      name: "Test Agent",
      instructions: "test",
      modelTier: "chat",
    });
    // A legacy ownerless run (no ownerId) in tenant-a.
    await config.runStore.create({
      agentId: "agent-1",
      input: "legacy-ownerless",
      tenantId: "tenant-a",
      metadata: {
        modelTier: "chat",
        routingReason: "low_complexity",
        complexity: "low",
      },
    });
  }

  it("operator WITHOUT the legacy scope cannot see ownerless rows (default off)", async () => {
    const config = configWith({
      "key-op": { id: "key-op", tenantId: "tenant-a", role: "operator" },
    });
    const app = createForgeApp(config);
    await seedOwnerlessRun(config);

    const res = await app.request("/api/runs/routing-stats", {
      headers: { Authorization: "Bearer key-op" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { totalRuns: number } };
    // Ownerless run is NOT visible without the explicit legacy scope.
    expect(body.data.totalRuns).toBe(0);
  });

  it("operator WITH the legacy scope can see ownerless rows", async () => {
    const config = configWith({
      "key-op-legacy": {
        id: "key-op-legacy",
        tenantId: "tenant-a",
        role: "operator",
        scopes: [LEGACY_SCOPE],
      },
    });
    const app = createForgeApp(config);
    await seedOwnerlessRun(config);

    const res = await app.request("/api/runs/routing-stats", {
      headers: { Authorization: "Bearer key-op-legacy" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { totalRuns: number } };
    expect(body.data.totalRuns).toBe(1);
  });

  it("legacy scope WITHOUT operator/admin role is insufficient (role still required)", async () => {
    // A viewer is already 403'd by the RBAC middleware, but assert the inner
    // gate would also reject: even if the key carries the scope, a non-
    // privileged role must not unlock ownerless rows. We use an operator-
    // mounted path indirectly via the 403 from middleware for viewers; here
    // we confirm an operator key WITH scope is the only thing that unlocks it.
    const config = configWith({
      "key-viewer-legacy": {
        id: "key-viewer-legacy",
        tenantId: "tenant-a",
        role: "viewer",
        scopes: [LEGACY_SCOPE],
      },
    });
    const app = createForgeApp(config);
    await seedOwnerlessRun(config);

    const res = await app.request("/api/runs/routing-stats", {
      headers: { Authorization: "Bearer key-viewer-legacy" },
    });
    // Centralised RBAC middleware rejects viewer before the handler runs.
    expect(res.status).toBe(403);
  });
});
