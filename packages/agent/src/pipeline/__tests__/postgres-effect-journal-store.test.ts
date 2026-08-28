import { describe, expect, it } from "vitest";

import {
  executeEffectOnce,
  materializeEffectIntent,
  materializeEffectReceipt,
  type EffectIntent,
  type EffectReceipt,
} from "@dzupagent/runtime-contracts/effect-receipt";

import {
  PostgresEffectJournalError,
  PostgresEffectJournalStore,
} from "../postgres-effect-journal-store.js";
import type { PostgresClientLike } from "../postgres-checkpoint-store.js";

interface FakeRow {
  idempotency_key: string;
  intent_digest: string;
  status: "pending" | "outcome-unknown" | "committed";
  intent: unknown;
  receipt: unknown | null;
  claimed_at: string;
  observed_at: string | null;
  committed_at: string | null;
}

class FakePostgresClient implements PostgresClientLike {
  readonly rows = new Map<string, FakeRow>();

  async query<T = unknown>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    if (text.includes("effect-journal:setup-")) return { rows: [] };
    if (text.includes("effect-journal:claim")) {
      const key = String(params[0]);
      if (this.rows.has(key)) return { rows: [] };
      const row: FakeRow = {
        idempotency_key: key,
        intent_digest: String(params[1]),
        status: "pending",
        intent: parse(params[2]),
        receipt: null,
        claimed_at: String(params[3]),
        observed_at: null,
        committed_at: null,
      };
      this.rows.set(key, row);
      return { rows: [clone(row) as T] };
    }
    if (text.includes("effect-journal:commit")) {
      const row = this.rows.get(String(params[0]));
      if (
        row === undefined ||
        row.intent_digest !== params[1] ||
        row.status !== "pending"
      ) {
        return { rows: [] };
      }
      row.status = "committed";
      row.receipt = parse(params[2]);
      row.committed_at = String(params[3]);
      row.observed_at = null;
      return { rows: [clone(row) as T] };
    }
    if (text.includes("effect-journal:mark-outcome-unknown")) {
      const row = this.rows.get(String(params[0]));
      if (
        row === undefined ||
        row.intent_digest !== params[1] ||
        row.status !== "pending"
      ) {
        return { rows: [] };
      }
      row.status = "outcome-unknown";
      row.receipt = null;
      row.observed_at = String(params[2]);
      row.committed_at = null;
      return { rows: [clone(row) as T] };
    }
    if (text.includes("effect-journal:load")) {
      const row = this.rows.get(String(params[0]));
      return { rows: row === undefined ? [] : [clone(row) as T] };
    }
    throw new Error(`Unexpected SQL in fake effect journal: ${text}`);
  }

  corruptReceipt(key: string): void {
    const row = this.rows.get(key);
    if (
      row?.status !== "committed" ||
      row.receipt === null ||
      typeof row.receipt !== "object"
    )
      throw new Error("No committed receipt to corrupt");
    row.receipt = { ...row.receipt, resultDigest: `sha256:${"0".repeat(64)}` };
  }
}

const now = "2026-08-14T12:00:00.000Z";
const later = "2026-08-14T12:00:01.000Z";

function intent(key: string, nodeId = "node-1"): EffectIntent {
  return materializeEffectIntent({
    idempotencyKey: key,
    sourceHash: `sha256:${"a".repeat(64)}`,
    runId: "run-1",
    nodeId,
    effectClass: "db_write",
    attemptPolicy: "exactly-once-required",
    operationDigest: `sha256:${"b".repeat(64)}`,
  });
}

function receipt(
  value: EffectIntent,
  result = "committed",
): EffectReceipt<string> {
  return materializeEffectReceipt({
    intent: value,
    result,
    committedAt: later,
  });
}

describe("PostgresEffectJournalStore", () => {
  it("uses a unique claim across concurrent store instances", async () => {
    const client = new FakePostgresClient();
    const left = new PostgresEffectJournalStore<string>({ client });
    const right = new PostgresEffectJournalStore<string>({ client });
    await left.setup();
    const value = intent("effect:concurrent");

    const claims = await Promise.all([
      left.claim(value, now),
      right.claim(value, now),
    ]);

    expect(claims.filter(({ status }) => status === "claimed")).toHaveLength(1);
    expect(claims.filter(({ status }) => status === "existing")).toHaveLength(
      1,
    );
    expect(client.rows).toHaveLength(1);
  });

  it("replays a committed result through a fresh store instance and keeps the empty-key control live", async () => {
    const client = new FakePostgresClient();
    const firstStore = new PostgresEffectJournalStore<string>({ client });
    const value = intent("effect:restart");
    let dispatches = 0;
    const execute = async () => {
      dispatches += 1;
      return "committed";
    };

    await expect(
      executeEffectOnce({
        store: firstStore,
        intent: value,
        execute,
        now: () => now,
      }),
    ).resolves.toMatchObject({ status: "executed" });

    const restartedStore = new PostgresEffectJournalStore<string>({ client });
    await expect(
      executeEffectOnce({
        store: restartedStore,
        intent: value,
        execute,
        now: () => later,
      }),
    ).resolves.toMatchObject({
      status: "replayed",
      receipt: { result: "committed" },
    });
    expect(dispatches).toBe(1);

    await expect(
      executeEffectOnce({
        store: restartedStore,
        intent: intent("effect:empty-control"),
        execute,
        now: () => later,
      }),
    ).resolves.toMatchObject({ status: "executed" });
    expect(dispatches).toBe(2);
  });

  it("blocks pending, outcome-unknown, conflicting, and corrupt records without dispatch", async () => {
    const client = new FakePostgresClient();
    const store = new PostgresEffectJournalStore<string>({ client });
    let dispatches = 0;
    const execute = async () => {
      dispatches += 1;
      return "must-not-run";
    };

    const pending = intent("effect:pending");
    await store.claim(pending, now);
    await expect(
      executeEffectOnce({ store, intent: pending, execute, now: () => later }),
    ).resolves.toEqual({ status: "blocked", reason: "effect-outcome-unknown" });

    await store.markOutcomeUnknown(pending, later);
    await expect(
      executeEffectOnce({ store, intent: pending, execute, now: () => later }),
    ).resolves.toEqual({ status: "blocked", reason: "effect-outcome-unknown" });

    const claimed = intent("effect:conflict");
    await store.claim(claimed, now);
    await expect(
      executeEffectOnce({
        store,
        intent: intent("effect:conflict", "node-other"),
        execute,
        now: () => later,
      }),
    ).resolves.toEqual({ status: "blocked", reason: "idempotency-conflict" });

    const committed = intent("effect:corrupt");
    await store.claim(committed, now);
    await store.commit(committed, receipt(committed));
    client.corruptReceipt(committed.idempotencyKey);
    await expect(
      executeEffectOnce({
        store,
        intent: committed,
        execute,
        now: () => later,
      }),
    ).resolves.toEqual({
      status: "blocked",
      reason: "journal-outcome-unknown",
    });
    expect(dispatches).toBe(0);
  });

  it("enforces compare-and-set transitions and committed-record immutability", async () => {
    const client = new FakePostgresClient();
    const store = new PostgresEffectJournalStore<string>({ client });
    const value = intent("effect:immutable");
    const committed = receipt(value);
    await store.claim(value, now);
    await store.commit(value, committed);
    await expect(store.commit(value, committed)).resolves.toBeUndefined();
    await expect(store.markOutcomeUnknown(value, later)).rejects.toMatchObject({
      name: "PostgresEffectJournalError",
      code: "invalid-transition",
    });
    expect(client.rows.get(value.idempotencyKey)).toMatchObject({
      status: "committed",
      receipt: { receiptDigest: committed.receiptDigest },
    });
  });

  it("hands back stored Date and explicit-undefined values unrewritten (clone semantics)", async () => {
    // Pins the parseJson structuredClone swap (ARCH27-N-15): the old
    // JSON.parse(JSON.stringify(...)) clone silently REWROTE stored values on
    // readback — a Date instance became its ISO string and an
    // explicit-undefined property vanished. Receipt custody's sorted-json
    // canonicalization digests both forms identically, so the rewrite was
    // invisible. structuredClone preserves the stored value exactly, so what
    // custody validated is also what the caller receives.
    const client = new FakePostgresClient();
    const store = new PostgresEffectJournalStore<{ when: string }>({ client });
    await store.setup();
    const value = intent("effect:clone-semantics");
    await store.claim(value, now);
    await store.commit(
      value,
      materializeEffectReceipt({
        intent: value,
        result: { when: later },
        committedAt: later,
      }),
    );

    const row = client.rows.get(value.idempotencyKey);
    if (row === undefined) throw new Error("expected committed row");
    const stored = row.receipt as { result: Record<string, unknown> };

    // A Date rewrite previously round-tripped back to the exact string the
    // digest was computed over, reading back clean; structuredClone hands
    // custody the Date itself, whose canonical form no longer matches the
    // stored digests, so the record fails closed.
    stored.result = { when: new Date(later) };
    await expect(store.claim(value, now)).rejects.toMatchObject({
      code: "record-corrupt",
    });

    // An explicit-undefined property previously VANISHED in the JSON clone.
    // Canonical digesting ignores it either way, so custody still passes —
    // but the caller now receives the stored value as-is, property included.
    stored.result = { when: later, extra: undefined };
    const undefinedClaim = await store.claim(value, now);
    expect(undefinedClaim.status).toBe("existing");
    if (undefinedClaim.status !== "existing") return;
    const undefinedResult = (
      undefinedClaim.record as { receipt: { result: Record<string, unknown> } }
    ).receipt.result;
    expect(Object.hasOwn(undefinedResult, "extra")).toBe(true);
    expect(undefinedResult.extra).toBeUndefined();
  });

  it("rejects unsafe table identifiers before issuing SQL", () => {
    expect(
      () =>
        new PostgresEffectJournalStore({
          client: new FakePostgresClient(),
          tableName: "effect_journal;drop",
        }),
    ).toThrow(PostgresEffectJournalError);
  });
});

function parse(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : clone(value);
}

function clone<T>(value: T): T {
  // structuredClone, not a JSON round-trip: the fake must hand the store
  // exactly what the row holds (including non-JSON values injected by tests),
  // the way a real driver hands over its parsed result.
  return structuredClone(value);
}
