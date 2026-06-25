/**
 * Deep route + store tests for schedule endpoints and InMemoryScheduleStore.
 *
 * Covers:
 *  - Schedule route CRUD (create, list, get, update, delete, trigger)
 *  - Request validation (400 on bad input, 404 on missing resource)
 *  - Tenant isolation via apiKey context
 *  - InMemoryScheduleStore: save, list, get, update, delete, claimDue, markFired
 *  - computeNextRunAt helper
 *
 * No real database — InMemoryScheduleStore is the persistence layer.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { createScheduleRoutes } from "../routes/schedules.js";
import {
  InMemoryScheduleStore,
  computeNextRunAt,
} from "../schedules/schedule-store.js";
import type { ScheduleStore } from "../schedules/schedule-store.js";
import type { AppEnv } from "../types.js";

// ---------------------------------------------------------------------------
// Test-app factory
// ---------------------------------------------------------------------------

function buildApp(
  store: ScheduleStore,
  tenantId = "tenant-1",
  onManualTrigger?: (schedule: {
    id: string;
    workflowText: string;
  }) => Promise<void>
) {
  const routes = createScheduleRoutes({
    scheduleStore: store,
    onManualTrigger,
  });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("apiKey" as never, { tenantId } as never);
    await next();
  });
  app.route("/api/schedules", routes);
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

const VALID_SCHEDULE = {
  name: "Daily backup",
  cronExpression: "0 2 * * *",
  workflowText: "backup: true",
  enabled: true,
};

// ---------------------------------------------------------------------------
// POST /api/schedules — create
// ---------------------------------------------------------------------------

describe("POST /api/schedules", () => {
  let store: InMemoryScheduleStore;
  let app: Hono;

  beforeEach(() => {
    store = new InMemoryScheduleStore();
    app = buildApp(store);
  });

  it("returns 201 with the created schedule", async () => {
    const res = await post(app, "/api/schedules", VALID_SCHEDULE);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["id"]).toBeTruthy();
    expect(body["name"]).toBe("Daily backup");
    expect(body["cronExpression"]).toBe("0 2 * * *");
    expect(body["enabled"]).toBe(true);
  });

  it("accepts a caller-supplied id", async () => {
    const res = await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "my-sched",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("my-sched");
  });

  it("defaults enabled to true when omitted", async () => {
    const { enabled: _e, ...rest } = VALID_SCHEDULE;
    const res = await post(app, "/api/schedules", rest);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(true);
  });

  it("stores schedule under the requesting tenant", async () => {
    await post(app, "/api/schedules", VALID_SCHEDULE);
    const schedules = await store.list({ tenantId: "tenant-1" });
    expect(schedules).toHaveLength(1);
  });

  it("returns 400 when name is missing", async () => {
    const { name: _n, ...rest } = VALID_SCHEDULE;
    const res = await post(app, "/api/schedules", rest);
    expect(res.status).toBe(400);
  });

  it("returns 400 when cronExpression is missing", async () => {
    const { cronExpression: _c, ...rest } = VALID_SCHEDULE;
    const res = await post(app, "/api/schedules", rest);
    expect(res.status).toBe(400);
  });

  it("returns 400 when workflowText is missing", async () => {
    const { workflowText: _w, ...rest } = VALID_SCHEDULE;
    const res = await post(app, "/api/schedules", rest);
    expect(res.status).toBe(400);
  });

  it("populates nextRunAt from cron expression", async () => {
    const res = await post(app, "/api/schedules", VALID_SCHEDULE);
    const body = (await res.json()) as { nextRunAt: string | null };
    // nextRunAt may be null for weird crons but our valid one should produce a value
    expect(body.nextRunAt).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GET /api/schedules — list
// ---------------------------------------------------------------------------

describe("GET /api/schedules", () => {
  let store: InMemoryScheduleStore;
  let app: Hono;

  beforeEach(() => {
    store = new InMemoryScheduleStore();
    app = buildApp(store);
  });

  it("returns empty array when no schedules exist", async () => {
    const res = await app.request("/api/schedules");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedules: unknown[] };
    expect(body.schedules).toEqual([]);
  });

  it("returns all schedules for the tenant", async () => {
    await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "s1",
      name: "S1",
    });
    await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "s2",
      name: "S2",
    });

    const res = await app.request("/api/schedules");
    const body = (await res.json()) as { schedules: Array<{ name: string }> };
    expect(body.schedules).toHaveLength(2);
  });

  it("filters by enabled=true", async () => {
    await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "s1",
      enabled: true,
    });
    await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "s2",
      enabled: false,
    });

    const res = await app.request("/api/schedules?enabled=true");
    const body = (await res.json()) as {
      schedules: Array<{ enabled: boolean }>;
    };
    expect(body.schedules.every((s) => s.enabled === true)).toBe(true);
  });

  it("filters by enabled=false", async () => {
    await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "s1",
      enabled: true,
    });
    await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "s2",
      enabled: false,
    });

    const res = await app.request("/api/schedules?enabled=false");
    const body = (await res.json()) as {
      schedules: Array<{ enabled: boolean }>;
    };
    expect(body.schedules.every((s) => s.enabled === false)).toBe(true);
  });

  it("does not return schedules belonging to another tenant", async () => {
    const app2 = buildApp(store, "tenant-2");
    await post(app2, "/api/schedules", { ...VALID_SCHEDULE, id: "t2-sched" });

    const res = await app.request("/api/schedules");
    const body = (await res.json()) as { schedules: unknown[] };
    expect(body.schedules).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/schedules/:id — get one
// ---------------------------------------------------------------------------

describe("GET /api/schedules/:id", () => {
  let store: InMemoryScheduleStore;
  let app: Hono;

  beforeEach(() => {
    store = new InMemoryScheduleStore();
    app = buildApp(store);
  });

  it("returns the schedule by id", async () => {
    const createRes = await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "sched-1",
    });
    const created = (await createRes.json()) as { id: string };

    const res = await app.request(`/api/schedules/${created.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.id).toBe("sched-1");
    expect(body.name).toBe("Daily backup");
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.request("/api/schedules/nonexistent");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when schedule belongs to another tenant", async () => {
    await store.save({
      ...VALID_SCHEDULE,
      id: "other-sched",
      tenantId: "tenant-2",
    });

    const res = await app.request("/api/schedules/other-sched");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/schedules/:id — update
// ---------------------------------------------------------------------------

describe("PUT /api/schedules/:id", () => {
  let store: InMemoryScheduleStore;
  let app: Hono;

  beforeEach(() => {
    store = new InMemoryScheduleStore();
    app = buildApp(store);
  });

  it("updates the schedule name", async () => {
    const createRes = await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "s1",
    });
    const created = (await createRes.json()) as { id: string };

    const res = await put(app, `/api/schedules/${created.id}`, {
      name: "Updated name",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("Updated name");
  });

  it("can disable a schedule", async () => {
    const createRes = await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "s1",
    });
    const created = (await createRes.json()) as { id: string };

    const res = await put(app, `/api/schedules/${created.id}`, {
      enabled: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  it("returns 404 for unknown id", async () => {
    const res = await put(app, "/api/schedules/ghost", { name: "x" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when schedule belongs to another tenant", async () => {
    await store.save({ ...VALID_SCHEDULE, id: "other", tenantId: "tenant-2" });

    const res = await put(app, "/api/schedules/other", { name: "hack" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/schedules/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/schedules/:id", () => {
  let store: InMemoryScheduleStore;
  let app: Hono;

  beforeEach(() => {
    store = new InMemoryScheduleStore();
    app = buildApp(store);
  });

  it("returns 200 with deleted:true on success", async () => {
    const createRes = await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "s1",
    });
    const created = (await createRes.json()) as { id: string };

    const res = await del(app, `/api/schedules/${created.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });

  it("returns 404 for unknown id", async () => {
    const res = await del(app, "/api/schedules/ghost");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when schedule belongs to another tenant", async () => {
    await store.save({
      ...VALID_SCHEDULE,
      id: "foreign",
      tenantId: "tenant-99",
    });
    const res = await del(app, "/api/schedules/foreign");
    expect(res.status).toBe(404);
  });

  it("schedule is no longer retrievable after deletion", async () => {
    const createRes = await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "s1",
    });
    const created = (await createRes.json()) as { id: string };

    await del(app, `/api/schedules/${created.id}`);
    const res = await app.request(`/api/schedules/${created.id}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/schedules/:id/trigger — manual trigger
// ---------------------------------------------------------------------------

describe("POST /api/schedules/:id/trigger", () => {
  it("calls onManualTrigger with schedule id and workflowText", async () => {
    const store = new InMemoryScheduleStore();
    const triggered: Array<{ id: string; workflowText: string }> = [];
    const app = buildApp(store, "tenant-1", async (sched) => {
      triggered.push(sched);
    });

    const createRes = await post(app, "/api/schedules", {
      ...VALID_SCHEDULE,
      id: "fire-me",
    });
    const created = (await createRes.json()) as { id: string };

    const res = await post(app, `/api/schedules/${created.id}/trigger`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      triggered: boolean;
      scheduleId: string;
    };
    expect(body.triggered).toBe(true);
    expect(body.scheduleId).toBe("fire-me");

    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.id).toBe("fire-me");
    expect(triggered[0]!.workflowText).toBe(VALID_SCHEDULE.workflowText);
  });

  it("returns 200 when no onManualTrigger callback is provided", async () => {
    const store = new InMemoryScheduleStore();
    const app = buildApp(store);
    await post(app, "/api/schedules", { ...VALID_SCHEDULE, id: "no-cb" });

    const res = await post(app, "/api/schedules/no-cb/trigger");
    expect(res.status).toBe(200);
  });

  it("returns 404 when triggering a non-existent schedule", async () => {
    const store = new InMemoryScheduleStore();
    const app = buildApp(store);

    const res = await post(app, "/api/schedules/ghost/trigger");
    expect(res.status).toBe(404);
  });

  it("returns 404 when schedule belongs to another tenant", async () => {
    const store = new InMemoryScheduleStore();
    await store.save({
      ...VALID_SCHEDULE,
      id: "foreign",
      tenantId: "tenant-2",
    });
    const app = buildApp(store, "tenant-1");

    const res = await post(app, "/api/schedules/foreign/trigger");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// InMemoryScheduleStore — unit tests
// ---------------------------------------------------------------------------

describe("InMemoryScheduleStore", () => {
  let store: InMemoryScheduleStore;

  beforeEach(() => {
    store = new InMemoryScheduleStore();
  });

  describe("save()", () => {
    it("creates a schedule and sets createdAt and updatedAt", async () => {
      const record = await store.save({
        id: "s1",
        name: "Test",
        cronExpression: "* * * * *",
        workflowText: "run: true",
        enabled: true,
      });
      expect(record.id).toBe("s1");
      expect(record.createdAt).toBeTruthy();
      expect(record.updatedAt).toBeTruthy();
    });

    it("upserts when called with the same id", async () => {
      await store.save({
        id: "s1",
        name: "Original",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
      });
      const updated = await store.save({
        id: "s1",
        name: "Updated",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
      });
      expect(updated.name).toBe("Updated");
      expect((await store.list()).length).toBe(1);
    });

    it("preserves createdAt on upsert", async () => {
      const first = await store.save({
        id: "s1",
        name: "First",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
      });
      await new Promise((r) => setTimeout(r, 5));
      const second = await store.save({
        id: "s1",
        name: "Second",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
      });
      expect(second.createdAt).toBe(first.createdAt);
    });

    it("auto-derives nextRunAt from cron expression", async () => {
      const record = await store.save({
        id: "s1",
        name: "T",
        cronExpression: "0 * * * *",
        workflowText: "x",
        enabled: true,
      });
      expect(record.nextRunAt).not.toBeNull();
    });
  });

  describe("list()", () => {
    it("returns all schedules when no filter", async () => {
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
        tenantId: "a",
      });
      await store.save({
        id: "s2",
        name: "S2",
        cronExpression: "* * * * *",
        workflowText: "y",
        enabled: false,
        tenantId: "b",
      });
      const all = await store.list();
      expect(all).toHaveLength(2);
    });

    it("filters by enabled", async () => {
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
      });
      await store.save({
        id: "s2",
        name: "S2",
        cronExpression: "* * * * *",
        workflowText: "y",
        enabled: false,
      });

      const enabled = await store.list({ enabled: true });
      expect(enabled.every((s) => s.enabled)).toBe(true);

      const disabled = await store.list({ enabled: false });
      expect(disabled.every((s) => !s.enabled)).toBe(true);
    });

    it("filters by tenantId", async () => {
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
        tenantId: "ta",
      });
      await store.save({
        id: "s2",
        name: "S2",
        cronExpression: "* * * * *",
        workflowText: "y",
        enabled: true,
        tenantId: "tb",
      });

      const ta = await store.list({ tenantId: "ta" });
      expect(ta).toHaveLength(1);
      expect(ta[0]!.id).toBe("s1");
    });
  });

  describe("get()", () => {
    it("returns schedule by id", async () => {
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
      });
      const record = await store.get("s1");
      expect(record).not.toBeNull();
      expect(record!.id).toBe("s1");
    });

    it("returns null for unknown id", async () => {
      expect(await store.get("ghost")).toBeNull();
    });

    it("returns null when tenantId does not match", async () => {
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
        tenantId: "ta",
      });
      expect(await store.get("s1", "tb")).toBeNull();
    });
  });

  describe("update()", () => {
    it("updates fields and returns the updated record", async () => {
      await store.save({
        id: "s1",
        name: "Old",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
      });
      const updated = await store.update("s1", { name: "New", enabled: false });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New");
      expect(updated!.enabled).toBe(false);
    });

    it("returns null when id does not exist", async () => {
      expect(await store.update("ghost", { name: "x" })).toBeNull();
    });

    it("returns null when tenantId does not match", async () => {
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
        tenantId: "ta",
      });
      expect(await store.update("s1", { name: "hack" }, "tb")).toBeNull();
    });
  });

  describe("delete()", () => {
    it("deletes an existing schedule and returns true", async () => {
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
      });
      expect(await store.delete("s1")).toBe(true);
      expect(await store.get("s1")).toBeNull();
    });

    it("returns false for unknown id", async () => {
      expect(await store.delete("ghost")).toBe(false);
    });

    it("returns false when tenantId does not match", async () => {
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
        tenantId: "ta",
      });
      expect(await store.delete("s1", "tb")).toBe(false);
      expect(await store.get("s1", "ta")).not.toBeNull();
    });
  });

  describe("claimDue()", () => {
    it("claims a schedule that is due", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
        nextRunAt: past,
      });

      const claimed = await store.claimDue(new Date(), {
        limit: 10,
        claimerId: "node-1",
        skipIfRunning: false,
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.claimedBy).toBe("node-1");
    });

    it("does not claim disabled schedules", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: false,
        nextRunAt: past,
      });

      const claimed = await store.claimDue(new Date(), {
        limit: 10,
        claimerId: "node-1",
        skipIfRunning: false,
      });
      expect(claimed).toHaveLength(0);
    });

    it("does not claim a schedule that is not yet due", async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
        nextRunAt: future,
      });

      const claimed = await store.claimDue(new Date(), {
        limit: 10,
        claimerId: "node-1",
        skipIfRunning: false,
      });
      expect(claimed).toHaveLength(0);
    });

    it("skips running schedules when skipIfRunning is true", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
        nextRunAt: past,
        running: true,
      });

      const claimed = await store.claimDue(new Date(), {
        limit: 10,
        claimerId: "node-1",
        skipIfRunning: true,
      });
      expect(claimed).toHaveLength(0);
    });

    it("respects the limit parameter", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
        nextRunAt: past,
      });
      await store.save({
        id: "s2",
        name: "S2",
        cronExpression: "* * * * *",
        workflowText: "y",
        enabled: true,
        nextRunAt: past,
      });

      const claimed = await store.claimDue(new Date(), {
        limit: 1,
        claimerId: "node-1",
        skipIfRunning: false,
      });
      expect(claimed).toHaveLength(1);
    });

    it("advances nextRunAt after claim so a second call does not re-claim", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
        nextRunAt: past,
      });

      await store.claimDue(new Date(), {
        limit: 10,
        claimerId: "node-1",
        skipIfRunning: false,
      });
      const second = await store.claimDue(new Date(), {
        limit: 10,
        claimerId: "node-2",
        skipIfRunning: false,
      });
      expect(second).toHaveLength(0);
    });
  });

  describe("markFired()", () => {
    it("marks a schedule as not running and records lastFiredAt", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      await store.save({
        id: "s1",
        name: "S1",
        cronExpression: "* * * * *",
        workflowText: "x",
        enabled: true,
        nextRunAt: past,
        running: true,
      });

      await store.markFired("s1", new Date(), "run-abc");
      const record = await store.get("s1");
      expect(record!.running).toBe(false);
      expect(record!.lastFiredAt).toBeTruthy();
      expect(
        (record!.metadata as Record<string, unknown>)["lastFiredRunId"]
      ).toBe("run-abc");
    });

    it("is a no-op for unknown id", async () => {
      await expect(
        store.markFired("ghost", new Date(), "run-x")
      ).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// computeNextRunAt helper
// ---------------------------------------------------------------------------

describe("computeNextRunAt()", () => {
  it("returns a future date for a valid cron expression", () => {
    const after = new Date("2026-01-01T00:00:00.000Z");
    const next = computeNextRunAt("0 * * * *", after);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });

  it("returns null for an invalid cron expression", () => {
    const next = computeNextRunAt("not-a-cron", new Date());
    expect(next).toBeNull();
  });

  it("returns a date strictly after the provided anchor", () => {
    const after = new Date("2026-06-01T12:30:00.000Z");
    const next = computeNextRunAt("*/5 * * * *", after);
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });
});
