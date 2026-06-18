/**
 * Unit tests for {@link PostgresRunQueue}.
 *
 * The Drizzle client is mocked with `vi.fn()` — only `db.execute(sql`...`)` is
 * used by this store, so a single `execute` mock drives every code path. We
 * never start the polling interval: tests call the internal `_poll()` directly
 * (or pass `pollIntervalMs: 0`), so the suite is DB-free and deterministic.
 */
import { describe, it, expect, vi } from "vitest";
import { PostgresRunQueue } from "./postgres-run-queue.js";
import type { PostgresRunQueueDatabase } from "./postgres-run-queue.js";

type Row = Record<string, unknown>;

/**
 * Build a mocked Drizzle db whose `execute` returns the next queued result on
 * each call. Each queued entry is either an array of rows (postgres-js shape)
 * or a `{ rows }` object (node-postgres shape) — the queue must handle both.
 */
function mockDb(results: unknown[]) {
  let i = 0;
  const execute = vi.fn(async (_query: unknown) => {
    const next = i < results.length ? results[i] : [];
    i++;
    return next;
  });
  return {
    db: { execute } as unknown as PostgresRunQueueDatabase,
    execute,
  };
}

function jobRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "job_1",
    run_id: "run_1",
    agent_id: "agent_1",
    input: { foo: "bar" },
    metadata: null,
    priority: 0,
    attempts: 1,
    status: "claimed",
    claimed_at: new Date(),
    claimed_by: "worker_1",
    error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/**
 * Flatten a Drizzle `SQL` object (and any nested `sql` fragments) into the
 * static query text, so a test can assert on substrings like `tenant_id =`.
 * Bound parameters are appended as their JS values, which is enough for the
 * structural assertions here.
 */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return String(query);
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && Array.isArray((chunk as { value?: unknown }).value)) {
        return (chunk as { value: unknown[] }).value.join("");
      }
      if (chunk && (chunk as { queryChunks?: unknown }).queryChunks) {
        return sqlText(chunk);
      }
      return "";
    })
    .join("");
}

describe("PostgresRunQueue", () => {
  it("enqueue inserts a pending job row and returns the RunJob", async () => {
    // execute #1 = INSERT ... RETURNING the new row
    const { db, execute } = mockDb([
      [
        jobRow({
          id: "job_new",
          run_id: "run_new",
          agent_id: "agent_new",
          status: "pending",
          attempts: 0,
          claimed_at: null,
          claimed_by: null,
          priority: 5,
        }),
      ],
    ]);
    const queue = new PostgresRunQueue({
      db,
      concurrency: 1,
      jobTimeoutMs: 1000,
    });

    const job = await queue.enqueue({
      runId: "run_new",
      agentId: "agent_new",
      input: { foo: "bar" },
      priority: 5,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(job.runId).toBe("run_new");
    expect(job.agentId).toBe("agent_new");
    expect(job.priority).toBe(5);
    expect(job.attempts).toBe(0);
    expect(typeof job.id).toBe("string");
    expect(job.id.length).toBeGreaterThan(0);

    await queue.stop(false);
  });

  it("_poll claims a pending row and runs the processor, marking it completed", async () => {
    // execute #1 = claim UPDATE ... RETURNING the claimed row
    // execute #2 = mark-completed UPDATE (no rows needed)
    // execute #3+ = subsequent claim polls return empty
    const { db, execute } = mockDb([
      [jobRow({ id: "job_a", run_id: "run_a", agent_id: "agent_a" })],
      [],
      [],
    ]);
    const queue = new PostgresRunQueue({
      db,
      concurrency: 1,
      jobTimeoutMs: 1000,
      // Single-step claim: this test mocks one claim query, not the
      // two-step fair-scheduling tenant-select + claim pair.
      fairScheduling: false,
    });

    const processed: string[] = [];
    queue.start(async (job) => {
      processed.push(job.runId);
    });

    await queue._poll();
    // let the processor promise settle
    await new Promise((r) => setTimeout(r, 0));
    await queue.stop(false);

    expect(processed).toEqual(["run_a"]);
    // First execute is the claim; a later execute marks the row completed.
    expect(execute.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("cancel marks a pending job cancelled and reports whether rows changed", async () => {
    // execute #1 = UPDATE ... WHERE run_id AND status='pending' (1 row)
    // execute #2 = UPDATE ... (0 rows — nothing pending)
    const { db } = mockDb([
      [jobRow({ status: "cancelled" })], // 1 affected
      [], // 0 affected
    ]);
    const queue = new PostgresRunQueue({ db });

    const first = await queue.cancelAsync("run_1");
    const second = await queue.cancelAsync("run_missing");

    expect(first).toBe(true);
    expect(second).toBe(false);

    await queue.stop(false);
  });

  it("stats aggregates counts grouped by status", async () => {
    // execute #1 = SELECT status, count(*) GROUP BY status
    const { db } = mockDb([
      [
        { status: "pending", count: "3" },
        { status: "claimed", count: "2" },
        { status: "completed", count: "10" },
        { status: "failed", count: "1" },
        { status: "cancelled", count: "4" },
      ],
    ]);
    const queue = new PostgresRunQueue({ db });

    const stats = await queue.statsAsync();

    expect(stats).toEqual({
      pending: 3,
      active: 2,
      completed: 10,
      failed: 1,
      deadLetter: 1,
    });

    await queue.stop(false);
  });

  it("getDeadLetter maps failed rows to DeadLetterEntry[]", async () => {
    const failedAt = new Date("2026-01-01T00:00:00Z");
    // execute #1 = SELECT * WHERE status='failed'
    const { db } = mockDb([
      [
        jobRow({
          id: "job_dead",
          run_id: "run_dead",
          status: "failed",
          attempts: 3,
          error: "boom",
          updated_at: failedAt,
        }),
      ],
    ]);
    const queue = new PostgresRunQueue({ db });

    const dead = await queue.getDeadLetterAsync();

    expect(dead).toHaveLength(1);
    expect(dead[0]!.job.runId).toBe("run_dead");
    expect(dead[0]!.error).toBe("boom");
    expect(dead[0]!.attempts).toBe(3);
    expect(dead[0]!.failedAt).toEqual(failedAt);

    await queue.stop(false);
  });

  it("stop halts polling and drains in-flight jobs when waitForActive", async () => {
    // execute #1 = claim a row; everything else empty.
    const { db } = mockDb([
      [jobRow({ id: "job_slow", run_id: "run_slow" })],
      [],
      [],
      [],
    ]);
    const queue = new PostgresRunQueue({
      db,
      concurrency: 1,
      jobTimeoutMs: 5000,
      // Single-step claim: this test mocks one claim query.
      fairScheduling: false,
    });

    let resolveProcessor: (() => void) | undefined;
    const started = new Promise<void>((startResolve) => {
      queue.start(async () => {
        startResolve();
        await new Promise<void>((r) => {
          resolveProcessor = r;
        });
      });
    });

    await queue._poll();
    await started; // processor is now in-flight

    // stop with waitForActive should not resolve until the processor finishes.
    let stopped = false;
    const stopPromise = queue.stop(true).then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);

    resolveProcessor?.();
    await stopPromise;
    expect(stopped).toBe(true);

    // After stop, polling no longer claims work.
    await queue._poll();
  });

  it("enqueue stores tenantId in the row", async () => {
    const { db, execute } = mockDb([
      [
        jobRow({
          id: "job_t",
          run_id: "run_t",
          agent_id: "agent_t",
          status: "pending",
          attempts: 0,
          tenant_id: "tenant-xyz",
        }),
      ],
    ]);
    const queue = new PostgresRunQueue({ db, concurrency: 1 });

    const job = await queue.enqueue({
      runId: "run_t",
      agentId: "agent_t",
      input: { foo: "bar" },
      priority: 0,
      tenantId: "tenant-xyz",
    });

    // The INSERT statement names the tenant_id column and binds the value.
    const insertText = sqlText(execute.mock.calls[0]![0]);
    expect(insertText).toContain("tenant_id");
    expect(insertText).toContain("tenant-xyz");
    expect(job.tenantId).toBe("tenant-xyz");

    await queue.stop(false);
  });

  it("_poll filters by tenantId when config.tenantId is set", async () => {
    const { db, execute } = mockDb([
      [jobRow({ id: "job_a", run_id: "run_a", tenant_id: "tenant-xyz" })],
      [],
      [],
    ]);
    const queue = new PostgresRunQueue({
      db,
      concurrency: 1,
      jobTimeoutMs: 1000,
      tenantId: "tenant-xyz",
    });

    queue.start(async () => {});
    await queue._poll();
    await new Promise((r) => setTimeout(r, 0));
    await queue.stop(false);

    // The claim UPDATE's inner SELECT scopes to the configured tenant.
    const claimText = sqlText(execute.mock.calls[0]![0]);
    expect(claimText).toContain("tenant_id =");
    expect(claimText).toContain("tenant-xyz");
  });

  it("_poll uses two queries (tenant-select then claim) when fairScheduling is on", async () => {
    // execute #1 = least-loaded tenant SELECT -> { tenant_id, pending_count }
    // execute #2 = claim UPDATE ... RETURNING the claimed row
    // execute #3 = mark-completed; #4 = next tenant-select returns empty
    const { db, execute } = mockDb([
      [{ tenant_id: "tenant-quiet", pending_count: "1" }],
      [jobRow({ id: "job_a", run_id: "run_a", tenant_id: "tenant-quiet" })],
      [],
      [],
    ]);
    const queue = new PostgresRunQueue({
      db,
      concurrency: 1,
      jobTimeoutMs: 1000,
      // fairScheduling defaults true when no tenantId is set; set explicitly.
      fairScheduling: true,
    });

    const processed: string[] = [];
    queue.start(async (job) => {
      processed.push(job.runId);
    });
    await queue._poll();
    await new Promise((r) => setTimeout(r, 0));
    await queue.stop(false);

    expect(processed).toEqual(["run_a"]);
    // First query is the tenant-select step; second is the scoped claim.
    const tenantSelectText = sqlText(execute.mock.calls[0]![0]);
    expect(tenantSelectText).toContain("GROUP BY tenant_id");
    expect(tenantSelectText).toContain("pending_count");
    const claimText = sqlText(execute.mock.calls[1]![0]);
    expect(claimText).toContain("UPDATE flow_jobs");
    expect(claimText).toContain("tenant_id =");
    expect(claimText).toContain("tenant-quiet");
  });

  it("_poll uses a single query when fairScheduling is off (shared worker)", async () => {
    // execute #1 = single-step claim UPDATE ... RETURNING the claimed row
    const { db, execute } = mockDb([
      [jobRow({ id: "job_a", run_id: "run_a" })],
      [],
      [],
    ]);
    const queue = new PostgresRunQueue({
      db,
      concurrency: 1,
      jobTimeoutMs: 1000,
      fairScheduling: false,
    });

    queue.start(async () => {});
    await queue._poll();
    await new Promise((r) => setTimeout(r, 0));
    await queue.stop(false);

    // No tenant-select step: the very first query is the claim UPDATE.
    const firstText = sqlText(execute.mock.calls[0]![0]);
    expect(firstText).toContain("UPDATE flow_jobs");
    expect(firstText).not.toContain("GROUP BY tenant_id");
    expect(firstText).toContain("ORDER BY priority ASC, created_at ASC");
  });

  it("_poll uses single-step when config.tenantId is set regardless of fairScheduling", async () => {
    const { db, execute } = mockDb([
      [jobRow({ id: "job_a", run_id: "run_a", tenant_id: "tenant-xyz" })],
      [],
      [],
    ]);
    const queue = new PostgresRunQueue({
      db,
      concurrency: 1,
      jobTimeoutMs: 1000,
      tenantId: "tenant-xyz",
      fairScheduling: true, // ignored because the worker is tenant-scoped
    });

    queue.start(async () => {});
    await queue._poll();
    await new Promise((r) => setTimeout(r, 0));
    await queue.stop(false);

    // First (and only claim) query is the scoped single-step UPDATE, no GROUP BY.
    const firstText = sqlText(execute.mock.calls[0]![0]);
    expect(firstText).toContain("UPDATE flow_jobs");
    expect(firstText).not.toContain("GROUP BY tenant_id");
    expect(firstText).toContain("tenant_id =");
    expect(firstText).toContain("tenant-xyz");
  });
});
