import { describe, it, expect } from "vitest";
import { createEventBus } from "@dzupagent/core/events";
import type { DzupEvent } from "@dzupagent/core/events";
import type { AgentInput } from "@dzupagent/adapter-types";
import type { BackgroundTask, PostgresQueryClient } from "@dzupagent/subagents";
import { allowAllSpawnPolicy } from "@dzupagent/subagents";
import { createWiredSubagentRuntime } from "../create-wired-runtime.js";
import type { ProviderAdapterRegistry } from "../../registry/adapter-registry.js";
import type { AgentDefinition } from "../../dzupagent/agent-loader.js";

function registryWith(
  events: Array<Record<string, unknown>>,
  capture?: (input: AgentInput) => void,
): ProviderAdapterRegistry {
  const adapter = {
    providerId: "claude",
    async *execute(input: AgentInput) {
      capture?.(input);
      for (const e of events) {
        yield e as never;
      }
    },
  };
  return {
    listAdapters: () => ["claude"],
    getHealthy: () => adapter,
    get: () => adapter,
    recordSuccess: () => {},
    recordFailure: () => {},
  } as unknown as ProviderAdapterRegistry;
}

class MemoryPostgresClient implements PostgresQueryClient {
  readonly tasks = new Map<string, BackgroundTask & { version: number }>();
  readonly queue = new Map<
    string,
    {
      task_id: string;
      enqueued_at: number;
      available_at: number;
      attempts: number;
      leased_by: string | null;
      lease_until: number | null;
    }
  >();

  async query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("INSERT INTO wired_subagent_tasks")) {
      const task = values[1] as BackgroundTask;
      this.tasks.set(task.id, { ...structuredClone(task), version: 1 });
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT task_json, version FROM wired_subagent_tasks WHERE id =")) {
      const found = this.tasks.get(values[0] as string);
      return {
        rows: found ? [{ task_json: structuredClone(found), version: found.version }] : [],
      };
    }
    if (normalized.startsWith("SELECT task_json, version FROM wired_subagent_tasks WHERE")) {
      const filter = values[0] as {
        parentRunId?: string;
        statuses?: string[];
        endedBefore?: number;
      };
      return {
        rows: [...this.tasks.values()]
          .filter((task) => {
            if (filter.parentRunId !== undefined && task.parentRunId !== filter.parentRunId) {
              return false;
            }
            if (filter.statuses !== undefined && !filter.statuses.includes(task.status)) {
              return false;
            }
            if (
              filter.endedBefore !== undefined &&
              (task.endedAt === undefined || task.endedAt >= filter.endedBefore)
            ) {
              return false;
            }
            return true;
          })
          .map((task) => ({ task_json: structuredClone(task), version: task.version })),
      };
    }
    if (normalized.startsWith("UPDATE wired_subagent_tasks SET task_json =")) {
      const id = values[0] as string;
      const patch = values[1] as Partial<BackgroundTask>;
      const expectedStatus = values[3] as BackgroundTask["status"] | null;
      const found = this.tasks.get(id);
      if (!found || (expectedStatus !== null && found.status !== expectedStatus)) {
        return { rows: [] };
      }
      const updated = { ...found, ...structuredClone(patch), version: found.version + 1 };
      this.tasks.set(id, updated);
      return { rows: [{ task_json: structuredClone(updated), version: updated.version }] };
    }
    if (normalized.startsWith("INSERT INTO wired_subagent_queue")) {
      const taskId = values[0] as string;
      this.queue.set(taskId, {
        task_id: taskId,
        enqueued_at: values[1] as number,
        available_at: values[1] as number,
        attempts: 0,
        leased_by: null,
        lease_until: null,
      });
      return { rows: [] };
    }
    if (normalized.startsWith("WITH next_task AS")) {
      const task = [...this.queue.values()].find((row) => row.leased_by === null);
      if (!task) return { rows: [] };
      task.leased_by = values[2] as string;
      task.lease_until = values[1] as number;
      task.attempts += 1;
      return { rows: [structuredClone(task)] };
    }
    if (normalized.startsWith("DELETE FROM wired_subagent_queue")) {
      this.queue.delete(values[0] as string);
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }
}

async function waitFor(
  predicate: () => boolean,
  attempts = 100,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("createWiredSubagentRuntime (end-to-end)", () => {
  it("runs a real subagent through the registry and publishes bus events", async () => {
    const bus = createEventBus();
    const seen: DzupEvent[] = [];
    bus.onAny((e: DzupEvent) => seen.push(e));

    const runtime = createWiredSubagentRuntime({
      registry: registryWith([
        { type: "adapter:progress", message: "thinking" },
        {
          type: "adapter:completed",
          result: "the answer",
          usage: { inputTokens: 2, outputTokens: 5 },
        },
      ]),
      eventBus: bus,
      policy: allowAllSpawnPolicy,
    });

    const out = await runtime.spawn(
      { agentId: "claude", input: "question" },
      "run-1",
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("spawn failed");

    const final = await runtime.await(out.taskId, { timeoutMs: 2000 });
    expect(final?.status).toBe("succeeded");
    expect(final?.result).toEqual({
      output: "the answer",
      provider: "claude",
      usage: { inputTokens: 2, outputTokens: 5 },
    });

    // Lifecycle events were bridged onto the framework bus.
    const types = seen.map((e) => e.type);
    expect(types).toContain("subagent:spawned");
    expect(types).toContain("subagent:completed");
  });

  it("persists a checkpoint snapshot when a store is provided", async () => {
    const { InMemoryCheckpointStore } =
      await import("../../session/workflow-checkpointer.js");
    const store = new InMemoryCheckpointStore();
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "ok" }]),
      checkpointStore: store,
      policy: allowAllSpawnPolicy,
    });
    const out = await runtime.spawn({ agentId: "claude", input: "x" }, "r");
    if (!out.ok) throw new Error("spawn failed");
    const final = await runtime.await(out.taskId, { timeoutMs: 2000 });
    expect(final?.status).toBe("succeeded");
  });

  it("can wire the runtime to the Postgres durable queue/store path", async () => {
    const client = new MemoryPostgresClient();
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "postgres-ok" }]),
      policy: allowAllSpawnPolicy,
      postgresDurability: {
        client,
        taskTableName: "wired_subagent_tasks",
        queueTableName: "wired_subagent_queue",
        workerId: "wired-worker",
        staleRunningRecovery: {
          runningTimeoutMs: 1000,
          action: "fail",
        },
      },
    });

    const out = await runtime.spawn({ agentId: "claude", input: "durable" }, "run-pg");
    expect(out).toMatchObject({ ok: true, status: "running" });
    if (!out.ok) throw new Error("spawn failed");

    const final = await runtime.await(out.taskId, { timeoutMs: 2000 });

    expect(final).toMatchObject({
      status: "succeeded",
      result: { output: "postgres-ok" },
    });
    expect(client.queue.size).toBe(0);
    expect(client.tasks.get(out.taskId)).toMatchObject({
      status: "succeeded",
      result: { output: "postgres-ok" },
    });
  });

  it("threads a host logger into the durable Postgres store and queue", async () => {
    const client = new MemoryPostgresClient();
    const logs: Record<string, unknown>[] = [];
    const logger = {
      error: (fields: Record<string, unknown>) => logs.push({ level: "error", ...fields }),
      warn: (fields: Record<string, unknown>) => logs.push({ level: "warn", ...fields }),
      info: (fields: Record<string, unknown>) => logs.push({ level: "info", ...fields }),
      debug: (fields: Record<string, unknown>) => logs.push({ level: "debug", ...fields }),
    };
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "postgres-ok" }]),
      policy: allowAllSpawnPolicy,
      logger,
      postgresDurability: {
        client,
        taskTableName: "wired_subagent_tasks",
        queueTableName: "wired_subagent_queue",
        workerId: "wired-worker",
        staleRunningRecovery: {
          runningTimeoutMs: 1000,
          action: "fail",
        },
      },
    });

    const out = await runtime.spawn({ agentId: "claude", input: "durable" }, "run-pg");
    if (!out.ok) throw new Error("spawn failed");
    await runtime.await(out.taskId, { timeoutMs: 2000 });

    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "info",
        code: "TASK_QUEUE_CLAIMED",
        taskId: out.taskId,
        workerId: "wired-worker",
      }),
    );
  });

  it("denies spawns by default when no policy is supplied (AGENT-L-10)", async () => {
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "ok" }]),
    });
    const out = await runtime.spawn({ agentId: "claude", input: "x" }, "r");
    expect(out).toEqual({
      ok: false,
      reason: "denied",
      detail: "spawn_denied_by_default_policy",
    });
  });

  it("surfaces a denial through the governance policy", async () => {
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "ok" }]),
      policy: { check: () => ({ allow: false, reason: "blocked" }) },
    });
    const out = await runtime.spawn({ agentId: "claude", input: "x" }, "r");
    expect(out).toEqual({ ok: false, reason: "denied", detail: "blocked" });
  });

  it("threads persona options into the registry executor", async () => {
    let seen: AgentInput | undefined;
    const runtime = createWiredSubagentRuntime({
      registry: registryWith(
        [{ type: "adapter:completed", result: "ok" }],
        (input) => {
          seen = input;
        },
      ),
      policy: allowAllSpawnPolicy,
      allowInline: true,
    });

    const out = await runtime.spawn(
      {
        agentId: "inline",
        input: "x",
        definition: {
          name: "inline-reviewer",
          personaPrompt: "Review carefully.",
          preferredProvider: "claude",
        },
      },
      "r",
    );
    if (!out.ok) throw new Error("spawn failed");
    const final = await runtime.await(out.taskId, { timeoutMs: 2000 });

    expect(final?.status).toBe("succeeded");
    expect(seen?.systemPrompt).toBe("Review carefully.");
  });

  it("forces approval before admission for loaded persona constraints", async () => {
    const loader = {
      loadAgent: async () =>
        ({
          name: "security-reviewer",
          description: "",
          version: 1,
          preferredProvider: "claude",
          skillNames: [],
          memoryScope: "project",
          constraints: { approvalMode: "required" },
          personaPrompt: "Review security issues.",
          filePath: "/agents/security-reviewer.md",
        }) satisfies AgentDefinition,
      compileForProvider: async (agent: AgentDefinition) => agent.personaPrompt,
    };
    let resolveApproval: (() => void) | undefined;
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "ok" }]),
      policy: allowAllSpawnPolicy,
      personaLoader: loader,
      approvalGate: {
        waitForApproval: () =>
          new Promise<unknown>((resolve) => {
            resolveApproval = () => resolve(undefined);
          }),
      },
    });

    const out = await runtime.spawn(
      { agentId: "security-reviewer", input: "audit auth" },
      "run-1",
    );

    expect(out).toMatchObject({ ok: true, status: "awaiting_approval" });
    if (!out.ok) throw new Error("spawn failed");
    resolveApproval?.();
    const final = await runtime.await(out.taskId, { timeoutMs: 2000 });
    expect(final?.status).toBe("succeeded");
  });

  it("publishes personaName and inlineDefinitionHash on spawned events", async () => {
    const bus = createEventBus();
    const seen: DzupEvent[] = [];
    bus.onAny((e: DzupEvent) => seen.push(e));
    const loader = {
      loadAgent: async () =>
        ({
          name: "security-reviewer",
          description: "",
          version: 1,
          preferredProvider: "claude",
          skillNames: [],
          memoryScope: "project",
          constraints: {},
          personaPrompt: "Review security issues.",
          filePath: "/agents/security-reviewer.md",
        }) satisfies AgentDefinition,
      compileForProvider: async (agent: AgentDefinition) => agent.personaPrompt,
    };
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "ok" }]),
      eventBus: bus,
      policy: allowAllSpawnPolicy,
      personaLoader: loader,
    });

    const out = await runtime.spawn(
      { agentId: "security-reviewer", input: "audit auth" },
      "run-1",
    );
    if (!out.ok) throw new Error("spawn failed");
    await runtime.await(out.taskId, { timeoutMs: 2000 });

    const spawned = seen.find((event) => event.type === "subagent:spawned");
    expect(spawned).toMatchObject({
      personaName: "security-reviewer",
      inlineDefinitionHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });
});
