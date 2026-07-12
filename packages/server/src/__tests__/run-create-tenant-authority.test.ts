/**
 * R3-ISO-01/02 — tenant authority at run creation.
 *
 * The authenticated API key is the only authority for a run's tenant. A
 * caller must not be able to:
 *  - spoof another tenant via `metadata.tenantId` (billing/event/reflection
 *    attribution all read `job.metadata.tenantId` downstream), or
 *  - execute another tenant's agent by guessing its agentId.
 *
 * When auth is disabled entirely the library default is preserved:
 * caller-supplied metadata passes through untouched.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createForgeApp, type ForgeServerConfig } from "../app.js";
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from "@dzupagent/core";
import type {
  JobProcessor,
  QueueStats,
  RunJob,
  RunQueue,
} from "../queue/run-queue.js";
import type {
  PostgresApiKeyStore,
  ApiKeyRecord,
} from "../persistence/api-key-store.js";

function makeApiKeyStore(
  records: Record<string, ApiKeyRecord>
): PostgresApiKeyStore {
  return {
    validate: async (key: string) => records[key] ?? null,
    create: async () => {
      throw new Error("not implemented");
    },
    revoke: async () => {},
    list: async () => [],
    get: async () => null,
  } as unknown as PostgresApiKeyStore;
}

function apiKeyRecord(id: string, tenantId: string): ApiKeyRecord {
  return {
    id,
    ownerId: id,
    tenantId,
    name: "test key",
    role: "operator",
    rateLimitTier: "standard",
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    metadata: {},
  };
}

class CapturingRunQueue implements RunQueue {
  enqueued: Array<Omit<RunJob, "id" | "createdAt" | "attempts">> = [];

  async enqueue(
    job: Omit<RunJob, "id" | "createdAt" | "attempts">
  ): Promise<RunJob> {
    this.enqueued.push(job);
    return {
      ...job,
      attempts: 0,
      id: `job-${this.enqueued.length}`,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }
  start(_processor: JobProcessor): void {}
  async stop(_waitForActive?: boolean): Promise<void> {}
  async stats(): Promise<QueueStats> {
    return { pending: 0, active: 0, completed: 0, failed: 0 };
  }
  async shutdown(): Promise<void> {}
}

function createTestConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
  };
}

async function postRun(
  app: ReturnType<typeof createForgeApp>,
  body: unknown,
  token?: string
) {
  return app.request("/api/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("run creation tenant authority (R3-ISO-01)", () => {
  let config: ForgeServerConfig;
  let app: ReturnType<typeof createForgeApp>;
  let queue: CapturingRunQueue;

  beforeEach(async () => {
    config = createTestConfig();
    queue = new CapturingRunQueue();
    config.runQueue = queue;
    config.runExecutor = async () => ({ content: "ok" });
    config.auth = { mode: "api-key" };
    config.apiKeyStore = makeApiKeyStore({
      "token-1": apiKeyRecord("key-1", "tenant-1"),
    });
    app = createForgeApp(config);
    await config.agentStore.save({
      id: "agent-1",
      name: "Agent One",
      instructions: "test",
      modelTier: "chat",
    });
  });

  it("overwrites a spoofed metadata.tenantId with the authenticated tenant", async () => {
    const res = await postRun(
      app,
      {
        agentId: "agent-1",
        input: { message: "hi" },
        metadata: { tenantId: "victim-tenant", sessionId: "s1" },
      },
      "token-1"
    );
    expect(res.status).toBe(202);

    expect(queue.enqueued).toHaveLength(1);
    const job = queue.enqueued[0]!;
    expect(job.metadata?.["tenantId"]).toBe("tenant-1");

    const { id } = ((await res.json()) as { data: { id: string } }).data;
    const run = await config.runStore.get(id);
    expect(run?.tenantId).toBe("tenant-1");
    expect(run?.metadata?.["tenantId"]).toBe("tenant-1");
  });

  it("overwrites a spoofed metadata.ownerId with the authenticated key id", async () => {
    const res = await postRun(
      app,
      {
        agentId: "agent-1",
        input: { message: "hi" },
        metadata: { ownerId: "someone-else" },
      },
      "token-1"
    );
    expect(res.status).toBe(202);

    const job = queue.enqueued[0]!;
    expect(job.metadata?.["ownerId"]).toBe("key-1");
  });

  it("carries the authoritative tenant on the queue job itself", async () => {
    const res = await postRun(
      app,
      {
        agentId: "agent-1",
        input: { message: "hi" },
      },
      "token-1"
    );
    expect(res.status).toBe(202);

    const job = queue.enqueued[0]!;
    expect(job.tenantId).toBe("tenant-1");
  });

  it("preserves caller metadata untouched when auth is disabled (library default)", async () => {
    const bareConfig = createTestConfig();
    const bareQueue = new CapturingRunQueue();
    bareConfig.runQueue = bareQueue;
    bareConfig.runExecutor = async () => ({ content: "ok" });
    const bareApp = createForgeApp(bareConfig);
    await bareConfig.agentStore.save({
      id: "agent-1",
      name: "Agent One",
      instructions: "test",
      modelTier: "chat",
    });

    const res = await postRun(bareApp, {
      agentId: "agent-1",
      input: { message: "hi" },
      metadata: { tenantId: "my-single-tenant" },
    });
    expect([201, 202]).toContain(res.status);
    expect(bareQueue.enqueued[0]!.metadata?.["tenantId"]).toBe(
      "my-single-tenant"
    );
  });
});

describe("run creation cross-tenant agent execution (R3-ISO-02)", () => {
  let config: ForgeServerConfig;
  let app: ReturnType<typeof createForgeApp>;

  beforeEach(async () => {
    config = createTestConfig();
    config.runQueue = new CapturingRunQueue();
    config.runExecutor = async () => ({ content: "ok" });
    config.auth = { mode: "api-key" };
    config.apiKeyStore = makeApiKeyStore({
      "token-1": apiKeyRecord("key-1", "tenant-1"),
    });
    app = createForgeApp(config);
    await config.agentStore.save({
      id: "agent-own",
      name: "Own Agent",
      instructions: "test",
      modelTier: "chat",
      tenantId: "tenant-1",
    });
    await config.agentStore.save({
      id: "agent-foreign",
      name: "Foreign Agent",
      instructions: "test",
      modelTier: "chat",
      tenantId: "tenant-2",
    });
    await config.agentStore.save({
      id: "agent-legacy",
      name: "Legacy Agent",
      instructions: "test",
      modelTier: "chat",
    });
  });

  it("rejects executing another tenant's agent with 404", async () => {
    const res = await postRun(
      app,
      {
        agentId: "agent-foreign",
        input: { message: "hi" },
      },
      "token-1"
    );
    expect(res.status).toBe(404);
  });

  it("allows executing an agent in the same tenant", async () => {
    const res = await postRun(
      app,
      {
        agentId: "agent-own",
        input: { message: "hi" },
      },
      "token-1"
    );
    expect(res.status).toBe(202);
  });

  it("allows executing a legacy agent with no tenant scope", async () => {
    const res = await postRun(
      app,
      {
        agentId: "agent-legacy",
        input: { message: "hi" },
      },
      "token-1"
    );
    expect(res.status).toBe(202);
  });
});
