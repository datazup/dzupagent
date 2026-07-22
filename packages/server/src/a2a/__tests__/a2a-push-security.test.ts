import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { JsonRpcResponse } from "@dzupagent/core";
import { buildAgentCard } from "../agent-card.js";
import { deliverA2APushNotification } from "../push-notifications.js";
import { InMemoryA2ATaskStore } from "../task-handler.js";
import type { A2ATask } from "../task-handler.js";
import { createA2ARoutes } from "../../routes/a2a.js";

function createApp(store: InMemoryA2ATaskStore) {
  const agentCard = buildAgentCard({
    name: "test-server",
    description: "Test agent server",
    baseUrl: "https://agents.example.com",
    version: "1.0.0",
    agents: [{ name: "test-agent", description: "A test agent" }],
  });
  const app = new Hono();
  app.route("", createA2ARoutes({ agentCard, taskStore: store }));
  return app;
}

async function createTask(app: Hono): Promise<string> {
  const res = await app.request("/a2a", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/send",
      params: {
        agentName: "test-agent",
        message: { role: "user", parts: [{ type: "text", text: "hello" }] },
      },
    }),
  });
  const body = (await res.json()) as JsonRpcResponse & {
    result?: { id: string };
  };
  expect(body.result?.id).toBeTruthy();
  return body.result!.id;
}

describe("A2A push notification security", () => {
  it("rejects internal callback URLs before storage", async () => {
    const store = new InMemoryA2ATaskStore();
    const app = createApp(store);
    const taskId = await createTask(app);

    const res = await app.request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/pushNotification/set",
        params: {
          id: taskId,
          pushNotificationConfig: {
            url: "https://127.0.0.1/callback",
            token: "secret-token",
          },
        },
      }),
    });

    const body = (await res.json()) as JsonRpcResponse & {
      error?: { code: number; message: string };
    };
    expect(body.error?.code).toBe(-32602);
    // ERR-H-11: the raw rejection reason must NOT be forwarded to the external
    // A2A client; a fixed generic message is returned instead.
    expect(body.error?.message).toBe("Invalid push notification config");
    expect(body.error?.message).not.toContain("A2A push callback URL rejected");
    expect((await store.get(taskId))?.pushNotificationConfig).toBeUndefined();
  });

  it("allows public HTTPS callbacks and does not echo stored tokens", async () => {
    const store = new InMemoryA2ATaskStore();
    const app = createApp(store);
    const taskId = await createTask(app);

    const setRes = await app.request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/pushNotification/set",
        params: {
          id: taskId,
          pushNotificationConfig: {
            url: "https://example.com/callback",
            token: "secret-token",
            events: ["task.completed"],
          },
        },
      }),
    });

    const setBody = (await setRes.json()) as JsonRpcResponse & {
      result?: { pushNotificationConfig?: Record<string, unknown> };
    };
    expect(setBody.result?.pushNotificationConfig).toEqual({
      url: "https://example.com/callback",
      events: ["task.completed"],
    });
    expect(setBody.result?.pushNotificationConfig).not.toHaveProperty("token");
    expect((await store.get(taskId))?.pushNotificationConfig?.token).toBe(
      "secret-token"
    );

    const getRes = await app.request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tasks/pushNotification/get",
        params: { id: taskId },
      }),
    });

    const getBody = (await getRes.json()) as JsonRpcResponse & {
      result?: Record<string, unknown>;
    };
    expect(getBody.result).toEqual({
      url: "https://example.com/callback",
      events: ["task.completed"],
    });
    expect(getBody.result).not.toHaveProperty("token");
  });

  it("revalidates redirects and blocks redirects to internal addresses", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url) === "https://example.com/callback") {
        expect(init?.method).toBe("POST");
        expect(
          (init?.headers as Record<string, string>)?.["Authorization"]
        ).toBe("Bearer secret-token");
        expect(JSON.parse(String(init?.body))).toEqual({
          id: "task-1",
          state: "completed",
          agentName: "test-agent",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:01.000Z",
          output: { ok: true },
        });
        return new Response("", {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data" },
        });
      }
      return new Response("should not fetch", { status: 200 });
    });

    const task: A2ATask = {
      id: "task-1",
      state: "completed",
      agentName: "test-agent",
      input: "sensitive input",
      output: { ok: true },
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:01.000Z",
      messages: [
        { role: "user", parts: [{ type: "text", text: "sensitive message" }] },
      ],
      artifacts: [{ parts: [{ type: "text", text: "sensitive artifact" }] }],
      pushNotificationConfig: {
        url: "https://example.com/callback",
        token: "secret-token",
      },
    };

    await expect(
      deliverA2APushNotification(task, {
        fetchImpl: fetchMock as typeof fetch,
      })
    ).rejects.toThrow("Outbound URL rejected");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports explicit allowlists for intentional internal callbacks", async () => {
    const store = new InMemoryA2ATaskStore({
      pushNotificationUrlPolicy: {
        allowedHosts: ["localhost:9443"],
        allowHttp: true,
      },
    });

    const task = await store.create({
      agentName: "test-agent",
      input: "hello",
      state: "submitted",
    });

    await expect(
      store.setPushConfig(task.id, {
        url: "http://localhost:9443/callback",
      })
    ).resolves.toMatchObject({
      pushNotificationConfig: { url: "http://localhost:9443/callback" },
    });
  });

  // ERR-H-11: a thrown handler error must not forward raw err.message to the
  // external A2A client, and the failure must be logged server-side.
  it("does not leak raw handler error text to the JSON-RPC client (ERR-H-11)", async () => {
    class ThrowingStore extends InMemoryA2ATaskStore {
      override async get(): Promise<A2ATask | null> {
        throw new Error("PRISMA: connection refused to db host 10.0.0.5:5432");
      }
    }

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new ThrowingStore();
    const app = createApp(store);

    const res = await app.request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tasks/get",
        params: { id: "task-x" },
      }),
    });

    const body = (await res.json()) as JsonRpcResponse & {
      error?: { code: number; message: string };
    };
    // INTERNAL_ERROR with a generic message, never the raw driver text.
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).not.toContain("PRISMA");
    expect(body.error?.message).not.toContain("10.0.0.5");
    // The detail is logged server-side (structured single-line JSON to stderr).
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("a2a.jsonrpc.tasks/get");
    expect(logged).toContain("PRISMA");

    errorSpy.mockRestore();
  });
});
