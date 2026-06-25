/**
 * Unit tests for PostgresAuditStore (MC-1 / AGENT-H-02 durable audit-log
 * integrity).
 *
 * These tests use a hand-rolled in-memory fake of the Drizzle PostgresJsDatabase
 * fluent API so they run without a real database. The fake models the two
 * properties MC-1 cares about:
 *
 *  - Fix 1 (level-triggered flush): when more than `batchSize` entries are
 *    appended at once, every append must still resolve and the queue must drain
 *    fully (no strand).
 *  - Fix 2/3 (transactional hash chain + unique seq): the read+insert run inside
 *    `db.transaction(...)`, the select takes a `FOR UPDATE` lock, and inserting a
 *    duplicate `seq` is rejected (mirrors the `dzupagent_audit_log_seq_unique`
 *    constraint). Two concurrent stores must serialize and produce a valid,
 *    monotonic, unique-seq chain.
 */
import { describe, it, expect } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { PostgresAuditStore } from "../postgres-audit-store.js";
import type { ComplianceAuditEntry } from "@dzupagent/core/security";

// ---------------------------------------------------------------------------
// Shared in-memory audit_log table with a unique-seq constraint and a
// transaction lock, shared across multiple store instances to simulate
// concurrent processes pointed at the same database.
// ---------------------------------------------------------------------------

interface StoredRow {
  id: string;
  seq: number;
  ts: Date;
  actorId: string;
  actorType: string;
  actorName: string | null;
  action: string;
  resource: string | null;
  result: string;
  details: Record<string, unknown>;
  previousHash: string;
  hash: string;
  traceId: string | null;
  spanId: string | null;
}

class FakeAuditDb {
  rows: StoredRow[] = [];
  /** Simple async mutex emulating the FOR UPDATE serialization point. */
  private txChain: Promise<unknown> = Promise.resolve();

  // -- query surface used by PostgresAuditStore --------------------------------

  select(_cols?: unknown): FakeSelect {
    return new FakeSelect(this);
  }

  insert(_table: unknown): FakeInsert {
    return new FakeInsert(this);
  }

  /**
   * Serializes transactions: each call waits for the previous transaction to
   * settle before running, mirroring how a `FOR UPDATE` lock on the tail row
   * forces concurrent flushers to run one-at-a-time.
   */
  transaction<T>(fn: (tx: FakeAuditDb) => Promise<T>): Promise<T> {
    const run = this.txChain.then(() => fn(this));
    // keep the chain alive regardless of success/failure
    this.txChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // -- internal mutation guarded by the unique constraint ----------------------

  insertRows(newRows: StoredRow[]): void {
    for (const r of newRows) {
      if (this.rows.some((existing) => existing.seq === r.seq)) {
        throw new Error(
          `duplicate key value violates unique constraint "dzupagent_audit_log_seq_unique" (seq=${r.seq})`
        );
      }
    }
    this.rows.push(...newRows);
  }
}

/**
 * Drizzle's asc()/desc() embed a `{ value: [' asc'] }` / `{ value: [' desc'] }`
 * chunk in their `queryChunks`. The order object is circular (column → table →
 * columns) so JSON.stringify is unusable; we read the chunks directly. Returns
 * true for a descending order, which is the tail read in doFlush.
 */
function isDescOrder(order: unknown): boolean {
  const chunks = (order as { queryChunks?: unknown[] } | undefined)
    ?.queryChunks;
  if (!Array.isArray(chunks)) return false;
  for (const chunk of chunks) {
    const value = (chunk as { value?: unknown } | undefined)?.value;
    if (Array.isArray(value) && /desc/i.test(value.join(""))) return true;
  }
  return false;
}

class FakeSelect {
  private ordered: StoredRow[];
  constructor(private db: FakeAuditDb) {
    this.ordered = [...db.rows];
  }
  from(_table: unknown): this {
    this.ordered = [...this.db.rows];
    return this;
  }
  where(): this {
    return this;
  }
  orderBy(order?: unknown): this {
    // The tail read in doFlush uses desc(seq); verifyIntegrity / search /
    // export use asc(seq). Honor the direction so the tail read returns the
    // highest seq (otherwise concurrent flushers re-read seq=1 and collide).
    const desc = isDescOrder(order);
    this.ordered = [...this.db.rows].sort((a, b) =>
      desc ? b.seq - a.seq : a.seq - b.seq
    );
    return this;
  }
  limit(n: number): this {
    this.ordered = this.ordered.slice(0, n);
    return this;
  }
  for(_strength: string): this {
    return this;
  }
  then<TR1 = unknown, TR2 = never>(
    onFulfilled?: ((value: StoredRow[]) => TR1 | PromiseLike<TR1>) | null,
    onRejected?: ((reason: unknown) => TR2 | PromiseLike<TR2>) | null
  ): Promise<TR1 | TR2> {
    // Return full rows; structurally they satisfy both the {seq, hash}
    // projection used by doFlush and the rowToEntry mapping used elsewhere.
    return Promise.resolve([...this.ordered]).then(onFulfilled, onRejected);
  }
}

class FakeInsert {
  constructor(private db: FakeAuditDb) {}
  values(rows: StoredRow[]): Promise<void> {
    return Promise.resolve().then(() => {
      this.db.insertRows(rows);
    });
  }
}

function makeStore(
  db: FakeAuditDb,
  opts: { batchSize?: number; flushIntervalMs?: number } = {}
): PostgresAuditStore {
  return new PostgresAuditStore(
    db as unknown as PostgresJsDatabase<Record<string, never>>,
    opts
  );
}

function baseEntry(
  id: string
): Omit<ComplianceAuditEntry, "seq" | "previousHash" | "hash"> {
  return {
    id,
    timestamp: new Date("2026-06-24T00:00:00.000Z"),
    actor: { id: "actor-1", type: "user", name: "Tester" },
    action: "test.action",
    resource: "res-1",
    result: "success",
    details: { n: id },
    traceId: undefined,
    spanId: undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PostgresAuditStore — MC-1 durable audit-log integrity", () => {
  it("Fix 1: drains a backlog larger than batchSize without stranding (250 @ 100)", async () => {
    const db = new FakeAuditDb();
    const store = makeStore(db, { batchSize: 100, flushIntervalMs: 5 });

    const appends = Array.from({ length: 250 }, (_, i) =>
      store.append(baseEntry(`e-${i}`))
    );
    const results = await Promise.all(appends);

    // all 250 appends resolved
    expect(results).toHaveLength(250);
    // queue fully drained — no strand
    const drained = (store as unknown as { pendingQueue: unknown[] })
      .pendingQueue;
    expect(drained).toHaveLength(0);
    // all rows persisted
    expect(db.rows).toHaveLength(250);

    // seqs are unique + monotonic 1..250
    const seqs = [...db.rows].map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));

    const integrity = await store.verifyIntegrity();
    expect(integrity.valid).toBe(true);
    expect(integrity.totalEntries).toBe(250);
  });

  it("Fix 2/3: two concurrent stores serialize to a valid, unique-seq chain", async () => {
    const db = new FakeAuditDb();
    // Two independent store instances pointed at the same database, as two
    // separate processes would be.
    const storeA = makeStore(db, { batchSize: 50, flushIntervalMs: 5 });
    const storeB = makeStore(db, { batchSize: 50, flushIntervalMs: 5 });

    const appends: Promise<ComplianceAuditEntry>[] = [];
    for (let i = 0; i < 100; i++) {
      appends.push(storeA.append(baseEntry(`a-${i}`)));
      appends.push(storeB.append(baseEntry(`b-${i}`)));
    }
    await Promise.all(appends);

    expect(db.rows).toHaveLength(200);

    // No duplicate seqs (the unique constraint was never violated → both
    // flushers serialized through the transaction lock).
    const seqs = db.rows.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(200);

    // Monotonic 1..200 with no gaps.
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));

    // Hash chain is intact (verifyIntegrity reads from the shared db).
    const integrity = await storeA.verifyIntegrity();
    expect(integrity.valid).toBe(true);
    expect(integrity.totalEntries).toBe(200);
  });

  it("Fix 3: a duplicate-seq insert is rejected by the unique constraint", () => {
    const db = new FakeAuditDb();
    db.insertRows([
      {
        id: "x",
        seq: 1,
        ts: new Date(),
        actorId: "a",
        actorType: "user",
        actorName: null,
        action: "act",
        resource: null,
        result: "success",
        details: {},
        previousHash: "",
        hash: "h",
        traceId: null,
        spanId: null,
      },
    ]);
    expect(() =>
      db.insertRows([
        {
          id: "y",
          seq: 1,
          ts: new Date(),
          actorId: "a",
          actorType: "user",
          actorName: null,
          action: "act",
          resource: null,
          result: "success",
          details: {},
          previousHash: "h",
          hash: "h2",
          traceId: null,
          spanId: null,
        },
      ])
    ).toThrow(/dzupagent_audit_log_seq_unique/);
  });
});
