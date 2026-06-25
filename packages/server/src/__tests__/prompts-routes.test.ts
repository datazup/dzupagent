/**
 * Deep route + store tests for prompt version endpoints and InMemoryPromptStore.
 *
 * Covers:
 *  - Prompt route CRUD (create, list, get, update, delete)
 *  - Lifecycle transitions (publish, rollback, archive propagation)
 *  - Request validation (400 on bad input, 404 on missing, 409 on lifecycle conflict)
 *  - Tenant isolation via apiKey context
 *  - Query filtering (type, category, status)
 *  - InMemoryPromptStore: save, list, get, getActive, update, publish, rollback, delete
 *
 * No real database — InMemoryPromptStore is the persistence layer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createPromptRoutes } from "../routes/prompts.js";
import { InMemoryPromptStore } from "../prompts/prompt-store.js";
import type { PromptStore } from "../prompts/prompt-store.js";
import type { AppEnv } from "../types.js";

// ---------------------------------------------------------------------------
// Test-app factory
// ---------------------------------------------------------------------------

function buildApp(store: PromptStore, tenantId = "tenant-1") {
  const routes = createPromptRoutes({ promptStore: store });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("apiKey" as never, { tenantId } as never);
    await next();
  });
  app.route("/api/prompts", routes);
  return app;
}

async function post(app: Hono, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function put(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function del(app: Hono, path: string) {
  return app.request(path, { method: "DELETE" });
}

const VALID_PROMPT = {
  name: "SQL Generator",
  type: "system",
  content: "You are a SQL expert.",
  promptId: "sql-gen",
};

// ---------------------------------------------------------------------------
// POST /api/prompts — create
// ---------------------------------------------------------------------------

describe("POST /api/prompts", () => {
  let store: InMemoryPromptStore;
  let app: Hono;

  beforeEach(() => {
    store = new InMemoryPromptStore();
    app = buildApp(store);
  });

  it("returns 201 with the created prompt version", async () => {
    const res = await post(app, "/api/prompts", VALID_PROMPT);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["id"]).toBeTruthy();
    expect(body["name"]).toBe("SQL Generator");
    expect(body["type"]).toBe("system");
    expect(body["content"]).toBe("You are a SQL expert.");
    expect(body["version"]).toBe(1);
    expect(body["status"]).toBe("draft");
  });

  it("auto-increments version for subsequent versions of same promptId", async () => {
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "v1" });
    const res = await post(app, "/api/prompts", { ...VALID_PROMPT, id: "v2" });
    const body = (await res.json()) as { version: number };
    expect(body.version).toBe(2);
  });

  it("accepts caller-supplied id", async () => {
    const res = await post(app, "/api/prompts", {
      ...VALID_PROMPT,
      id: "my-id",
    });
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("my-id");
  });

  it("defaults status to draft", async () => {
    const res = await post(app, "/api/prompts", VALID_PROMPT);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("draft");
  });

  it("accepts explicit status of published", async () => {
    const res = await post(app, "/api/prompts", {
      ...VALID_PROMPT,
      id: "pub",
      status: "published",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("published");
  });

  it("stores prompt under the requesting tenant", async () => {
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p1" });
    const all = await store.list({ tenantId: "tenant-1" });
    expect(all).toHaveLength(1);
  });

  it("returns 400 when name is missing", async () => {
    const { name: _n, ...rest } = VALID_PROMPT;
    const res = await post(app, "/api/prompts", rest);
    expect(res.status).toBe(400);
  });

  it("returns 400 when type is missing", async () => {
    const { type: _t, ...rest } = VALID_PROMPT;
    const res = await post(app, "/api/prompts", rest);
    expect(res.status).toBe(400);
  });

  it("returns 400 when content is missing", async () => {
    const { content: _c, ...rest } = VALID_PROMPT;
    const res = await post(app, "/api/prompts", rest);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/prompts — list
// ---------------------------------------------------------------------------

describe("GET /api/prompts", () => {
  let store: InMemoryPromptStore;
  let app: Hono;

  beforeEach(async () => {
    store = new InMemoryPromptStore();
    app = buildApp(store);
    await post(app, "/api/prompts", {
      ...VALID_PROMPT,
      id: "p1",
      type: "system",
      status: "draft",
    });
    await post(app, "/api/prompts", {
      ...VALID_PROMPT,
      id: "p2",
      type: "user",
      status: "published",
      promptId: "sql-gen",
    });
    await post(app, "/api/prompts", {
      ...VALID_PROMPT,
      id: "p3",
      type: "system",
      category: "analytics",
      promptId: "analytics-gen",
    });
  });

  it("returns all prompts for the tenant", async () => {
    const res = await app.request("/api/prompts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompts: unknown[] };
    expect(body.prompts).toHaveLength(3);
  });

  it("filters by type", async () => {
    const res = await app.request("/api/prompts?type=user");
    const body = (await res.json()) as { prompts: Array<{ type: string }> };
    expect(body.prompts.every((p) => p.type === "user")).toBe(true);
  });

  it("filters by category", async () => {
    const res = await app.request("/api/prompts?category=analytics");
    const body = (await res.json()) as { prompts: Array<{ category: string }> };
    expect(body.prompts).toHaveLength(1);
    expect(body.prompts[0]!.category).toBe("analytics");
  });

  it("filters by status=draft", async () => {
    const res = await app.request("/api/prompts?status=draft");
    const body = (await res.json()) as { prompts: Array<{ status: string }> };
    expect(body.prompts.every((p) => p.status === "draft")).toBe(true);
  });

  it("does not return prompts belonging to another tenant", async () => {
    const app2 = buildApp(store, "tenant-2");
    await post(app2, "/api/prompts", {
      ...VALID_PROMPT,
      id: "t2p",
      promptId: "t2-prompt",
    });

    const res = await app.request("/api/prompts");
    const body = (await res.json()) as { prompts: unknown[] };
    // tenant-1 still only has 3 prompts
    expect(body.prompts).toHaveLength(3);
  });

  it("returns empty array when no prompts exist", async () => {
    const emptyStore = new InMemoryPromptStore();
    const emptyApp = buildApp(emptyStore);
    const res = await emptyApp.request("/api/prompts");
    const body = (await res.json()) as { prompts: unknown[] };
    expect(body.prompts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/prompts/:id — get one
// ---------------------------------------------------------------------------

describe("GET /api/prompts/:id", () => {
  let store: InMemoryPromptStore;
  let app: Hono;

  beforeEach(() => {
    store = new InMemoryPromptStore();
    app = buildApp(store);
  });

  it("returns the prompt by id", async () => {
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p1" });
    const res = await app.request("/api/prompts/p1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.id).toBe("p1");
    expect(body.name).toBe("SQL Generator");
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.request("/api/prompts/ghost");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when prompt belongs to another tenant", async () => {
    await store.save({
      id: "foreign",
      promptId: "fp",
      name: "x",
      type: "system",
      content: "x",
      version: 1,
      status: "draft",
      tenantId: "tenant-2",
    });
    const res = await app.request("/api/prompts/foreign");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/prompts/active/:promptId — get published version
// ---------------------------------------------------------------------------

describe("GET /api/prompts/active/:promptId", () => {
  let store: InMemoryPromptStore;
  let app: Hono;

  beforeEach(() => {
    store = new InMemoryPromptStore();
    app = buildApp(store);
  });

  it("returns 404 when no published version exists", async () => {
    await post(app, "/api/prompts", {
      ...VALID_PROMPT,
      id: "p1",
      status: "draft",
    });
    const res = await app.request("/api/prompts/active/sql-gen");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns the published version when it exists", async () => {
    await post(app, "/api/prompts", {
      ...VALID_PROMPT,
      id: "p1",
      status: "draft",
    });
    await post(app, "/api/prompts/p1/publish");

    const res = await app.request("/api/prompts/active/sql-gen");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; promptId: string };
    expect(body.status).toBe("published");
    expect(body.promptId).toBe("sql-gen");
  });
});

// ---------------------------------------------------------------------------
// PUT /api/prompts/:id — update draft
// ---------------------------------------------------------------------------

describe("PUT /api/prompts/:id", () => {
  let store: InMemoryPromptStore;
  let app: Hono;

  beforeEach(() => {
    store = new InMemoryPromptStore();
    app = buildApp(store);
  });

  it("updates name and content of a draft version", async () => {
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p1" });
    const res = await put(app, "/api/prompts/p1", {
      name: "Updated Name",
      content: "New content",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; content: string };
    expect(body.name).toBe("Updated Name");
    expect(body.content).toBe("New content");
  });

  it("returns 404 for unknown id", async () => {
    const res = await put(app, "/api/prompts/ghost", { name: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when trying to update a published version", async () => {
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p1" });
    await post(app, "/api/prompts/p1/publish");

    const res = await put(app, "/api/prompts/p1", {
      name: "Cannot edit published",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  it("returns 404 when prompt belongs to another tenant", async () => {
    await store.save({
      id: "foreign",
      promptId: "fp",
      name: "x",
      type: "system",
      content: "x",
      version: 1,
      status: "draft",
      tenantId: "tenant-2",
    });
    const res = await put(app, "/api/prompts/foreign", { name: "hack" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/prompts/:id/publish
// ---------------------------------------------------------------------------

describe("POST /api/prompts/:id/publish", () => {
  let store: InMemoryPromptStore;
  let app: Hono;

  beforeEach(() => {
    store = new InMemoryPromptStore();
    app = buildApp(store);
  });

  it("publishes a draft version", async () => {
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p1" });
    const res = await post(app, "/api/prompts/p1/publish");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("published");
  });

  it("archives the previously published version when publishing a new one", async () => {
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p1" });
    await post(app, "/api/prompts/p1/publish");

    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p2" });
    await post(app, "/api/prompts/p2/publish");

    const p1 = await store.get("p1");
    expect(p1!.status).toBe("archived");
  });

  it("returns 404 when id does not exist", async () => {
    const res = await post(app, "/api/prompts/ghost/publish");
    expect(res.status).toBe(404);
  });

  it("returns 409 when trying to publish an archived version", async () => {
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p1" });
    await post(app, "/api/prompts/p1/publish");
    // Publish p2 to archive p1
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p2" });
    await post(app, "/api/prompts/p2/publish");

    // p1 is now archived — cannot publish directly
    const res = await post(app, "/api/prompts/p1/publish");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// POST /api/prompts/rollback/:promptId
// ---------------------------------------------------------------------------

describe("POST /api/prompts/rollback/:promptId", () => {
  let store: InMemoryPromptStore;
  let app: Hono;

  beforeEach(() => {
    store = new InMemoryPromptStore();
    app = buildApp(store);
  });

  it("rolls back to the target version", async () => {
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p1" });
    await post(app, "/api/prompts/p1/publish");
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p2" });
    await post(app, "/api/prompts/p2/publish");

    // p1 is now archived; rollback to it
    const res = await post(app, "/api/prompts/rollback/sql-gen", {
      targetId: "p1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe("p1");
    expect(body.status).toBe("published");
  });

  it("returns 404 when targetId does not exist", async () => {
    const res = await post(app, "/api/prompts/rollback/sql-gen", {
      targetId: "ghost",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when targetId belongs to a different promptId", async () => {
    await post(app, "/api/prompts", {
      ...VALID_PROMPT,
      id: "p1",
      promptId: "other-prompt",
    });
    const res = await post(app, "/api/prompts/rollback/sql-gen", {
      targetId: "p1",
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when targetId is missing from body", async () => {
    const res = await post(app, "/api/prompts/rollback/sql-gen", {});
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/prompts/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/prompts/:id", () => {
  let store: InMemoryPromptStore;
  let app: Hono;

  beforeEach(() => {
    store = new InMemoryPromptStore();
    app = buildApp(store);
  });

  it("deletes a draft version and returns deleted:true", async () => {
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p1" });
    const res = await del(app, "/api/prompts/p1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });

  it("returns 409 when trying to delete a published version", async () => {
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p1" });
    await post(app, "/api/prompts/p1/publish");

    const res = await del(app, "/api/prompts/p1");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  it("returns 409 for unknown id (store returns false)", async () => {
    const res = await del(app, "/api/prompts/ghost");
    expect(res.status).toBe(409);
  });

  it("prompt is no longer retrievable after deletion", async () => {
    await post(app, "/api/prompts", { ...VALID_PROMPT, id: "p1" });
    await del(app, "/api/prompts/p1");
    const res = await app.request("/api/prompts/p1");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// InMemoryPromptStore — unit tests
// ---------------------------------------------------------------------------

describe("InMemoryPromptStore", () => {
  let store: InMemoryPromptStore;

  beforeEach(() => {
    store = new InMemoryPromptStore();
  });

  const BASE = {
    id: "v1",
    promptId: "p1",
    name: "Test",
    type: "system",
    content: "Hello",
    version: 1,
    status: "draft" as const,
  };

  describe("save()", () => {
    it("saves a record and sets timestamps", async () => {
      const rec = await store.save(BASE);
      expect(rec.createdAt).toBeTruthy();
      expect(rec.updatedAt).toBeTruthy();
    });

    it("upserts on same id", async () => {
      await store.save(BASE);
      const updated = await store.save({ ...BASE, name: "Updated" });
      expect(updated.name).toBe("Updated");
      expect((await store.list()).length).toBe(1);
    });

    it("throws when id is empty", async () => {
      await expect(store.save({ ...BASE, id: "" })).rejects.toThrow();
    });

    it("throws when promptId is empty", async () => {
      await expect(store.save({ ...BASE, promptId: "" })).rejects.toThrow();
    });
  });

  describe("list()", () => {
    it("returns all records when no filter", async () => {
      await store.save({ ...BASE, id: "v1", promptId: "p1" });
      await store.save({ ...BASE, id: "v2", promptId: "p2" });
      expect((await store.list()).length).toBe(2);
    });

    it("filters by type", async () => {
      await store.save({ ...BASE, id: "v1", type: "system" });
      await store.save({ ...BASE, id: "v2", promptId: "p2", type: "user" });
      const result = await store.list({ type: "user" });
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe("user");
    });

    it("filters by status", async () => {
      await store.save({ ...BASE, id: "v1", status: "draft" });
      await store.save({
        ...BASE,
        id: "v2",
        promptId: "p2",
        status: "published",
      });
      const drafts = await store.list({ status: "draft" });
      expect(drafts.every((r) => r.status === "draft")).toBe(true);
    });

    it("filters by tenantId", async () => {
      await store.save({ ...BASE, id: "v1", tenantId: "ta" });
      await store.save({ ...BASE, id: "v2", promptId: "p2", tenantId: "tb" });
      const ta = await store.list({ tenantId: "ta" });
      expect(ta).toHaveLength(1);
    });
  });

  describe("get()", () => {
    it("returns record by id", async () => {
      await store.save(BASE);
      expect(await store.get("v1")).not.toBeNull();
    });

    it("returns null for unknown id", async () => {
      expect(await store.get("ghost")).toBeNull();
    });

    it("returns null when tenantId does not match", async () => {
      await store.save({ ...BASE, tenantId: "ta" });
      expect(await store.get("v1", "tb")).toBeNull();
    });
  });

  describe("getActive()", () => {
    it("returns the published version for a promptId", async () => {
      await store.save({ ...BASE, id: "v1", status: "draft" });
      await store.publish("v1");
      const active = await store.getActive("p1");
      expect(active).not.toBeNull();
      expect(active!.status).toBe("published");
    });

    it("returns null when no published version exists", async () => {
      await store.save({ ...BASE, id: "v1", status: "draft" });
      expect(await store.getActive("p1")).toBeNull();
    });

    it("returns null when tenantId does not match", async () => {
      await store.save({
        ...BASE,
        id: "v1",
        status: "published",
        tenantId: "ta",
      });
      expect(await store.getActive("p1", "tb")).toBeNull();
    });
  });

  describe("publish()", () => {
    it("sets status to published", async () => {
      await store.save(BASE);
      const published = await store.publish("v1");
      expect(published!.status).toBe("published");
    });

    it("archives previous published sibling", async () => {
      await store.save({ ...BASE, id: "v1", version: 1 });
      await store.publish("v1");
      await store.save({ ...BASE, id: "v2", version: 2 });
      await store.publish("v2");

      const v1 = await store.get("v1");
      expect(v1!.status).toBe("archived");
    });

    it("returns null for unknown id", async () => {
      expect(await store.publish("ghost")).toBeNull();
    });
  });

  describe("rollback()", () => {
    it("re-publishes the target version", async () => {
      await store.save({ ...BASE, id: "v1", version: 1 });
      await store.publish("v1");
      await store.save({ ...BASE, id: "v2", version: 2 });
      await store.publish("v2");

      const result = await store.rollback("p1", "v1");
      expect(result!.id).toBe("v1");
      expect(result!.status).toBe("published");
    });

    it("returns null when targetId does not belong to promptId", async () => {
      await store.save({ ...BASE, id: "v1", promptId: "other" });
      expect(await store.rollback("p1", "v1")).toBeNull();
    });

    it("throws when promptId is empty", async () => {
      await expect(store.rollback("", "v1")).rejects.toThrow();
    });

    it("throws when targetId is empty", async () => {
      await expect(store.rollback("p1", "")).rejects.toThrow();
    });
  });

  describe("delete()", () => {
    it("deletes a draft and returns true", async () => {
      await store.save(BASE);
      expect(await store.delete("v1")).toBe(true);
      expect(await store.get("v1")).toBeNull();
    });

    it("returns false for unknown id", async () => {
      expect(await store.delete("ghost")).toBe(false);
    });

    it("returns false for a published record", async () => {
      await store.save({ ...BASE, id: "v1", status: "published" });
      expect(await store.delete("v1")).toBe(false);
      expect(await store.get("v1")).not.toBeNull();
    });

    it("respects tenantId isolation", async () => {
      await store.save({ ...BASE, id: "v1", tenantId: "ta" });
      expect(await store.delete("v1", "tb")).toBe(false);
      expect(await store.get("v1", "ta")).not.toBeNull();
    });
  });
});
