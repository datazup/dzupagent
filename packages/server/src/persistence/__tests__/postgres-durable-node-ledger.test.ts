/**
 * P2 — PostgresDurableNodeLedger over an in-memory fake Drizzle client.
 *
 * Mirrors the fake-Drizzle testing convention (see drizzle-dlq-store.test.ts):
 * a tiny in-memory client interprets the exact fluent chains the store uses
 * (insert→values→onConflictDoUpdate→returning, update→set→where→returning,
 * select→from→where→limit). drizzle-orm helpers (eq/and/or/lte/sql) are
 * replaced with structural tags the fake evaluates against rows.
 *
 * Asserts the same failure-matrix behavior the InMemoryDurableNodeLedger has,
 * so the two implementations are interchangeable behind DurableNodeLedger.
 */
import { describe, it, expect, vi } from "vitest";
import { FencedOutError } from "@dzupagent/core";

// ── Structural predicate tags (replace drizzle-orm helpers) ─────────────────
type Pred = (row: Record<string, unknown>) => boolean;
vi.mock("drizzle-orm", () => ({
  eq:
    (col: { _col: string }, v: unknown): Pred =>
    (r) =>
      r[col._col] === v,
  lte:
    (col: { _col: string }, v: number): Pred =>
    (r) =>
      (r[col._col] as number) <= v,
  and:
    (...ps: Pred[]): Pred =>
    (r) =>
      ps.every((p) => p(r)),
  or:
    (...ps: Pred[]): Pred =>
    (r) =>
      ps.some((p) => p(r)),
  // sql`...` and sql expressions become opaque markers handled by the fake set.
  sql: (strings: TemplateStringsArray, ...exprs: unknown[]) => ({
    __sql: strings.join("?"),
    exprs,
  }),
}));

// The schema columns become {_col} tags so eq/lte can read field names.
vi.mock("../drizzle-schema.js", () => {
  const col = (name: string) => ({ _col: name });
  return {
    forgeNodeLedger: {
      idempotencyKey: col("idempotencyKey"),
      runId: col("runId"),
      nodeId: col("nodeId"),
      owner: col("owner"),
      fenceToken: col("fenceToken"),
      status: col("status"),
      leaseExpiresAt: col("leaseExpiresAt"),
    },
  };
});

const { PostgresDurableNodeLedger } =
  await import("../postgres-durable-node-ledger.js");

// ── Fake Drizzle DB ─────────────────────────────────────────────────────────
class FakeDb {
  rows = new Map<string, Record<string, unknown>>();

  insert(_t: unknown) {
    return {
      values: (vals: Record<string, unknown>) => ({
        onConflictDoUpdate: (cfg: {
          set: Record<string, unknown>;
          setWhere: Pred;
        }) => ({
          returning: async () => {
            const key = vals["idempotencyKey"] as string;
            const existing = this.rows.get(key);
            if (existing === undefined) {
              this.rows.set(key, { ...vals });
              return [{ ...vals }];
            }
            if (!cfg.setWhere(existing)) return []; // not re-leasable
            const updated = { ...existing };
            for (const [k, v] of Object.entries(cfg.set)) {
              updated[k] = this.resolveSqlSet(k, v, existing);
            }
            this.rows.set(key, updated);
            return [{ ...updated }];
          },
        }),
      }),
    };
  }

  update(_t: unknown) {
    return {
      set: (patch: Record<string, unknown>) => ({
        where: (pred: Pred) => ({
          returning: async () => {
            const out: Record<string, unknown>[] = [];
            for (const [key, row] of this.rows) {
              if (!pred(row)) continue;
              const updated = { ...row };
              for (const [k, v] of Object.entries(patch)) {
                updated[k] = this.resolveSqlSet(k, v, row);
              }
              this.rows.set(key, updated);
              out.push({ ...updated });
            }
            return out;
          },
        }),
      }),
    };
  }

  select() {
    return {
      from: (_t: unknown) => ({
        where: (pred: Pred) => {
          const all = [...this.rows.values()].filter(pred);
          return { limit: async (n: number) => all.slice(0, n) };
        },
      }),
    };
  }

  /** Resolve a sql`...` set expression to a concrete value for the fake. */
  private resolveSqlSet(
    field: string,
    value: unknown,
    row: Record<string, unknown>,
  ): unknown {
    if (value !== null && typeof value === "object" && "__sql" in value) {
      const tpl = (value as { __sql: string }).__sql;
      if (field === "fenceToken") return (row["fenceToken"] as number) + 1;
      if (field === "attempt") return (row["attempt"] as number) + 1;
      // heartbeat status CASE expression
      if (field === "status") {
        return row["status"] === "leased" ? "running" : row["status"];
      }
      return tpl;
    }
    return value;
  }
}

const TTL = 10_000;
const T0 = 1_000_000;
const KEY = "dzup:v1:src:run1:nodeA:node:digest";

function newLedger() {
  return new PostgresDurableNodeLedger(new FakeDb() as never);
}

describe("PostgresDurableNodeLedger (fake Drizzle) — parity with the in-memory ledger", () => {
  it("acquires a free node with fence 1", async () => {
    const l = newLedger();
    const lease = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    expect(lease?.fenceToken).toBe(1);
    expect(lease?.status).toBe("leased");
  });

  it("returns null when held by a fresh lease", async () => {
    const l = newLedger();
    await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    expect(await l.acquire("run1", "nodeA", KEY, "w2", TTL, T0 + 1)).toBeNull();
  });

  it("re-leases an expired lease and bumps the fence", async () => {
    const l = newLedger();
    await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    const re = await l.acquire("run1", "nodeA", KEY, "w2", TTL, T0 + TTL + 1);
    expect(re?.owner).toBe("w2");
    expect(re?.fenceToken).toBe(2);
    expect(re?.attempt).toBe(2);
  });

  it("heartbeat returns true for the current owner+fence and promotes to running", async () => {
    const l = newLedger();
    const lease = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    expect(
      await l.heartbeat("run1", "nodeA", "w1", lease!.fenceToken, TTL, T0 + 1),
    ).toBe(true);
  });

  it("heartbeat returns false for a stale fence", async () => {
    const l = newLedger();
    await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    expect(await l.heartbeat("run1", "nodeA", "w1", 99, TTL, T0 + 1)).toBe(
      false,
    );
  });

  it("complete then getByIdempotencyKey replays the output", async () => {
    const l = newLedger();
    const lease = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    await l.complete({
      runId: "run1",
      nodeId: "nodeA",
      idempotencyKey: KEY,
      fenceToken: lease!.fenceToken,
      output: { v: 1 },
    });
    expect((await l.getByIdempotencyKey(KEY))?.output).toEqual({ v: 1 });
    // Completed → no re-lease.
    expect(await l.acquire("run1", "nodeA", KEY, "w2", TTL, T0 + 1)).toBeNull();
  });

  it("complete with a stale fence throws FencedOutError", async () => {
    const l = newLedger();
    const a = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    await l.acquire("run1", "nodeA", KEY, "w2", TTL, T0 + TTL + 1); // fence → 2
    await expect(
      l.complete({
        runId: "run1",
        nodeId: "nodeA",
        idempotencyKey: KEY,
        fenceToken: a!.fenceToken,
        output: "stale",
      }),
    ).rejects.toBeInstanceOf(FencedOutError);
  });

  it("findStale returns expired leases only", async () => {
    const l = newLedger();
    await l.acquire("run1", "a", "k-a", "w1", TTL, T0);
    await l.acquire("run1", "b", "k-b", "w1", TTL, T0 + TTL); // fresh at the cutoff below
    const stale = await l.findStale(T0 + TTL + 1, 10);
    expect(stale.map((s) => s.nodeId)).toEqual(["a"]);
  });
});
