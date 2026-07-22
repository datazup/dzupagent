import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackgroundTask } from "../contracts/background-task.js";
import {
  DurableQueueRunner,
  type TaskQueue,
} from "../runner/durable-queue-runner.js";
import {
  createPostgresSubagentSchemaSql,
  PostgresTaskQueue,
  PostgresTaskStore,
  recoverStaleRunningTasks,
  type PostgresQueryClient,
} from "../store/postgres-task-store.js";
import {
  ControllableExecutor,
  flush,
  ManualClock,
  RecordingLogger,
  RecordingEventSink,
} from "./helpers.js";

describe("createPostgresSubagentSchemaSql", () => {
  it("emits DDL for versioned task storage and leased queue claims", () => {
    const ddl = createPostgresSubagentSchemaSql().join("\n");

    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS subagent_tasks");
    expect(ddl).toContain("version integer NOT NULL DEFAULT 1");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS subagent_task_queue");
    expect(ddl).toContain("PRIMARY KEY");
    expect(ddl).toContain("lease_until");
    expect(ddl).toContain(
      "CREATE INDEX IF NOT EXISTS subagent_task_queue_claim_idx"
    );
  });

  it("keeps the packaged migration aligned with the subagent Postgres tables", async () => {
    const migration = await readFile(
      join(process.cwd(), "migrations", "0001_postgres_subagent_tasks.sql"),
      "utf8"
    );

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS subagent_tasks");
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS subagent_task_queue"
    );
    expect(migration).toContain("subagent_task_queue_claim_idx");
  });
});

function task(
  id: string,
  status: BackgroundTask["status"] = "queued"
): BackgroundTask {
  return {
    id,
    parentRunId: "parent",
    spec: { agentId: "inline", input: "work" },
    status,
    createdAt: 1,
    ttlMs: 1_000,
    depth: 0,
  };
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
  readonly sql: string[] = [];

  async query(
    text: string,
    values: readonly unknown[] = []
  ): Promise<{ rows: Record<string, unknown>[] }> {
    this.sql.push(text);
    const normalized = text.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("INSERT INTO subagent_tasks")) {
      const record = values[1] as BackgroundTask;
      this.tasks.set(values[0] as string, {
        ...structuredClone(record),
        version: 1,
      });
      return { rows: [] };
    }

    if (
      normalized.startsWith(
        "SELECT task_json, version FROM subagent_tasks WHERE id ="
      )
    ) {
      const found = this.tasks.get(values[0] as string);
      return {
        rows: found
          ? [{ task_json: structuredClone(found), version: found.version }]
          : [],
      };
    }

    if (
      normalized.startsWith(
        "SELECT task_json, version FROM subagent_tasks WHERE"
      )
    ) {
      const rows = [...this.tasks.values()]
        .filter((record) => {
          const filter = values[0] as {
            parentRunId?: string;
            statuses?: string[];
            endedBefore?: number;
          };
          if (
            filter.parentRunId !== undefined &&
            record.parentRunId !== filter.parentRunId
          ) {
            return false;
          }
          if (filter.statuses && !filter.statuses.includes(record.status)) {
            return false;
          }
          if (
            filter.endedBefore !== undefined &&
            (record.endedAt === undefined ||
              record.endedAt >= filter.endedBefore)
          ) {
            return false;
          }
          return true;
        })
        .map((record) => ({
          task_json: structuredClone(record),
          version: record.version,
        }));
      return { rows };
    }

    if (normalized.startsWith("UPDATE subagent_tasks SET task_json =")) {
      const id = values[0] as string;
      const patch = values[1] as Partial<BackgroundTask>;
      const expectedVersion = values[2] as number | null;
      const expectedStatus = values[3] as BackgroundTask["status"] | null;
      const found = this.tasks.get(id);
      if (!found) return { rows: [] };
      if (expectedVersion !== null && found.version !== expectedVersion)
        return { rows: [] };
      if (expectedStatus !== null && found.status !== expectedStatus)
        return { rows: [] };
      const updated = {
        ...found,
        ...structuredClone(patch),
        version: found.version + 1,
      };
      this.tasks.set(id, updated);
      return {
        rows: [
          { task_json: structuredClone(updated), version: updated.version },
        ],
      };
    }

    if (normalized.startsWith("INSERT INTO subagent_task_queue")) {
      const taskId = values[0] as string;
      if (!this.queue.has(taskId)) {
        this.queue.set(taskId, {
          task_id: taskId,
          enqueued_at: values[1] as number,
          available_at: values[1] as number,
          attempts: 0,
          leased_by: null,
          lease_until: null,
        });
      }
      return { rows: [] };
    }

    if (normalized.startsWith("WITH next_task AS")) {
      const now = values[0] as number;
      const leaseUntil = values[1] as number;
      const workerId = values[2] as string;
      const next = [...this.queue.values()]
        .filter(
          (row) =>
            row.available_at <= now &&
            (row.lease_until === null || row.lease_until <= now)
        )
        .sort((a, b) => a.enqueued_at - b.enqueued_at)[0];
      if (!next) return { rows: [] };
      next.leased_by = workerId;
      next.lease_until = leaseUntil;
      next.attempts += 1;
      return { rows: [structuredClone(next)] };
    }

    if (normalized.startsWith("UPDATE subagent_task_queue SET lease_until =")) {
      const taskId = values[0] as string;
      const leaseUntil = values[1] as number;
      const workerId = values[2] as string;
      const found = this.queue.get(taskId);
      if (found && found.leased_by === workerId) {
        found.lease_until = leaseUntil;
      }
      return { rows: [] };
    }

    if (normalized.startsWith("DELETE FROM subagent_task_queue")) {
      const taskId = values[0] as string;
      const workerId = values[1] as string;
      const found = this.queue.get(taskId);
      if (found?.leased_by === workerId) this.queue.delete(taskId);
      return { rows: [] };
    }

    throw new Error(`Unexpected SQL: ${normalized}`);
  }
}

class OnceThenDuplicateQueue implements TaskQueue {
  private handler: ((taskId: string) => Promise<void>) | undefined;
  constructor(private readonly taskId: string) {}
  async enqueue(): Promise<void> {
    await this.handler?.(this.taskId);
    await this.handler?.(this.taskId);
  }
  consume(handler: (taskId: string) => Promise<void>): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }
}

async function waitForStatus(
  store: PostgresTaskStore,
  id: string,
  status: BackgroundTask["status"]
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await store.get(id))?.status === status) return;
    await flush();
  }
  throw new Error(`Task ${id} did not reach ${status}`);
}

describe("PostgresTaskStore", () => {
  it("patchIfVersion only applies a patch when the stored version still matches", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresTaskStore({ client });
    await store.put(task("cas-task"));

    const loaded = await store.getWithVersion("cas-task");
    expect(loaded?.version).toBe(1);

    await store.patch("cas-task", { status: "running", startedAt: 2 });
    const stale = await store.patchIfVersion("cas-task", loaded!.version, {
      status: "succeeded",
      endedAt: 3,
    });

    expect(stale).toBe(false);
    expect(await store.get("cas-task")).toMatchObject({
      status: "running",
      startedAt: 2,
    });
  });

  it("compare-and-sets status transitions to prevent stale terminal overwrites", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresTaskStore({ client });
    await store.put(task("terminal-race", "running"));

    const won = await store.patchIfStatus("terminal-race", "running", {
      status: "expired",
      endedAt: 10,
    });
    const stale = await store.patchIfStatus("terminal-race", "running", {
      status: "succeeded",
      endedAt: 11,
    });

    expect(won).toBe(true);
    expect(stale).toBe(false);
    expect(await store.get("terminal-race")).toMatchObject({
      status: "expired",
      endedAt: 10,
    });
  });

  it("logs compare-and-set misses for operator visibility", async () => {
    const client = new MemoryPostgresClient();
    const logger = new RecordingLogger();
    const store = new PostgresTaskStore({ client, logger });
    await store.put(task("cas-miss", "running"));

    const applied = await store.patchIfStatus("cas-miss", "queued", {
      status: "succeeded",
    });

    expect(applied).toBe(false);
    expect(logger.at("warn")).toContainEqual(
      expect.objectContaining({
        taskId: "cas-miss",
        code: "TASK_STORE_CAS_MISS",
        expectedStatus: "queued",
      })
    );
  });
});

describe("PostgresTaskQueue", () => {
  it("coalesces duplicate enqueue and claims with FOR UPDATE SKIP LOCKED", async () => {
    const client = new MemoryPostgresClient();
    const logger = new RecordingLogger();
    const queue = new PostgresTaskQueue({
      client,
      workerId: "worker-a",
      clock: () => 100,
      leaseMs: 50,
      autoDrain: false,
      logger,
    });

    await queue.enqueue("queued-once");
    await queue.enqueue("queued-once");
    expect(client.queue.size).toBe(1);

    const handled: string[] = [];
    queue.consume(async (taskId) => {
      handled.push(taskId);
    });
    await queue.drainAvailable();

    expect(handled).toEqual(["queued-once"]);
    expect([...client.sql].join("\n")).toContain("FOR UPDATE SKIP LOCKED");
    expect(client.queue.size).toBe(0);
    expect(logger.at("info")).toContainEqual(
      expect.objectContaining({
        taskId: "queued-once",
        code: "TASK_QUEUE_CLAIMED",
        workerId: "worker-a",
      })
    );
  });

  it("dead-letters a poisoned task after maxAttempts instead of re-claiming it forever", async () => {
    const client = new MemoryPostgresClient();
    const logger = new RecordingLogger();
    const store = new PostgresTaskStore({ client });
    await store.put(task("poison"));

    const maxAttempts = 3;
    let now = 100;
    const queue = new PostgresTaskQueue({
      client,
      workerId: "worker-dlq",
      clock: () => now,
      leaseMs: 10,
      autoDrain: false,
      maxAttempts,
      store,
      logger,
    });
    await queue.enqueue("poison");

    let handled = 0;
    queue.consume(async () => {
      handled += 1;
      throw new Error("always throws");
    });

    // Each drain claims the row (attempts++) then the handler throws. Because
    // the lease lapses (advance the clock past lease_until) the row is
    // re-claimable on the next drain — this is exactly the infinite loop the
    // cap must terminate. Run more drains than the cap to prove it stops.
    for (let i = 0; i < maxAttempts + 4; i++) {
      await queue.drainAvailable();
      now += 1_000; // lapse the lease so the row would be re-claimable
    }

    // The handler ran at most `maxAttempts` times, not forever.
    expect(handled).toBe(maxAttempts);
    // The queue row is gone: no worker can re-claim it.
    expect(client.queue.has("poison")).toBe(false);
    // The backing task is moved to a terminal dead-letter state.
    expect(await store.get("poison")).toMatchObject({
      status: "failed",
      error: "max_attempts_exceeded",
    });
    // A governance event is emitted for operator visibility.
    expect(logger.at("error")).toContainEqual(
      expect.objectContaining({
        taskId: "poison",
        code: "MAX_ATTEMPTS_EXCEEDED",
        workerId: "worker-dlq",
        attempts: maxAttempts,
      })
    );
  });

  it("renews the lease while a long handler runs so a second worker cannot re-claim it", async () => {
    vi.useFakeTimers();
    try {
      const client = new MemoryPostgresClient();
      let now = 1_000;
      const clock = () => now;
      const leaseMs = 30;

      const worker = new PostgresTaskQueue({
        client,
        workerId: "long-worker",
        clock,
        leaseMs,
        autoDrain: false,
      });
      await worker.enqueue("long-task");

      let releaseHandler: (() => void) | undefined;
      const handlerStarted = new Promise<void>((resolveStarted) => {
        worker.consume(async () => {
          resolveStarted();
          await new Promise<void>((release) => {
            releaseHandler = release;
          });
        });
      });

      const drain = worker.drainAvailable();
      await handlerStarted;

      const initialLeaseUntil = client.queue.get("long-task")?.lease_until;
      expect(initialLeaseUntil).toBe(1_000 + leaseMs);

      // Advance real time PAST the original lease window; the heartbeat
      // (interval leaseMs/3 = 10ms) fires and keeps renewing the lease.
      now = 1_000 + leaseMs + 25;
      await vi.advanceTimersByTimeAsync(leaseMs);

      const renewedLeaseUntil = client.queue.get("long-task")?.lease_until;
      expect(renewedLeaseUntil).toBe(now + leaseMs);
      expect(renewedLeaseUntil).toBeGreaterThan(now);

      // A second worker tries to claim at the current time. Because the
      // heartbeat kept lease_until in the future, the row is NOT re-claimable.
      const secondHandled: string[] = [];
      const secondWorker = new PostgresTaskQueue({
        client,
        workerId: "steal-worker",
        clock,
        leaseMs,
        autoDrain: false,
      });
      secondWorker.consume(async (taskId) => {
        secondHandled.push(taskId);
      });
      await secondWorker.drainAvailable();
      expect(secondHandled).toEqual([]);
      expect(client.queue.get("long-task")?.leased_by).toBe("long-worker");

      // Handler completes -> heartbeat stops, ack removes the row.
      releaseHandler?.();
      await drain;
      expect(client.queue.has("long-task")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

const databaseUrl =
  process.env["SUBAGENTS_POSTGRES_TEST_URL"] ??
  process.env["TEST_DATABASE_URL"];
if (!databaseUrl && process.env["RUN_REQUIRED_INTEGRATION"]) {
  throw new Error(
    "SUBAGENTS_POSTGRES_TEST_URL or TEST_DATABASE_URL is required when RUN_REQUIRED_INTEGRATION=1"
  );
}

describe.skipIf(!databaseUrl)(
  "PostgresTaskStore/PostgresTaskQueue integration",
  () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const taskTableName = `subagent_tasks_it_${suffix}`;
    const queueTableName = `subagent_task_queue_it_${suffix}`;
    let client: Client;

    beforeAll(async () => {
      client = new Client({ connectionString: databaseUrl });
      await client.connect();
      for (const statement of createPostgresSubagentSchemaSql({
        taskTableName,
        queueTableName,
      })) {
        await client.query(statement);
      }
    });

    afterAll(async () => {
      await client?.query(`DROP TABLE IF EXISTS ${queueTableName}`);
      await client?.query(`DROP TABLE IF EXISTS ${taskTableName}`);
      await client?.end();
    });

    it("reattaches store and queue state through a real Postgres database", async () => {
      const firstStore = new PostgresTaskStore({
        client,
        tableName: taskTableName,
      });
      const firstQueue = new PostgresTaskQueue({
        client,
        tableName: queueTableName,
        workerId: "producer",
        autoDrain: false,
      });

      await firstStore.put(task("pg-durable-task"));
      await firstQueue.enqueue("pg-durable-task");

      const secondStore = new PostgresTaskStore({
        client,
        tableName: taskTableName,
      });
      const secondQueue = new PostgresTaskQueue({
        client,
        tableName: queueTableName,
        workerId: "worker",
        autoDrain: false,
      });
      const handled: string[] = [];
      secondQueue.consume(async (taskId) => {
        handled.push(taskId);
        await secondStore.patchIfStatus(taskId, "queued", {
          status: "succeeded",
          result: { output: "postgres" },
          endedAt: 100,
        });
      });

      await secondQueue.drainAvailable();

      expect(handled).toEqual(["pg-durable-task"]);
      expect(await secondStore.get("pg-durable-task")).toMatchObject({
        status: "succeeded",
        result: { output: "postgres" },
        endedAt: 100,
      });
    });

    it("lets concurrent workers claim disjoint rows with Postgres leases", async () => {
      const queue = new PostgresTaskQueue({
        client,
        tableName: queueTableName,
        workerId: "producer-2",
        autoDrain: false,
      });
      await queue.enqueue("pg-concurrent-a");
      await queue.enqueue("pg-concurrent-b");

      let releaseFirst: (() => void) | undefined;
      let firstDrain: Promise<void> | undefined;
      const firstStarted = new Promise<void>((resolve) => {
        const firstWorker = new PostgresTaskQueue({
          client,
          tableName: queueTableName,
          workerId: "worker-1",
          leaseMs: 10_000,
          autoDrain: false,
        });
        firstWorker.consume(async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseFirst = release;
          });
        });
        firstDrain = firstWorker.drainAvailable();
      });
      await firstStarted;

      const secondHandled: string[] = [];
      const secondWorker = new PostgresTaskQueue({
        client,
        tableName: queueTableName,
        workerId: "worker-2",
        leaseMs: 10_000,
        autoDrain: false,
      });
      secondWorker.consume(async (taskId) => {
        secondHandled.push(taskId);
      });
      await secondWorker.drainAvailable();
      releaseFirst?.();
      await firstDrain;

      expect(secondHandled).toHaveLength(1);
      expect(["pg-concurrent-a", "pg-concurrent-b"]).toContain(
        secondHandled[0]
      );
    });
  }
);

describe("DurableQueueRunner CAS integration", () => {
  it("does not overwrite a terminal task when duplicate delivery races after running", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresTaskStore({ client });
    const executor = new ControllableExecutor("manual");
    const runner = new DurableQueueRunner({
      store,
      executor,
      events: new RecordingEventSink(),
      clock: new ManualClock(5),
      queue: new OnceThenDuplicateQueue("racy-task"),
      durable: true,
    });

    await store.put(task("racy-task"));
    const start = runner.start("racy-task", new AbortController().signal);
    await waitForStatus(store, "racy-task", "running");
    await store.patchIfStatus("racy-task", "running", {
      status: "expired",
      endedAt: 9,
    });
    executor.complete("racy-task", { output: "late" });
    await start;

    expect(executor.runCalls).toHaveLength(1);
    expect(await store.get("racy-task")).toMatchObject({
      status: "expired",
      endedAt: 9,
    });
    runner.dispose();
  });
});

describe("recoverStaleRunningTasks", () => {
  it("marks lease-expired running tasks failed by policy", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresTaskStore({ client });
    await store.put({
      ...task("stale-running", "running"),
      startedAt: 10,
    });
    await store.put({
      ...task("fresh-running", "running"),
      startedAt: 90,
    });

    const recovered = await recoverStaleRunningTasks({
      store,
      now: 100,
      runningTimeoutMs: 50,
      action: "fail",
    });

    expect(recovered).toEqual(["stale-running"]);
    expect(await store.get("stale-running")).toMatchObject({
      status: "failed",
      error: "stale_running_task_recovered",
      endedAt: 100,
    });
    expect(await store.get("fresh-running")).toMatchObject({
      status: "running",
    });
  });

  it("logs stale-running recovery decisions", async () => {
    const client = new MemoryPostgresClient();
    const logger = new RecordingLogger();
    const store = new PostgresTaskStore({ client });
    await store.put({
      ...task("stale-log", "running"),
      startedAt: 1,
    });

    await recoverStaleRunningTasks({
      store,
      now: 100,
      runningTimeoutMs: 50,
      action: "fail",
      logger,
    });

    expect(logger.at("info")).toContainEqual(
      expect.objectContaining({
        taskId: "stale-log",
        code: "STALE_RUNNING_TASK_RECOVERED",
        action: "fail",
      })
    );
  });
});
