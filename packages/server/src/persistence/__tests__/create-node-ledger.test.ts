/**
 * Unit test for createPostgresNodeLedger factory.
 *
 * Confirms the factory:
 * 1. Accepts a (fake) Drizzle db without throwing.
 * 2. Returns an object that structurally satisfies DurableNodeLedger —
 *    i.e. has the required methods (acquire, heartbeat, complete, fail,
 *    findStale, getByIdempotencyKey).
 *
 * No real Postgres connection required — we pass a typed fake.
 */
import { describe, it, expect, vi } from "vitest";
import type { DurableNodeLedger } from "@dzupagent/core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// ── Mock drizzle-orm + schema so the class can be imported without a real DB ─
vi.mock("drizzle-orm", () => ({
  eq: () => () => false,
  lte: () => () => false,
  and: () => () => false,
  or: () => () => false,
  sql: (strings: TemplateStringsArray) => ({ __sql: strings.join("?") }),
}));

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

const { createPostgresNodeLedger } = await import("../create-node-ledger.js");

// ── Fake DB (never actually called in these tests) ───────────────────────────
const fakeDb = {} as unknown as PostgresJsDatabase<Record<string, never>>;

describe("createPostgresNodeLedger", () => {
  it("returns an object without throwing", () => {
    const ledger = createPostgresNodeLedger(fakeDb);
    expect(ledger).toBeDefined();
  });

  it("implements DurableNodeLedger — has all required methods", () => {
    const ledger = createPostgresNodeLedger(fakeDb);

    // Type-level assertion: assign to the interface to catch missing methods at
    // compile time. If DurableNodeLedger gains a new required method, tsc will
    // flag this line.
    const _typed: DurableNodeLedger = ledger;
    void _typed;

    // Runtime assertion: every method present
    const requiredMethods: Array<keyof DurableNodeLedger> = [
      "acquire",
      "heartbeat",
      "complete",
      "fail",
      "findStale",
      "getByIdempotencyKey",
    ];
    for (const method of requiredMethods) {
      expect(
        typeof ledger[method],
        `DurableNodeLedger.${method} should be a function`
      ).toBe("function");
    }
  });

  it("returns a different instance each call (not a singleton)", () => {
    const a = createPostgresNodeLedger(fakeDb);
    const b = createPostgresNodeLedger(fakeDb);
    expect(a).not.toBe(b);
  });
});
