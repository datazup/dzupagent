/**
 * W25-B1 — Deep coverage for REST route boundaries, auth middleware, and the
 * Drizzle persistence layer of `@dzupagent/server`.
 *
 * Three surfaces are exercised, all without a real database or network:
 *
 *  1. REST run + agent-definition routes via `createForgeApp` and the in-memory
 *     stores (`InMemoryRunStore`, `InMemoryAgentStore`).
 *  2. `authMiddleware` boundary behaviour (missing / invalid / valid key).
 *  3. `PostgresRunStore` and `PostgresAgentStore` against a hand-rolled
 *     chainable Drizzle mock — including DB-error propagation paths.
 *
 * Patterns deliberately mirror the existing `run-crud-routes.test.ts`,
 * `auth-middleware.test.ts`, and `postgres-stores.test.ts` suites so the new
 * tests sit naturally alongside them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from "@dzupagent/core";
import { createForgeApp, type ForgeServerConfig } from "../app.js";
import { authMiddleware, type AuthConfig } from "../middleware/auth.js";
import {
  PostgresRunStore,
  PostgresAgentStore,
} from "../persistence/postgres-stores.js";
import type { AgentExecutionSpec } from "@dzupagent/core";

// ---------------------------------------------------------------------------
// Shared helpers — REST
// ---------------------------------------------------------------------------

function createTestConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
  };
}

async function req(
  app: ReturnType<typeof createForgeApp>,
  method: string,
  path: string,
  body?: unknown
) {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

async function seedAgent(
  config: ForgeServerConfig,
  id = "agent-1"
): Promise<void> {
  await config.agentStore.save({
    id,
    name: "Test Agent",
    instructions: "test",
    modelTier: "chat",
  });
}

// ---------------------------------------------------------------------------
// Chainable Drizzle mock (mirrors postgres-stores.test.ts)
// ---------------------------------------------------------------------------

interface Terminal<T> {
  thenValue: T;
}

function isTerminal<T>(v: unknown): v is Terminal<T> {
  return typeof v === "object" && v !== null && "thenValue" in (v as object);
}

function makeChain(
  terminal: unknown,
  onCall?: (fnName: string, args: unknown[]) => void
): object {
  const seen: Record<string, unknown> = {};
  const handler: ProxyHandler<() => unknown> = {
    get(_target, prop: string) {
      if (prop === "then") {
        const t = isTerminal(terminal) ? terminal.thenValue : terminal;
        return (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve(t).then(onFulfilled);
      }
      if (prop in seen) return seen[prop];
      const fn = (...args: unknown[]): unknown => {
        onCall?.(prop, args);
        return makeChain(terminal, onCall);
      };
      seen[prop] = fn;
      return fn;
    },
    apply() {
      return makeChain(terminal, onCall);
    },
  };
  return new Proxy(function proxyFn() {}, handler);
}

function buildMockDb(
  options: {
    selectRows?: unknown[];
    insertRows?: unknown[];
    updateRows?: unknown[];
    deleteRows?: unknown[];
    log?: Array<{ op: string; fn: string; args: unknown[] }>;
  } = {}
): {
  select: ReturnType<typeof vi.fn>;
  selectDistinct: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  const log = options.log ?? [];
  const makeOp = (op: string, rows: unknown[]) => {
    const onCall = (fn: string, args: unknown[]): void => {
      log.push({ op, fn, args });
    };
    return makeChain(rows, onCall);
  };
  return {
    select: vi.fn(() => makeOp("select", options.selectRows ?? [])),
    selectDistinct: vi.fn(() =>
      makeOp("selectDistinct", options.selectRows ?? [])
    ),
    insert: vi.fn(() => makeOp("insert", options.insertRows ?? [])),
    update: vi.fn(() => makeOp("update", options.updateRows ?? [])),
    delete: vi.fn(() => makeOp("delete", options.deleteRows ?? [])),
  };
}

/** A DB whose top-level op throws — simulates a connection / constraint failure. */
function buildThrowingDb(error: Error): unknown {
  const thrower = vi.fn(() => {
    throw error;
  });
  return {
    select: thrower,
    selectDistinct: thrower,
    insert: thrower,
    update: thrower,
    delete: thrower,
  };
}

function runRow(
  over: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id: "run-x",
    agentId: "agent-x",
    status: "queued",
    input: null,
    output: null,
    plan: null,
    tokenUsageInput: 0,
    tokenUsageOutput: 0,
    costCents: null,
    error: null,
    metadata: {},
    ownerId: null,
    tenantId: "default",
    startedAt: new Date("2026-04-01"),
    completedAt: null,
    ...over,
  };
}

function agentRow(
  over: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id: "a1",
    name: "A",
    description: null,
    instructions: "I",
    modelTier: "chat",
    tools: [],
    guardrails: null,
    approval: "auto",
    version: 1,
    active: true,
    metadata: {},
    tenantId: "default",
    createdAt: new Date("2026-04-01"),
    updatedAt: new Date("2026-04-01"),
    ...over,
  };
}

// ===========================================================================
// 1. REST — POST /api/runs boundaries
// ===========================================================================

describe("REST POST /api/runs — creation boundaries", () => {
  let config: ForgeServerConfig;
  let app: ReturnType<typeof createForgeApp>;

  beforeEach(async () => {
    config = createTestConfig();
    app = createForgeApp(config);
    await seedAgent(config);
  });

  it("201 — returns an id for a freshly created run", async () => {
    const res = await req(app, "POST", "/api/runs", {
      agentId: "agent-1",
      input: "task",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBeTruthy();
  });

  it("201 — defaults new run status to queued", async () => {
    const res = await req(app, "POST", "/api/runs", {
      agentId: "agent-1",
      input: "task",
    });
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("queued");
  });

  it("201 — echoes structured input verbatim", async () => {
    const res = await req(app, "POST", "/api/runs", {
      agentId: "agent-1",
      input: { nested: { a: 1, b: [2, 3] } },
    });
    const body = (await res.json()) as { data: { input: unknown } };
    expect(body.data.input).toEqual({ nested: { a: 1, b: [2, 3] } });
  });

  it("400 — VALIDATION_ERROR when agentId missing", async () => {
    const res = await req(app, "POST", "/api/runs", { input: "no agent" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("400 — VALIDATION_ERROR when agentId is an empty string", async () => {
    const res = await req(app, "POST", "/api/runs", {
      agentId: "",
      input: "x",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("404 — NOT_FOUND for an unknown agentId", async () => {
    const res = await req(app, "POST", "/api/runs", {
      agentId: "ghost",
      input: "x",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("400 — rejects malformed JSON body before touching the store", async () => {
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json",
    });
    expect(res.status).toBe(400);
    expect(await config.runStore.list()).toHaveLength(0);
  });

  it("does not persist a run when agent lookup fails", async () => {
    await req(app, "POST", "/api/runs", { agentId: "ghost", input: "x" });
    expect(await config.runStore.list()).toHaveLength(0);
  });
});

// ===========================================================================
// 2. REST — GET /api/runs listing + pagination
// ===========================================================================

describe("REST GET /api/runs — listing and pagination", () => {
  let config: ForgeServerConfig;
  let app: ReturnType<typeof createForgeApp>;

  beforeEach(async () => {
    config = createTestConfig();
    app = createForgeApp(config);
    await seedAgent(config, "agent-a");
    await seedAgent(config, "agent-b");
  });

  it("200 — empty data array when no runs exist", async () => {
    const res = await app.request("/api/runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; count: number };
    expect(body.data).toHaveLength(0);
    expect(body.count).toBe(0);
  });

  it("200 — returns all runs with a count", async () => {
    await config.runStore.create({ agentId: "agent-a", input: "1" });
    await config.runStore.create({ agentId: "agent-b", input: "2" });
    const res = await app.request("/api/runs");
    const body = (await res.json()) as { data: unknown[]; count: number };
    expect(body.data).toHaveLength(2);
    expect(body.count).toBe(2);
  });

  it("200 — agentId filter narrows results", async () => {
    await config.runStore.create({ agentId: "agent-a", input: "1" });
    await config.runStore.create({ agentId: "agent-a", input: "2" });
    await config.runStore.create({ agentId: "agent-b", input: "3" });
    const res = await app.request("/api/runs?agentId=agent-b");
    const body = (await res.json()) as { data: Array<{ agentId: string }> };
    expect(body.data.every((r) => r.agentId === "agent-b")).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  it("200 — limit caps returned rows", async () => {
    for (let i = 0; i < 6; i++)
      await config.runStore.create({ agentId: "agent-a", input: `t${i}` });
    const res = await app.request("/api/runs?limit=2");
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBeLessThanOrEqual(2);
  });

  it("200 — offset skips earlier rows", async () => {
    for (let i = 0; i < 5; i++)
      await config.runStore.create({ agentId: "agent-a", input: `t${i}` });
    const all = (await (await app.request("/api/runs")).json()) as {
      data: unknown[];
    };
    const offsetted = (await (
      await app.request("/api/runs?offset=3")
    ).json()) as { data: unknown[] };
    expect(offsetted.data.length).toBeLessThanOrEqual(all.data.length - 3);
  });

  it("200 — status filter selects only matching runs", async () => {
    const r = await config.runStore.create({ agentId: "agent-a", input: "x" });
    await config.runStore.update(r.id, { status: "completed" });
    await config.runStore.create({ agentId: "agent-a", input: "y" });
    const res = await app.request("/api/runs?status=completed");
    const body = (await res.json()) as { data: Array<{ status: string }> };
    expect(body.data.every((x) => x.status === "completed")).toBe(true);
  });
});

// ===========================================================================
// 3. REST — GET /api/runs/:id
// ===========================================================================

describe("REST GET /api/runs/:id — retrieval", () => {
  let config: ForgeServerConfig;
  let app: ReturnType<typeof createForgeApp>;

  beforeEach(async () => {
    config = createTestConfig();
    app = createForgeApp(config);
    await seedAgent(config);
  });

  it("200 — returns the run with its fields", async () => {
    const run = await config.runStore.create({
      agentId: "agent-1",
      input: { p: "hi" },
    });
    const res = await app.request(`/api/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; input: unknown } };
    expect(body.data.id).toBe(run.id);
    expect(body.data.input).toEqual({ p: "hi" });
  });

  it("200 — reflects an updated status", async () => {
    const run = await config.runStore.create({
      agentId: "agent-1",
      input: "x",
    });
    await config.runStore.update(run.id, { status: "running" });
    const body = (await (await app.request(`/api/runs/${run.id}`)).json()) as {
      data: { status: string };
    };
    expect(body.data.status).toBe("running");
  });

  it("404 — NOT_FOUND for an unknown id", async () => {
    const res = await app.request("/api/runs/does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

// ===========================================================================
// 4. REST — POST /api/runs/:id/cancel status transitions
// ===========================================================================

describe("REST POST /api/runs/:id/cancel — status transitions", () => {
  let config: ForgeServerConfig;
  let app: ReturnType<typeof createForgeApp>;

  beforeEach(async () => {
    config = createTestConfig();
    app = createForgeApp(config);
    await seedAgent(config);
  });

  it("200 — queued → cancelled is a valid transition", async () => {
    const run = await config.runStore.create({
      agentId: "agent-1",
      input: "x",
    });
    const res = await req(app, "POST", `/api/runs/${run.id}/cancel`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("cancelled");
  });

  it("200 — running → cancelled is a valid transition and is persisted", async () => {
    const run = await config.runStore.create({
      agentId: "agent-1",
      input: "x",
    });
    await config.runStore.update(run.id, { status: "running" });
    await req(app, "POST", `/api/runs/${run.id}/cancel`);
    const persisted = await config.runStore.get(run.id);
    expect(persisted?.status).toBe("cancelled");
  });

  it("400 — completed → cancelled is an invalid transition", async () => {
    const run = await config.runStore.create({
      agentId: "agent-1",
      input: "x",
    });
    await config.runStore.update(run.id, { status: "completed" });
    const res = await req(app, "POST", `/api/runs/${run.id}/cancel`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_STATE");
  });

  it("400 — failed → cancelled is an invalid transition", async () => {
    const run = await config.runStore.create({
      agentId: "agent-1",
      input: "x",
    });
    await config.runStore.update(run.id, { status: "failed" });
    const res = await req(app, "POST", `/api/runs/${run.id}/cancel`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_STATE");
  });

  it("400 — cancelled → cancelled is rejected (idempotency guard)", async () => {
    const run = await config.runStore.create({
      agentId: "agent-1",
      input: "x",
    });
    await config.runStore.update(run.id, { status: "cancelled" });
    const res = await req(app, "POST", `/api/runs/${run.id}/cancel`);
    expect(res.status).toBe(400);
  });

  it("404 — cancelling an unknown run id", async () => {
    const res = await req(app, "POST", "/api/runs/ghost/cancel");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

// ===========================================================================
// 5. REST — agent-definition CRUD boundaries
// ===========================================================================

describe("REST /api/agent-definitions — CRUD boundaries", () => {
  let config: ForgeServerConfig;
  let app: ReturnType<typeof createForgeApp>;

  beforeEach(() => {
    config = createTestConfig();
    app = createForgeApp(config);
  });

  it("201 — creates an agent definition and returns it", async () => {
    const res = await req(app, "POST", "/api/agent-definitions", {
      name: "My Agent",
      instructions: "do work",
      modelTier: "chat",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; name: string } };
    expect(body.data.id).toBeTruthy();
    expect(body.data.name).toBe("My Agent");
  });

  it("400 — VALIDATION_ERROR when name is missing", async () => {
    const res = await req(app, "POST", "/api/agent-definitions", {
      instructions: "x",
      modelTier: "chat",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("400 — strict schema rejects unknown fields", async () => {
    const res = await req(app, "POST", "/api/agent-definitions", {
      name: "X",
      instructions: "y",
      modelTier: "chat",
      bogusField: true,
    });
    expect(res.status).toBe(400);
  });

  it("200 — lists agents with a count", async () => {
    await req(app, "POST", "/api/agent-definitions", {
      name: "A",
      instructions: "i",
      modelTier: "chat",
    });
    await req(app, "POST", "/api/agent-definitions", {
      name: "B",
      instructions: "i",
      modelTier: "chat",
    });
    const res = await app.request("/api/agent-definitions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; count: number };
    expect(body.count).toBe(2);
  });

  it("200 — get by id round-trips a created agent", async () => {
    const created = (await (
      await req(app, "POST", "/api/agent-definitions", {
        name: "Round",
        instructions: "i",
        modelTier: "chat",
      })
    ).json()) as { data: { id: string } };
    const res = await app.request(`/api/agent-definitions/${created.data.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string } };
    expect(body.data.name).toBe("Round");
  });

  it("404 — get unknown agent id", async () => {
    const res = await app.request("/api/agent-definitions/ghost");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("200 — PATCH updates an existing agent", async () => {
    const created = (await (
      await req(app, "POST", "/api/agent-definitions", {
        name: "Before",
        instructions: "i",
        modelTier: "chat",
      })
    ).json()) as { data: { id: string } };
    const res = await req(
      app,
      "PATCH",
      `/api/agent-definitions/${created.data.id}`,
      { name: "After" }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string } };
    expect(body.data.name).toBe("After");
  });

  it("404 — PATCH unknown agent id", async () => {
    const res = await req(app, "PATCH", "/api/agent-definitions/ghost", {
      name: "X",
    });
    expect(res.status).toBe(404);
  });

  it("200 — DELETE soft-deletes an agent", async () => {
    const created = (await (
      await req(app, "POST", "/api/agent-definitions", {
        name: "Gone",
        instructions: "i",
        modelTier: "chat",
      })
    ).json()) as { data: { id: string } };
    const res = await req(
      app,
      "DELETE",
      `/api/agent-definitions/${created.data.id}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: boolean } };
    expect(body.data.deleted).toBe(true);
  });

  it("404 — DELETE unknown agent id", async () => {
    const res = await req(app, "DELETE", "/api/agent-definitions/ghost");
    expect(res.status).toBe(404);
  });

  it("alias — /api/agents/* resolves to the same handlers", async () => {
    const res = await req(app, "POST", "/api/agents", {
      name: "Alias",
      instructions: "i",
      modelTier: "chat",
    });
    expect(res.status).toBe(201);
  });
});

// ===========================================================================
// 6. Auth middleware boundaries
// ===========================================================================

describe("authMiddleware — key validation boundaries", () => {
  function createAuthApp(authConfig: AuthConfig): Hono {
    const app = new Hono();
    app.use("/api/*", authMiddleware(authConfig));
    app.get("/api/protected", (c) => c.json({ ok: true }));
    app.get("/api/health", (c) => c.json({ ok: true }));
    return app;
  }

  it("mode none — passes through without a key", async () => {
    const app = createAuthApp({ mode: "none" });
    expect((await app.request("/api/protected")).status).toBe(200);
  });

  it("401 — missing Authorization header", async () => {
    const app = createAuthApp({
      mode: "api-key",
      validateKey: async () => ({ id: "k1" }),
    });
    const res = await app.request("/api/protected");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("401 — invalid key is rejected", async () => {
    const app = createAuthApp({
      mode: "api-key",
      validateKey: async () => null,
    });
    const res = await app.request("/api/protected", {
      headers: { Authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("200 — valid key passes through", async () => {
    const app = createAuthApp({
      mode: "api-key",
      validateKey: async (k) => (k === "good" ? { id: "k1" } : null),
    });
    const res = await app.request("/api/protected", {
      headers: { Authorization: "Bearer good" },
    });
    expect(res.status).toBe(200);
  });

  it("401 — non-Bearer scheme is rejected", async () => {
    const app = createAuthApp({
      mode: "api-key",
      validateKey: async () => ({ id: "k1" }),
    });
    const res = await app.request("/api/protected", {
      headers: { Authorization: "Basic abc" },
    });
    expect(res.status).toBe(401);
  });

  it("health endpoints skip auth even with a rejecting validator", async () => {
    const app = createAuthApp({
      mode: "api-key",
      validateKey: async () => null,
    });
    expect((await app.request("/api/health")).status).toBe(200);
  });
});

// ===========================================================================
// 7. PostgresRunStore — Drizzle persistence
// ===========================================================================

describe("PostgresRunStore (Drizzle mock) — deep persistence", () => {
  it("create — inserts queued status and maps the returned row", async () => {
    const db = buildMockDb({
      insertRows: [runRow({ id: "run-1", agentId: "a", input: { q: "x" } })],
    });
    const store = new PostgresRunStore(db as never);
    const run = await store.create({ agentId: "a", input: { q: "x" } });
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(run.id).toBe("run-1");
    expect(run.status).toBe("queued");
    expect(run.input).toEqual({ q: "x" });
  });

  it('create — defaults tenantId to "default" and ownerId to null', async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ insertRows: [runRow({ id: "r" })], log });
    const store = new PostgresRunStore(db as never);
    await store.create({ agentId: "a", input: null });
    const values = log.find((l) => l.op === "insert" && l.fn === "values")!
      .args[0] as Record<string, unknown>;
    expect(values["tenantId"]).toBe("default");
    expect(values["ownerId"]).toBeNull();
  });

  it("create — forwards explicit ownerId and tenantId", async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ insertRows: [runRow()], log });
    const store = new PostgresRunStore(db as never);
    await store.create({
      agentId: "a",
      input: null,
      ownerId: "key-9",
      tenantId: "acme",
    });
    const values = log.find((l) => l.op === "insert" && l.fn === "values")!
      .args[0] as Record<string, unknown>;
    expect(values["ownerId"]).toBe("key-9");
    expect(values["tenantId"]).toBe("acme");
  });

  it("get — returns a mapped run when the row exists", async () => {
    const db = buildMockDb({
      selectRows: [
        runRow({
          id: "run-7",
          status: "completed",
          tokenUsageInput: 10,
          tokenUsageOutput: 5,
          costCents: 12,
        }),
      ],
    });
    const store = new PostgresRunStore(db as never);
    const run = await store.get("run-7");
    expect(run).not.toBeNull();
    expect(run!.id).toBe("run-7");
    expect(run!.tokenUsage).toEqual({ input: 10, output: 5 });
    expect(run!.costCents).toBe(12);
  });

  it("get — returns null when no row is found", async () => {
    const db = buildMockDb({ selectRows: [] });
    const store = new PostgresRunStore(db as never);
    expect(await store.get("missing")).toBeNull();
  });

  it("get — omits tokenUsage when both counters are zero", async () => {
    const db = buildMockDb({
      selectRows: [runRow({ tokenUsageInput: 0, tokenUsageOutput: 0 })],
    });
    const store = new PostgresRunStore(db as never);
    const run = await store.get("r");
    expect(run!.tokenUsage).toBeUndefined();
  });

  it("list — applies explicit limit and offset", async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ selectRows: [], log });
    const store = new PostgresRunStore(db as never);
    await store.list({ limit: 7, offset: 14 });
    expect(log.find((l) => l.fn === "limit")!.args[0]).toBe(7);
    expect(log.find((l) => l.fn === "offset")!.args[0]).toBe(14);
  });

  it("list — defaults to limit=50 offset=0", async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ selectRows: [], log });
    const store = new PostgresRunStore(db as never);
    await store.list();
    expect(log.find((l) => l.fn === "limit")!.args[0]).toBe(50);
    expect(log.find((l) => l.fn === "offset")!.args[0]).toBe(0);
  });

  it("list — maps every row", async () => {
    const db = buildMockDb({
      selectRows: [runRow({ id: "a" }), runRow({ id: "b", error: "boom" })],
    });
    const store = new PostgresRunStore(db as never);
    const runs = await store.list();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.error).toBe("boom");
  });

  it("count — returns the int from the first row", async () => {
    const db = buildMockDb({ selectRows: [{ count: 99 }] });
    const store = new PostgresRunStore(db as never);
    expect(await store.count()).toBe(99);
  });

  it("count — returns 0 when no rows", async () => {
    const db = buildMockDb({ selectRows: [] });
    const store = new PostgresRunStore(db as never);
    expect(await store.count()).toBe(0);
  });

  it("update — issues no UPDATE for an empty patch", async () => {
    const db = buildMockDb();
    const store = new PostgresRunStore(db as never);
    await store.update("r", {});
    expect(db.update).not.toHaveBeenCalled();
  });

  it("update — sets a single status field", async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ log });
    const store = new PostgresRunStore(db as never);
    await store.update("r", { status: "running" });
    const set = log.find((l) => l.op === "update" && l.fn === "set")!
      .args[0] as Record<string, unknown>;
    expect(set).toEqual({ status: "running" });
  });

  it("update — splits tokenUsage into input/output columns", async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ log });
    const store = new PostgresRunStore(db as never);
    await store.update("r", { tokenUsage: { input: 30, output: 11 } });
    const set = log.find((l) => l.op === "update" && l.fn === "set")!
      .args[0] as Record<string, unknown>;
    expect(set["tokenUsageInput"]).toBe(30);
    expect(set["tokenUsageOutput"]).toBe(11);
  });

  it("addLog — inserts a single entry with null phase by default", async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ log });
    const store = new PostgresRunStore(db as never);
    await store.addLog("r", { level: "info", message: "hi" });
    expect(db.insert).toHaveBeenCalledTimes(1);
    const values = log.find((l) => l.fn === "values")!.args[0] as Record<
      string,
      unknown
    >;
    expect(values["phase"]).toBeNull();
    expect(values["message"]).toBe("hi");
  });

  it("addLogs — no-ops on empty array", async () => {
    const db = buildMockDb();
    const store = new PostgresRunStore(db as never);
    await store.addLogs("r", []);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("addLogs — batches all entries into one insert", async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ log });
    const store = new PostgresRunStore(db as never);
    await store.addLogs("r", [
      { level: "info", message: "a" },
      { level: "warn", message: "b" },
    ]);
    expect(db.insert).toHaveBeenCalledTimes(1);
    const values = log.find((l) => l.fn === "values")!.args[0] as unknown[];
    expect(values).toHaveLength(2);
  });

  it("getLogs — maps rows and drops null phase/data", async () => {
    const now = new Date();
    const db = buildMockDb({
      selectRows: [
        {
          level: "info",
          phase: "plan",
          message: "ok",
          data: { k: 1 },
          timestamp: now,
        },
        {
          level: "error",
          phase: null,
          message: "bad",
          data: null,
          timestamp: now,
        },
      ],
    });
    const store = new PostgresRunStore(db as never);
    const logs = await store.getLogs("r");
    expect(logs[0]!.phase).toBe("plan");
    expect(logs[1]!.phase).toBeUndefined();
    expect(logs[1]!.data).toBeUndefined();
  });

  it("getLogs — returns empty array when none exist", async () => {
    const db = buildMockDb({ selectRows: [] });
    const store = new PostgresRunStore(db as never);
    expect(await store.getLogs("r")).toEqual([]);
  });

  it("two sequential creates each issue their own insert (concurrent-safe)", async () => {
    const db = buildMockDb({ insertRows: [runRow({ id: "one" })] });
    const store = new PostgresRunStore(db as never);
    await Promise.all([
      store.create({ agentId: "a", input: 1 }),
      store.create({ agentId: "a", input: 2 }),
    ]);
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it("error path — create rejects when the DB throws", async () => {
    const store = new PostgresRunStore(
      buildThrowingDb(new Error("connection refused")) as never
    );
    await expect(store.create({ agentId: "a", input: null })).rejects.toThrow(
      "connection refused"
    );
  });

  it("error path — get rejects when the DB throws", async () => {
    const store = new PostgresRunStore(
      buildThrowingDb(new Error("ECONNRESET")) as never
    );
    await expect(store.get("r")).rejects.toThrow("ECONNRESET");
  });
});

// ===========================================================================
// 8. PostgresAgentStore — Drizzle persistence
// ===========================================================================

describe("PostgresAgentStore (Drizzle mock) — deep persistence", () => {
  const baseAgent: AgentExecutionSpec = {
    id: "a1",
    name: "Test Agent",
    instructions: "Do things",
    modelTier: "chat",
  };

  it("save — inserts a new agent when none exists (upsert: insert branch)", async () => {
    const db = buildMockDb({ selectRows: [] });
    const store = new PostgresAgentStore(db as never);
    await store.save(baseAgent);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("save — re-registering the same id updates and bumps version (upsert: update branch)", async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ selectRows: [agentRow({ version: 3 })], log });
    const store = new PostgresAgentStore(db as never);
    await store.save(baseAgent);
    expect(db.update).toHaveBeenCalledTimes(1);
    const set = log.find((l) => l.op === "update" && l.fn === "set")!
      .args[0] as Record<string, unknown>;
    expect(set["version"]).toBe(4);
  });

  it("save — defaults tools/approval/active/metadata on insert", async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ selectRows: [], log });
    const store = new PostgresAgentStore(db as never);
    await store.save(baseAgent);
    const values = log.find((l) => l.op === "insert" && l.fn === "values")!
      .args[0] as Record<string, unknown>;
    expect(values["tools"]).toEqual([]);
    expect(values["approval"]).toBe("auto");
    expect(values["active"]).toBe(true);
    expect(values["metadata"]).toEqual({});
  });

  it('save — tenantId defaults to "default" on insert', async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ selectRows: [], log });
    const store = new PostgresAgentStore(db as never);
    await store.save(baseAgent);
    const values = log.find((l) => l.op === "insert" && l.fn === "values")!
      .args[0] as Record<string, unknown>;
    expect(values["tenantId"]).toBe("default");
  });

  it("get — returns a mapped AgentExecutionSpec", async () => {
    const db = buildMockDb({
      selectRows: [
        agentRow({
          id: "a1",
          tools: ["echo"],
          guardrails: { max: 1 },
          approval: "required",
          version: 2,
        }),
      ],
    });
    const store = new PostgresAgentStore(db as never);
    const agent = await store.get("a1");
    expect(agent!.tools).toEqual(["echo"]);
    expect(agent!.guardrails).toEqual({ max: 1 });
    expect(agent!.approval).toBe("required");
  });

  it("get — returns null when missing", async () => {
    const db = buildMockDb({ selectRows: [] });
    const store = new PostgresAgentStore(db as never);
    expect(await store.get("missing")).toBeNull();
  });

  it("list — defaults limit to 100", async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ selectRows: [], log });
    const store = new PostgresAgentStore(db as never);
    await store.list();
    expect(log.find((l) => l.fn === "limit")!.args[0]).toBe(100);
  });

  it("list — respects an explicit limit and active filter", async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ selectRows: [], log });
    const store = new PostgresAgentStore(db as never);
    await store.list({ limit: 3, active: false });
    expect(log.find((l) => l.fn === "limit")!.args[0]).toBe(3);
    expect(db.select).toHaveBeenCalled();
  });

  it("list — maps returned rows", async () => {
    const db = buildMockDb({ selectRows: [agentRow({ id: "z" })] });
    const store = new PostgresAgentStore(db as never);
    const agents = await store.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]!.id).toBe("z");
  });

  it("delete — performs a soft delete (active=false)", async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = [];
    const db = buildMockDb({ log });
    const store = new PostgresAgentStore(db as never);
    await store.delete("a1");
    expect(db.update).toHaveBeenCalledTimes(1);
    const set = log.find((l) => l.op === "update" && l.fn === "set")!
      .args[0] as Record<string, unknown>;
    expect(set["active"]).toBe(false);
    expect(set["updatedAt"]).toBeInstanceOf(Date);
  });

  it("error path — save rejects when the existence check DB call throws", async () => {
    const store = new PostgresAgentStore(
      buildThrowingDb(new Error("db down")) as never
    );
    await expect(store.save(baseAgent)).rejects.toThrow("db down");
  });

  it("error path — list rejects when the DB throws", async () => {
    const store = new PostgresAgentStore(
      buildThrowingDb(new Error("timeout")) as never
    );
    await expect(store.list()).rejects.toThrow("timeout");
  });
});
