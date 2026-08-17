/**
 * Deep route tests for API key management endpoints.
 *
 * Covers: create, list, revoke, rotate with all validation branches,
 * owner-scoping, tier allow-listing, expiry logic, and error mapping.
 *
 * No real database — uses an in-memory store that mirrors the shape of
 * PostgresApiKeyStore (same pattern as integration.test.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createApiKeyRoutes } from "../routes/api-keys.js";
import type {
  ApiKeyRecord,
  CreateApiKeyResult,
} from "../persistence/api-key-store.js";
import type { AppEnv } from "../types.js";

// ---------------------------------------------------------------------------
// In-memory stand-in for PostgresApiKeyStore
// ---------------------------------------------------------------------------

class InMemoryApiKeyStore {
  private readonly keys = new Map<string, ApiKeyRecord & { rawKey: string }>();
  private idCounter = 0;

  async create(
    ownerId: string,
    name: string,
    tier: string = "standard",
    options: {
      role?: string;
      expiresAt?: Date | null;
      expiresIn?: number;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<CreateApiKeyResult> {
    const id = `key-${++this.idCounter}`;
    const rawKey = `raw-${id}`;
    let expiresAt = options.expiresAt ?? null;
    if (expiresAt === null && options.expiresIn != null) {
      expiresAt = new Date(Date.now() + options.expiresIn * 1000);
    }
    const record: ApiKeyRecord = {
      id,
      ownerId,
      name,
      role: options.role ?? "user",
      tenantId: "default",
      rateLimitTier: tier,
      createdAt: new Date(),
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
      metadata: options.metadata ?? {},
    };
    this.keys.set(rawKey, { ...record, rawKey });
    return { key: rawKey, record };
  }

  async list(ownerId: string): Promise<ApiKeyRecord[]> {
    return [...this.keys.values()]
      .filter((e) => e.ownerId === ownerId)
      .map(({ rawKey: _rk, ...rec }) => rec);
  }

  async get(id: string): Promise<ApiKeyRecord | null> {
    for (const entry of this.keys.values()) {
      if (entry.id === id) {
        const { rawKey: _rk, ...rec } = entry;
        return rec;
      }
    }
    return null;
  }

  async revoke(id: string): Promise<void> {
    for (const [rawKey, entry] of this.keys) {
      if (entry.id === id && !entry.revokedAt) {
        this.keys.set(rawKey, { ...entry, revokedAt: new Date() });
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Test-app factory
// ---------------------------------------------------------------------------

interface TestHarness {
  app: Hono<AppEnv>;
  store: InMemoryApiKeyStore;
}

function buildApp(
  opts: { allowedTiers?: string[]; ownerId?: string } = {}
): TestHarness {
  const store = new InMemoryApiKeyStore();
  const routes = createApiKeyRoutes({
    store: store as never,
    allowedTiers: opts.allowedTiers,
  });

  const app = new Hono<AppEnv>();
  // Inject an API-key context that identifies the calling owner.
  app.use("*", async (c, next) => {
    if (opts.ownerId) {
      c.set(
        "apiKey" as never,
        { id: opts.ownerId, ownerId: opts.ownerId } as never
      );
    }
    await next();
  });
  app.route("/api/keys", routes);
  return { app, store };
}

async function post(app: Hono<AppEnv>, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function del(app: Hono<AppEnv>, path: string) {
  return app.request(path, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// POST /api/keys — create
// ---------------------------------------------------------------------------

describe("POST /api/keys", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = buildApp({ ownerId: "owner-1" });
  });

  it("returns 201 with key, id, name, tier, createdAt on success", async () => {
    const res = await post(harness.app, "/api/keys", { name: "my-key" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["key"]).toBe("string");
    expect(typeof body["id"]).toBe("string");
    expect(body["name"]).toBe("my-key");
    expect(body["tier"]).toBe("standard");
    expect(body["createdAt"]).toBeDefined();
  });

  it('defaults tier to "standard" when tier is omitted', async () => {
    const res = await post(harness.app, "/api/keys", { name: "k1" });
    const body = (await res.json()) as { tier: string };
    expect(body.tier).toBe("standard");
  });

  it("accepts a custom tier", async () => {
    const res = await post(harness.app, "/api/keys", {
      name: "k2",
      tier: "premium",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tier: string };
    expect(body.tier).toBe("premium");
  });

  it("accepts expiresIn and sets expiresAt in the response", async () => {
    const res = await post(harness.app, "/api/keys", {
      name: "k3",
      expiresIn: 3600,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { expiresAt: string | null };
    expect(body.expiresAt).not.toBeNull();
    const expiresAt = new Date(body.expiresAt!);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns 400 when name is missing", async () => {
    const res = await post(harness.app, "/api/keys", { tier: "standard" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when name is empty string", async () => {
    const res = await post(harness.app, "/api/keys", { name: "  " });
    expect(res.status).toBe(400);
  });

  it("returns 400 when name exceeds 128 characters", async () => {
    const res = await post(harness.app, "/api/keys", { name: "a".repeat(129) });
    expect(res.status).toBe(400);
  });

  it("returns 400 when name contains control characters", async () => {
    const res = await post(harness.app, "/api/keys", { name: "bad\u0000name" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when expiresIn is negative", async () => {
    const res = await post(harness.app, "/api/keys", {
      name: "k",
      expiresIn: -1,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when expiresIn is zero", async () => {
    const res = await post(harness.app, "/api/keys", {
      name: "k",
      expiresIn: 0,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when expiresIn exceeds one year (31536000s)", async () => {
    const res = await post(harness.app, "/api/keys", {
      name: "k",
      expiresIn: 31536001,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await harness.app.request("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when tier is not in allowedTiers", async () => {
    const { app } = buildApp({
      ownerId: "o1",
      allowedTiers: ["standard", "premium"],
    });
    const res = await post(app, "/api/keys", { name: "k", tier: "enterprise" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("enterprise");
  });

  it("allows tier when it is in allowedTiers", async () => {
    const { app } = buildApp({
      ownerId: "o1",
      allowedTiers: ["standard", "premium"],
    });
    const res = await post(app, "/api/keys", { name: "k", tier: "premium" });
    expect(res.status).toBe(201);
  });

  it("does not include key hash in the response", async () => {
    const res = await post(harness.app, "/api/keys", { name: "k" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["keyHash"]).toBeUndefined();
    expect(body["hash"]).toBeUndefined();
  });

  it("the returned key is a non-empty string", async () => {
    const res = await post(harness.app, "/api/keys", { name: "k" });
    const body = (await res.json()) as { key: string };
    expect(body.key.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/keys — list
// ---------------------------------------------------------------------------

describe("GET /api/keys", () => {
  it("returns empty keys array when no keys exist", async () => {
    const { app } = buildApp({ ownerId: "owner-empty" });
    const res = await app.request("/api/keys");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys).toEqual([]);
  });

  it("returns keys owned by the requesting owner", async () => {
    const { app } = buildApp({ ownerId: "owner-1" });
    await post(app, "/api/keys", { name: "key-a" });
    await post(app, "/api/keys", { name: "key-b" });

    const res = await app.request("/api/keys");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<{ name: string }> };
    expect(body.keys).toHaveLength(2);
    const names = body.keys.map((k) => k.name);
    expect(names).toContain("key-a");
    expect(names).toContain("key-b");
  });

  it("does not return keys belonging to another owner", async () => {
    const { app: app1, store } = buildApp({ ownerId: "owner-1" });
    // Create a key for owner-2 directly in the store
    await store.create("owner-2", "other-key");

    const res = await app1.request("/api/keys");
    const body = (await res.json()) as { keys: unknown[] };
    // owner-1 has no keys; only owner-2's key is in the store
    expect(body.keys).toHaveLength(0);
  });

  it("keys in list response never contain the raw key value", async () => {
    const { app } = buildApp({ ownerId: "o1" });
    await post(app, "/api/keys", { name: "k" });

    const res = await app.request("/api/keys");
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    const firstKey = body.keys[0]!;
    expect(firstKey["key"]).toBeUndefined();
    expect(firstKey["keyHash"]).toBeUndefined();
  });

  it('falls back to "anonymous" owner when no context is set', async () => {
    // Build app without ownerId injection
    const store = new InMemoryApiKeyStore();
    const routes = createApiKeyRoutes({ store: store as never });
    const app = new Hono<AppEnv>();
    app.route("/api/keys", routes);

    const res = await app.request("/api/keys");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/keys/:id — revoke
// ---------------------------------------------------------------------------

describe("DELETE /api/keys/:id", () => {
  it("returns 204 on successful revocation", async () => {
    const { app } = buildApp({ ownerId: "owner-1" });
    const createRes = await post(app, "/api/keys", { name: "revoke-me" });
    const created = (await createRes.json()) as { id: string };

    const res = await del(app, `/api/keys/${created.id}`);
    expect(res.status).toBe(204);
  });

  it("returns 404 when key does not exist", async () => {
    const { app } = buildApp({ ownerId: "owner-1" });
    const res = await del(app, "/api/keys/nonexistent-id");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when key belongs to a different owner", async () => {
    const { app: app1, store } = buildApp({ ownerId: "owner-1" });
    // Create a key for owner-2 directly
    const { record } = await store.create("owner-2", "other-key");

    const res = await del(app1, `/api/keys/${record.id}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/keys/:id/rotate
// ---------------------------------------------------------------------------

describe("POST /api/keys/:id/rotate", () => {
  it("returns 201 with a new key on success", async () => {
    const { app } = buildApp({ ownerId: "owner-1" });
    const createRes = await post(app, "/api/keys", { name: "rotate-me" });
    const created = (await createRes.json()) as { id: string; key: string };

    const rotateRes = await post(app, `/api/keys/${created.id}/rotate`, {});
    expect(rotateRes.status).toBe(201);
    const body = (await rotateRes.json()) as { key: string; id: string };
    // The new key must differ from the original
    expect(body.key).not.toBe(created.key);
    expect(typeof body.id).toBe("string");
  });

  it("returns 404 when key does not exist", async () => {
    const { app } = buildApp({ ownerId: "owner-1" });
    const res = await post(app, "/api/keys/ghost/rotate", {});
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when key belongs to another owner", async () => {
    const { app: app1, store } = buildApp({ ownerId: "owner-1" });
    const { record } = await store.create("owner-2", "foreign-key");

    const res = await post(app1, `/api/keys/${record.id}/rotate`, {});
    expect(res.status).toBe(404);
  });

  it("returns 400 when trying to rotate a revoked key", async () => {
    const { app } = buildApp({ ownerId: "owner-1" });
    const createRes = await post(app, "/api/keys", { name: "revoked-key" });
    const created = (await createRes.json()) as { id: string };

    // Revoke it first
    await del(app, `/api/keys/${created.id}`);

    const res = await post(app, `/api/keys/${created.id}/rotate`, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("revoked");
  });

  it("accepts expiresIn on rotate and returns expiresAt", async () => {
    const { app } = buildApp({ ownerId: "owner-1" });
    const createRes = await post(app, "/api/keys", { name: "k" });
    const created = (await createRes.json()) as { id: string };

    const res = await post(app, `/api/keys/${created.id}/rotate`, {
      expiresIn: 7200,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { expiresAt: string | null };
    expect(body.expiresAt).not.toBeNull();
  });

  it("returns 400 when rotate body has invalid expiresIn", async () => {
    const { app } = buildApp({ ownerId: "owner-1" });
    const createRes = await post(app, "/api/keys", { name: "k" });
    const created = (await createRes.json()) as { id: string };

    const res = await post(app, `/api/keys/${created.id}/rotate`, {
      expiresIn: -100,
    });
    expect(res.status).toBe(400);
  });

  it("rotates without body (body is optional)", async () => {
    const { app } = buildApp({ ownerId: "owner-1" });
    const createRes = await post(app, "/api/keys", { name: "k" });
    const created = (await createRes.json()) as { id: string };

    const res = await app.request(`/api/keys/${created.id}/rotate`, {
      method: "POST",
      // no body, no content-type
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Owner scope isolation (cross-owner)
// ---------------------------------------------------------------------------

describe("Owner scope isolation", () => {
  it("tenant-2 cannot revoke a key owned by tenant-1", async () => {
    const { app: app1, store } = buildApp({ ownerId: "tenant-1" });
    const app2 = (() => {
      const routes = createApiKeyRoutes({ store: store as never });
      const a = new Hono<AppEnv>();
      a.use("*", async (c, next) => {
        c.set(
          "apiKey" as never,
          { id: "tenant-2", ownerId: "tenant-2" } as never
        );
        await next();
      });
      a.route("/api/keys", routes);
      return a;
    })();

    const createRes = await post(app1, "/api/keys", { name: "protected" });
    const created = (await createRes.json()) as { id: string };

    const res = await del(app2, `/api/keys/${created.id}`);
    expect(res.status).toBe(404);

    // Key must still exist for tenant-1
    const listRes = await app1.request("/api/keys");
    const body = (await listRes.json()) as { keys: unknown[] };
    expect(body.keys).toHaveLength(1);
  });

  it("tenant-1 keys are not visible to tenant-2", async () => {
    const { app: app1, store } = buildApp({ ownerId: "tenant-1" });
    await post(app1, "/api/keys", { name: "private-key" });

    const routes = createApiKeyRoutes({ store: store as never });
    const app2 = new Hono<AppEnv>();
    app2.use("*", async (c, next) => {
      c.set(
        "apiKey" as never,
        { id: "tenant-2", ownerId: "tenant-2" } as never
      );
      await next();
    });
    app2.route("/api/keys", routes);

    const res = await app2.request("/api/keys");
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys).toHaveLength(0);
  });
});
