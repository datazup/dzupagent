/**
 * DZUPAGENT-SEC-L-05 + SEC-I-05: least-privilege RBAC default role and
 * non-trusting tenant source.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createDefaultRbacConfig } from "../composition/middleware.js";
import {
  tenantScopeMiddleware,
  getTenantId,
} from "../middleware/tenant-scope.js";
import type { ForgeServerConfig } from "../composition/types.js";

function fakeCtx(apiKey: Record<string, unknown> | undefined): {
  get: (key: string) => unknown;
} {
  return { get: (key: string) => (key === "apiKey" ? apiKey : undefined) };
}

describe("createDefaultRbacConfig — default role (SEC-L-05)", () => {
  const rbac = createDefaultRbacConfig({} as ForgeServerConfig);

  it("defaults a role-less key to the least-privilege viewer role", () => {
    expect(rbac.extractRole?.(fakeCtx({ id: "k1" }) as never)).toBe("viewer");
  });

  it("defaults an undefined apiKey to viewer", () => {
    expect(rbac.extractRole?.(fakeCtx(undefined) as never)).toBe("viewer");
  });

  it("honours an explicitly configured role", () => {
    expect(
      rbac.extractRole?.(fakeCtx({ id: "k1", role: "operator" }) as never)
    ).toBe("operator");
    expect(
      rbac.extractRole?.(fakeCtx({ id: "k1", role: "admin" }) as never)
    ).toBe("admin");
  });
});

describe("tenantScopeMiddleware — tenant source (SEC-I-05)", () => {
  function appWith(config: Parameters<typeof tenantScopeMiddleware>[0]): Hono {
    const app = new Hono();
    app.use("*", tenantScopeMiddleware(config));
    app.get("/api/thing", (c) => c.json({ tenantId: getTenantId(c) ?? null }));
    return app;
  }

  it("rejects with 400 when extractor returns nothing and header fallback is OFF (default)", async () => {
    const app = appWith({ extractTenantId: () => undefined });
    const res = await app.request("/api/thing", {
      headers: { "X-Tenant-ID": "attacker-tenant" },
    });
    // Client header is NOT trusted by default — request is rejected.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MISSING_TENANT");
  });

  it("uses the server-derived tenant from the extractor", async () => {
    const app = appWith({ extractTenantId: () => "server-tenant" });
    const res = await app.request("/api/thing", {
      headers: { "X-Tenant-ID": "attacker-tenant" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string | null };
    // Server-trusted value wins; the client header is ignored.
    expect(body.tenantId).toBe("server-tenant");
  });

  it("honours the client header ONLY when explicitly opted in", async () => {
    const app = appWith({
      extractTenantId: () => undefined,
      allowHeaderTenantFallback: true,
    });
    const res = await app.request("/api/thing", {
      headers: { "X-Tenant-ID": "trusted-network-tenant" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string | null };
    expect(body.tenantId).toBe("trusted-network-tenant");
  });
});
