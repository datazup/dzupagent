/**
 * DZUPAGENT-SEC-I-04: the public, unauthenticated `/.well-known/agent.json`
 * discovery endpoint is rate-limited to stop discovery floods.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { InMemoryA2ATaskStore } from "../task-handler.js";
import { createA2ARoutes } from "../../routes/a2a.js";
import { buildAgentCard } from "../agent-card.js";

function buildApp(maxRequests: number): Hono {
  const agentCard = buildAgentCard({
    name: "test-server",
    description: "Test agent server",
    baseUrl: "http://localhost:4000",
    version: "1.0.0",
    agents: [{ name: "test-agent", description: "A test agent" }],
  });

  const app = new Hono();
  const routes = createA2ARoutes({
    agentCard,
    taskStore: new InMemoryA2ATaskStore(),
    // Tight window so the test trips the limit deterministically.
    wellKnownRateLimit: {
      maxRequests,
      windowMs: 60_000,
      trustForwardedFor: true,
    },
  });
  app.route("", routes);
  return app;
}

const IP = { "X-Forwarded-For": "203.0.113.7" };

describe("GET /.well-known/agent.json rate limiting (SEC-I-04)", () => {
  it("serves the agent card under the threshold", async () => {
    const app = buildApp(3);
    const res = await app.request("/.well-known/agent.json", { headers: IP });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("test-server");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("3");
  });

  it("returns 429 after the threshold is exceeded for the same client", async () => {
    const app = buildApp(3);
    // First 3 succeed.
    for (let i = 0; i < 3; i++) {
      const ok = await app.request("/.well-known/agent.json", { headers: IP });
      expect(ok.status).toBe(200);
    }
    // 4th is throttled.
    const limited = await app.request("/.well-known/agent.json", {
      headers: IP,
    });
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });

  it("keys the limit per client IP (a different IP is not throttled)", async () => {
    const app = buildApp(2);
    for (let i = 0; i < 2; i++) {
      await app.request("/.well-known/agent.json", { headers: IP });
    }
    // Same IP is now over the limit...
    expect(
      (await app.request("/.well-known/agent.json", { headers: IP })).status
    ).toBe(429);
    // ...but a different IP still gets served.
    const other = await app.request("/.well-known/agent.json", {
      headers: { "X-Forwarded-For": "198.51.100.42" },
    });
    expect(other.status).toBe(200);
  });
});
