/**
 * P2 — Postgres-backed DurableNodeLedger.
 *
 * Durable implementation of `@dzupagent/core` {@link DurableNodeLedger}: the
 * per-node lease + idempotency store survives process restarts so a fleet of
 * workers shares one crash-safe ledger.
 *
 * The load-bearing operation is {@link acquire}, an atomic
 * `INSERT ... ON CONFLICT (idempotency_key) DO UPDATE ... WHERE <re-leasable>`
 * — two workers racing to claim the same node yield exactly one winner, with a
 * monotonically increasing fence token. `complete`/`fail` are fence-gated so a
 * zombie worker's stale write is rejected.
 *
 * Mirrors the Drizzle store conventions in `drizzle-dlq-store.ts` /
 * `postgres-stores.ts`. Typed against `PostgresJsDatabase` because it needs
 * `onConflictDoUpdate` (not in the narrow `DrizzleStoreDatabase`).
 *
 * See workspace-docs/repos/dzupagent/docs/architecture/plans/P2-run-leasing-and-fencing.md
 */
import { and, eq, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  FencedOutError,
  type DurableNodeCompletion,
  type DurableNodeFailure,
  type DurableNodeLease,
  type DurableNodeLedger,
} from "@dzupagent/core";
import { forgeNodeLedger } from "./drizzle-schema.js";

type DB = PostgresJsDatabase<Record<string, never>>;

interface LedgerRow {
  idempotencyKey: string;
  runId: string;
  nodeId: string;
  attempt: number;
  fenceToken: number;
  owner: string;
  status: string;
  leaseExpiresAt: number;
  startedAt: number;
  output: unknown;
}

function rowToLease(row: LedgerRow): DurableNodeLease {
  return {
    runId: row.runId,
    nodeId: row.nodeId,
    idempotencyKey: row.idempotencyKey,
    owner: row.owner,
    fenceToken: row.fenceToken,
    attempt: row.attempt,
    status: row.status as DurableNodeLease["status"],
    leaseExpiresAt: row.leaseExpiresAt,
    startedAt: row.startedAt,
  };
}

export class PostgresDurableNodeLedger implements DurableNodeLedger {
  constructor(private readonly db: DB) {}

  async acquire(
    runId: string,
    nodeId: string,
    idempotencyKey: string,
    owner: string,
    ttlMs: number,
    now: number,
  ): Promise<DurableNodeLease | null> {
    const expiresAt = now + ttlMs;
    // Atomic claim/steal. On a fresh row → insert (fence 1). On conflict →
    // only steal when re-leasable (failed_retryable, or leased/running past
    // expiry); the `setWhere` makes the UPDATE a no-op otherwise, so a
    // completed/held-fresh node returns no row.
    const rows = (await this.db
      .insert(forgeNodeLedger)
      .values({
        idempotencyKey,
        runId,
        nodeId,
        attempt: 1,
        fenceToken: 1,
        owner,
        status: "leased",
        leaseExpiresAt: expiresAt,
        startedAt: now,
      })
      .onConflictDoUpdate({
        target: forgeNodeLedger.idempotencyKey,
        set: {
          owner,
          fenceToken: sql`${forgeNodeLedger.fenceToken} + 1`,
          attempt: sql`${forgeNodeLedger.attempt} + 1`,
          status: "leased",
          leaseExpiresAt: expiresAt,
          startedAt: now,
        },
        setWhere: or(
          eq(forgeNodeLedger.status, "failed_retryable"),
          and(
            or(
              eq(forgeNodeLedger.status, "leased"),
              eq(forgeNodeLedger.status, "running"),
            ),
            lte(forgeNodeLedger.leaseExpiresAt, now),
          ),
        ),
      })
      .returning()) as LedgerRow[];

    const row = rows[0];
    return row === undefined ? null : rowToLease(row);
  }

  async heartbeat(
    runId: string,
    nodeId: string,
    owner: string,
    fenceToken: number,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    // Renew only while THIS owner+fence still holds the lease; promote
    // leased → running. A stale fence / different owner updates nothing.
    const rows = (await this.db
      .update(forgeNodeLedger)
      .set({
        leaseExpiresAt: now + ttlMs,
        status: sql`CASE WHEN ${forgeNodeLedger.status} = 'leased' THEN 'running' ELSE ${forgeNodeLedger.status} END`,
      })
      .where(
        and(
          eq(forgeNodeLedger.runId, runId),
          eq(forgeNodeLedger.nodeId, nodeId),
          eq(forgeNodeLedger.owner, owner),
          eq(forgeNodeLedger.fenceToken, fenceToken),
        ),
      )
      .returning()) as LedgerRow[];
    return rows.length > 0;
  }

  async complete(record: DurableNodeCompletion): Promise<void> {
    await this.fenceGatedWrite(record.idempotencyKey, record.fenceToken, {
      status: "completed",
      completedAt: Date.now(),
      output: record.output ?? null,
      ...(record.outputRef !== undefined
        ? { outputRef: record.outputRef }
        : {}),
      ...(record.durationMs !== undefined
        ? { durationMs: record.durationMs }
        : {}),
    });
  }

  async fail(record: DurableNodeFailure): Promise<void> {
    await this.fenceGatedWrite(record.idempotencyKey, record.fenceToken, {
      status: record.retryable ? "failed_retryable" : "failed_terminal",
      error: record.error,
    });
  }

  async findStale(now: number, limit: number): Promise<DurableNodeLease[]> {
    const rows = (await this.db
      .select()
      .from(forgeNodeLedger)
      .where(
        and(
          or(
            eq(forgeNodeLedger.status, "leased"),
            eq(forgeNodeLedger.status, "running"),
          ),
          lte(forgeNodeLedger.leaseExpiresAt, now),
        ),
      )
      .limit(limit)) as LedgerRow[];
    return rows.map(rowToLease);
  }

  async getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<DurableNodeCompletion | undefined> {
    const rows = (await this.db
      .select()
      .from(forgeNodeLedger)
      .where(eq(forgeNodeLedger.idempotencyKey, idempotencyKey))
      .limit(1)) as LedgerRow[];
    const row = rows[0];
    if (row === undefined || row.status !== "completed") return undefined;
    return {
      runId: row.runId,
      nodeId: row.nodeId,
      idempotencyKey: row.idempotencyKey,
      fenceToken: row.fenceToken,
      output: row.output,
    };
  }

  /**
   * Apply a terminal write only when the caller's fence is current (>= the
   * stored fence). A stale fence touches nothing → we read back the current
   * fence and throw {@link FencedOutError}.
   */
  private async fenceGatedWrite(
    idempotencyKey: string,
    fenceToken: number,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const rows = (await this.db
      .update(forgeNodeLedger)
      .set(patch)
      .where(
        and(
          eq(forgeNodeLedger.idempotencyKey, idempotencyKey),
          lte(forgeNodeLedger.fenceToken, fenceToken),
        ),
      )
      .returning()) as LedgerRow[];
    if (rows.length === 0) {
      const current = (await this.db
        .select()
        .from(forgeNodeLedger)
        .where(eq(forgeNodeLedger.idempotencyKey, idempotencyKey))
        .limit(1)) as LedgerRow[];
      throw new FencedOutError(
        idempotencyKey,
        fenceToken,
        current[0]?.fenceToken ?? -1,
      );
    }
  }
}
