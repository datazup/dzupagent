/**
 * Cross-tenant isolation coverage for the SSE events route (DZUPAGENT-SEC-M-01).
 *
 * Mirrors the pattern in `benchmark-routes-tenant-isolation.test.ts`:
 * a tiny middleware reads `x-test-tenant` and populates `c.set('apiKey', ...)`
 * so `getRequestingTenantId(c)` resolves to that tenant. Each test then
 * verifies that one tenant cannot subscribe to another tenant's events via
 * `GET /api/events/stream`.
 *
 * We bypass the normal eventBus → gateway path and publish envelopes
 * directly through the gateway so the test can stamp `tenantId` precisely
 * on each emitted event. The route is the unit under test — it must inject
 * the requesting tenant into the subscription filter so the gateway's
 * `matchesFilter` denies cross-tenant rows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createEventRoutes } from "../routes/events.js";
import {
  InMemoryEventGateway,
  type EventEnvelope,
} from "../events/event-gateway.js";
import type { AppEnv } from "../types.js";

function tenantHeaders(tenantId: string): HeadersInit {
  return { "x-test-tenant": tenantId };
}

/**
 * Deterministically flush the gateway's dispatch instead of sleeping a fixed
 * 50-100ms (TEST-M-06). `InMemoryEventGateway.drain()` enqueues delivery via
 * `queueMicrotask` (see event-gateway.ts:drain), so two microtask flushes let
 * every queued envelope reach the SSE sink before the test reads the stream —
 * matching the `waitForDispatch` helper already adopted in
 * `events-routes.test.ts`. On loaded CI this cannot miss the delivery window
 * the way a fixed timer can, and it never wastes wall-clock on fast hosts.
 */
async function waitForDispatch(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createTenantApp() {
  const gateway = new InMemoryEventGateway();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const tenantId = c.req.header("x-test-tenant");
    if (tenantId) {
      c.set("apiKey", { id: `key-${tenantId}`, tenantId });
    }
    await next();
  });
  app.route("/api/events", createEventRoutes({ eventGateway: gateway }));
  return { app, gateway };
}

/**
 * Read SSE bytes from the response until either the deadline elapses or all
 * expected events have arrived. Returns raw SSE text.
 */
async function readSSERaw(
  response: Response,
  timeoutMs: number,
  stopOnEvent?: string
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining)
        ),
      ]);
      if (result.done) break;
      raw += decoder.decode(result.value, { stream: true });
      if (stopOnEvent && raw.includes(`event: ${stopOnEvent}`)) break;
    }
  } finally {
    reader.releaseLock();
  }
  return raw;
}

function parseSSEPairs(raw: string): Array<{ event: string; data: string }> {
  const pairs: Array<{ event: string; data: string }> = [];
  let event = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) {
      event = line.slice(7).trim();
    } else if (line.startsWith("data: ") && event) {
      pairs.push({ event, data: line.slice(6) });
      event = "";
    }
  }
  return pairs;
}

/**
 * Publish a pre-built envelope through the gateway without round-tripping
 * through `toEnvelope` (which only stamps tenantId from payload). Direct
 * envelope injection is the simplest way to test the matchesFilter +
 * subscription path with arbitrary tenant stamps.
 */
function publishEnvelope(
  gateway: InMemoryEventGateway,
  partial: Omit<EventEnvelope, "id" | "version" | "timestamp" | "payload"> & {
    payload?: EventEnvelope["payload"];
  }
): void {
  // The route subscribes to the gateway; we drive the gateway by emitting a
  // synthetic DzupEvent that already carries tenantId so toEnvelope will
  // stamp it correctly.
  const event = {
    type: partial.type,
    ...(partial.runId !== undefined ? { runId: partial.runId } : {}),
    ...(partial.agentId !== undefined ? { agentId: partial.agentId } : {}),
    ...(partial.tenantId !== undefined ? { tenantId: partial.tenantId } : {}),
  } as Parameters<InMemoryEventGateway["publish"]>[0];
  gateway.publish(event);
}

describe("GET /api/events/stream — tenant isolation (DZUPAGENT-SEC-M-01)", () => {
  let app: Hono<AppEnv>;
  let gateway: InMemoryEventGateway;

  beforeEach(() => {
    const ctx = createTenantApp();
    app = ctx.app;
    gateway = ctx.gateway;
  });

  afterEach(() => {
    gateway.destroy();
  });

  it("subscriber sees their own tenant's event", async () => {
    const res = await app.request("/api/events/stream", {
      headers: tenantHeaders("tenant-a"),
    });
    await readSSERaw(res, 200, "connected");

    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "a1",
      runId: "r1",
      tenantId: "tenant-a",
    });
    await waitForDispatch();

    const raw = await readSSERaw(res, 500, "agent:started");
    const pairs = parseSSEPairs(raw);
    const delivered = pairs.filter((p) => p.event === "agent:started");
    expect(delivered.length).toBeGreaterThanOrEqual(1);

    for (const pair of delivered) {
      const env = JSON.parse(pair.data) as { tenantId?: string };
      expect(env.tenantId).toBe("tenant-a");
    }
  });

  it("subscriber receives NOTHING when only the OTHER tenant's events are published", async () => {
    const res = await app.request("/api/events/stream", {
      headers: tenantHeaders("tenant-a"),
    });
    await readSSERaw(res, 200, "connected");

    // Publish three events that all belong to tenant-b. None must reach the
    // tenant-a subscriber.
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "a1",
      runId: "r-b-1",
      tenantId: "tenant-b",
    });
    publishEnvelope(gateway, {
      type: "agent:completed",
      agentId: "a1",
      runId: "r-b-1",
      tenantId: "tenant-b",
    });
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "a2",
      runId: "r-b-2",
      tenantId: "tenant-b",
    });
    await waitForDispatch();

    const raw = await readSSERaw(res, 400);
    const pairs = parseSSEPairs(raw);
    const tenantEvents = pairs.filter(
      (p) => p.event === "agent:started" || p.event === "agent:completed"
    );
    expect(tenantEvents).toHaveLength(0);
  });

  it("tenant subscriber receives only their own events when both tenants emit interleaved", async () => {
    const res = await app.request("/api/events/stream", {
      headers: tenantHeaders("tenant-a"),
    });
    await readSSERaw(res, 200, "connected");

    // Interleave two tenant-a events with two tenant-b events.
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "agent-a-1",
      runId: "r-a-1",
      tenantId: "tenant-a",
    });
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "agent-b-1",
      runId: "r-b-1",
      tenantId: "tenant-b",
    });
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "agent-a-2",
      runId: "r-a-2",
      tenantId: "tenant-a",
    });
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "agent-b-2",
      runId: "r-b-2",
      tenantId: "tenant-b",
    });
    await waitForDispatch();

    const raw = await readSSERaw(res, 500);
    const pairs = parseSSEPairs(raw);
    const delivered = pairs.filter((p) => p.event === "agent:started");
    // Exactly two tenant-a events — never any tenant-b leakage.
    expect(delivered).toHaveLength(2);
    for (const pair of delivered) {
      const env = JSON.parse(pair.data) as {
        tenantId?: string;
        agentId?: string;
      };
      expect(env.tenantId).toBe("tenant-a");
      expect(env.agentId).toMatch(/^agent-a-/);
    }
  });

  it("tenant filter is combined with runId — only matching runId AND tenant pass", async () => {
    const res = await app.request("/api/events/stream?runId=r-a-target", {
      headers: tenantHeaders("tenant-a"),
    });
    await readSSERaw(res, 200, "connected");

    // Right tenant, wrong run.
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "a1",
      runId: "r-a-other",
      tenantId: "tenant-a",
    });
    // Wrong tenant, target run id (spoofed run id should NOT cross tenants).
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "a2",
      runId: "r-a-target",
      tenantId: "tenant-b",
    });
    // Right tenant, right run — only this one should arrive.
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "a3",
      runId: "r-a-target",
      tenantId: "tenant-a",
    });
    await waitForDispatch();

    const raw = await readSSERaw(res, 500);
    const pairs = parseSSEPairs(raw);
    const delivered = pairs.filter((p) => p.event === "agent:started");
    expect(delivered).toHaveLength(1);
    const env = JSON.parse(delivered[0]!.data) as {
      tenantId?: string;
      runId?: string;
    };
    expect(env.tenantId).toBe("tenant-a");
    expect(env.runId).toBe("r-a-target");
  });

  it("tenant filter combined with agentId — wrong-tenant events with the same agentId are dropped", async () => {
    const res = await app.request("/api/events/stream?agentId=shared-agent", {
      headers: tenantHeaders("tenant-a"),
    });
    await readSSERaw(res, 200, "connected");

    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "shared-agent",
      runId: "r-b",
      tenantId: "tenant-b",
    });
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "shared-agent",
      runId: "r-a",
      tenantId: "tenant-a",
    });
    await waitForDispatch();

    const raw = await readSSERaw(res, 500);
    const pairs = parseSSEPairs(raw);
    const delivered = pairs.filter((p) => p.event === "agent:started");
    expect(delivered).toHaveLength(1);
    const env = JSON.parse(delivered[0]!.data) as {
      tenantId?: string;
      runId?: string;
    };
    expect(env.tenantId).toBe("tenant-a");
    expect(env.runId).toBe("r-a");
  });

  it("combined runId + agentId + tenant filter still works (tenant always wins)", async () => {
    const res = await app.request("/api/events/stream?runId=r1&agentId=a1", {
      headers: tenantHeaders("tenant-a"),
    });
    await readSSERaw(res, 200, "connected");

    // Same runId + agentId, different tenant — must be dropped.
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "a1",
      runId: "r1",
      tenantId: "tenant-b",
    });
    // Correct tenant — should arrive.
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "a1",
      runId: "r1",
      tenantId: "tenant-a",
    });
    await waitForDispatch();

    const raw = await readSSERaw(res, 500);
    const pairs = parseSSEPairs(raw);
    const delivered = pairs.filter((p) => p.event === "agent:started");
    expect(delivered).toHaveLength(1);
    const env = JSON.parse(delivered[0]!.data) as { tenantId?: string };
    expect(env.tenantId).toBe("tenant-a");
  });

  it("no apiKey context resolves to the default tenant and only receives default-tenant envelopes", async () => {
    // No x-test-tenant header → apiKey is unset → getRequestingTenantId returns DEFAULT_TENANT_ID.
    // This mirrors the existing auth-disabled deployment mode used by
    // `events-routes.test.ts`. We emit one event WITHOUT a tenant stamp
    // (legacy publisher path) and one stamped 'tenant-b'. Only the legacy
    // event should be received because untagged envelopes get stamped with
    // DEFAULT_TENANT_ID by toEnvelope (see event-gateway.ts:DEFAULT_TENANT_ID).
    const res = await app.request("/api/events/stream");
    await readSSERaw(res, 200, "connected");

    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "a1",
      runId: "r1",
      // no tenantId — falls back to DEFAULT_TENANT_ID
    });
    publishEnvelope(gateway, {
      type: "agent:started",
      agentId: "a2",
      runId: "r2",
      tenantId: "tenant-b",
    });
    await waitForDispatch();

    const raw = await readSSERaw(res, 500);
    const pairs = parseSSEPairs(raw);
    const delivered = pairs.filter((p) => p.event === "agent:started");
    expect(delivered).toHaveLength(1);
    const env = JSON.parse(delivered[0]!.data) as { agentId?: string };
    expect(env.agentId).toBe("a1");
  });
});
