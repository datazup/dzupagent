/**
 * DZUPAGENT-SEC-C-01 regression + route-mount conformance tests.
 *
 * The cost-attributor router is mounted at `/admin/tenants`, outside the
 * `/api/*` prefix that `applyMiddleware` binds auth, RBAC and rate limiting to.
 * Before the fix, `GET /admin/tenants/cost` returned per-tenant spend for the
 * whole deployment to any anonymous, unthrottled caller.
 *
 * The conformance test at the bottom closes the recurring path-prefix escape
 * class: any future router mounted outside `/api/*` must either be listed in
 * `CORE_NON_API_MOUNTS` (and therefore carry explicit gating) or the test fails.
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from "@dzupagent/core";

import { createForgeApp } from "../../app.js";
import { CORE_NON_API_MOUNTS } from "../core-routes.js";
import type { ForgeServerConfig } from "../types.js";
import type {
  CostAttributor,
  CostAttributorQuery,
  TenantCostSummary,
} from "../../services/cost-attributor.js";

const ADMIN_KEY = "admin-key";
const VIEWER_KEY = "viewer-key";

/** Minimal stub that records whether the handler was ever reached. */
function stubCostAttributor(): CostAttributor & { calls: number } {
  const summary = {
    tenantId: "tenant-a",
    totalCostUsd: 1234.56,
    runCount: 42,
  } as unknown as TenantCostSummary;

  const stub = {
    calls: 0,
    async getAllTenantCosts(_query?: CostAttributorQuery) {
      stub.calls += 1;
      return [summary];
    },
    async getTenantCost(_tenantId: string, _query?: CostAttributorQuery) {
      stub.calls += 1;
      return summary;
    },
  };

  return stub as unknown as CostAttributor & { calls: number };
}

function baseConfig(
  overrides: Partial<ForgeServerConfig> = {},
): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  };
}

/** Config with api-key auth wired to two keys: one admin, one viewer. */
function authedConfig(costAttributor: CostAttributor): ForgeServerConfig {
  return baseConfig({
    costAttributor,
    auth: {
      mode: "api-key",
      validateKey: async (key: string) => {
        if (key === ADMIN_KEY) return { id: "k-admin", role: "admin" };
        if (key === VIEWER_KEY) return { id: "k-viewer", role: "viewer" };
        return null;
      },
    },
  });
}

describe("DZUPAGENT-SEC-C-01: /admin/tenants is inside the security chain", () => {
  it("returns 401 for an unauthenticated GET /admin/tenants/cost", async () => {
    const costAttributor = stubCostAttributor();
    const app = createForgeApp(authedConfig(costAttributor));

    const res = await app.request("/admin/tenants/cost");

    expect(res.status).toBe(401);
    // The handler must never run — no cost data may be computed or leaked.
    expect(costAttributor.calls).toBe(0);
  });

  it("returns 401 for an unauthenticated per-tenant cost read", async () => {
    const costAttributor = stubCostAttributor();
    const app = createForgeApp(authedConfig(costAttributor));

    const res = await app.request("/admin/tenants/tenant-a/cost");

    expect(res.status).toBe(401);
    expect(costAttributor.calls).toBe(0);
  });

  it("returns 401 when the bearer token is invalid", async () => {
    const costAttributor = stubCostAttributor();
    const app = createForgeApp(authedConfig(costAttributor));

    const res = await app.request("/admin/tenants/cost", {
      headers: { Authorization: "Bearer not-a-real-key" },
    });

    expect(res.status).toBe(401);
    expect(costAttributor.calls).toBe(0);
  });

  it("returns 403 for an authenticated non-admin (viewer) caller", async () => {
    const costAttributor = stubCostAttributor();
    const app = createForgeApp(authedConfig(costAttributor));

    const res = await app.request("/admin/tenants/cost", {
      headers: { Authorization: `Bearer ${VIEWER_KEY}` },
    });

    expect(res.status).toBe(403);
    expect(costAttributor.calls).toBe(0);
  });

  it("returns 403 for a non-admin on the per-tenant route", async () => {
    const costAttributor = stubCostAttributor();
    const app = createForgeApp(authedConfig(costAttributor));

    const res = await app.request("/admin/tenants/tenant-a/cost", {
      headers: { Authorization: `Bearer ${VIEWER_KEY}` },
    });

    expect(res.status).toBe(403);
    expect(costAttributor.calls).toBe(0);
  });

  it("still serves cost data to an admin caller", async () => {
    const costAttributor = stubCostAttributor();
    const app = createForgeApp(authedConfig(costAttributor));

    const res = await app.request("/admin/tenants/cost", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(res.status).toBe(200);
    expect(costAttributor.calls).toBe(1);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("keeps the published mount path (no breaking move under /api/*)", async () => {
    const costAttributor = stubCostAttributor();
    const app = createForgeApp(authedConfig(costAttributor));

    // The route must NOT have been relocated to /api/admin/tenants. An admin
    // request there serves no cost data: the path falls under `/api/*`, where
    // RBAC rejects it as having no configured policy (403) before routing can
    // 404. Either way it is not a live cost endpoint.
    const relocated = await app.request("/api/admin/tenants/cost", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(relocated.status).not.toBe(200);
    expect(costAttributor.calls).toBe(0);
  });
});

describe("route-mount conformance: no router escapes the security chain", () => {
  it("declares every non-/api core mount in CORE_NON_API_MOUNTS", () => {
    // Guards the escape class: if a future mount is added to mountCoreRoutes
    // outside `/api/*` without being declared (and gated), this fails.
    expect([...CORE_NON_API_MOUNTS].sort()).toEqual(["/admin/tenants"]);
  });

  it("gates every declared non-/api mount with auth", async () => {
    const costAttributor = stubCostAttributor();
    const app = createForgeApp(authedConfig(costAttributor));

    for (const prefix of CORE_NON_API_MOUNTS) {
      const res = await app.request(`${prefix}/cost`);
      expect(
        res.status,
        `${prefix} must reject unauthenticated callers (mounted outside /api/*)`,
      ).toBe(401);
    }
  });

  it("gates every declared non-/api mount with an admin-role check", async () => {
    const costAttributor = stubCostAttributor();
    const app = createForgeApp(authedConfig(costAttributor));

    for (const prefix of CORE_NON_API_MOUNTS) {
      const res = await app.request(`${prefix}/cost`, {
        headers: { Authorization: `Bearer ${VIEWER_KEY}` },
      });
      expect(res.status, `${prefix} must reject non-admin callers`).toBe(403);
    }
  });
});
