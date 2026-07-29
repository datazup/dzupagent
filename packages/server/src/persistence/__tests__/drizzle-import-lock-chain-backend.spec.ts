/**
 * Tests for the ADR-0001 C2 Drizzle {@link V2ImportLockChainBackend}.
 *
 * Two layers, deliberately:
 *
 *  1. **SQL shape** — a duck-typed mock Drizzle client asserts the statements
 *     actually issued (upsert target, the `createdAt`-preserving `set` clause),
 *     mirroring `DrizzleAdapterMetaStore`'s test pattern.
 *  2. **Contract conformance** — an in-memory fake with real last-write-wins
 *     semantics drives the *real* `DurableV2ImportLockChainStore` end to end.
 *     This is the layer that matters for the abstraction claim: the second
 *     backend must satisfy the same store, unmodified, that the filesystem one
 *     does. A mock that only records arguments could never show that.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, it, expect, vi } from "vitest";
import {
  DurableV2ImportLockChainStore,
  createV2ImportLockChainEntry,
  type V2ImportLockChainBackend,
  type DslV2ResolvedImportLock,
} from "@dzupagent/flow-dsl";
import { DrizzleV2ImportLockChainBackend } from "../drizzle-import-lock-chain-backend.js";
import { flowImportLockChains } from "../drizzle-schema.js";
import type { DrizzleStoreDatabase } from "../drizzle-store-types.js";

type Args = Record<string, unknown>;

/** Mock insert→onConflictDoUpdate chain. */
function mockInsert() {
  const onConflictDoUpdate = vi.fn(async (_config: unknown) => undefined);
  const values = vi.fn((_values: Args) => ({ onConflictDoUpdate }));
  const insert = vi.fn((_table: unknown) => ({ values }));
  return { insert, values, onConflictDoUpdate };
}

/** Mock select→from→where chain resolving to `rows`. */
function mockSelect(rows: unknown[]) {
  const where = vi.fn(async (_cond: unknown) => rows);
  const from = vi.fn((_table: unknown) => ({ where }));
  const select = vi.fn((_sel?: unknown) => ({ from }));
  return { select, from, where };
}

/**
 * The digest `lock(seed)` carries.
 *
 * Note the `sha256:` prefix: `DslV2ResolvedImportLock.lockSha256` is typed
 * `` `sha256:${string}` `` and `verifyV2ImportLockChain` enforces it, so a bare
 * hex string is rejected as a malformed entry rather than compared as content.
 */
function digestOf(seed: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

/** Empty catalogs — the chain contract reads only the lock's digest. */
const EMPTY_CATALOGS: DslV2ResolvedImportLock["catalogs"] = {
  primitives: [],
  profiles: [],
  schemas: [],
  fragments: [],
  connectors: [],
  roles: [],
  flows: [],
};

/**
 * A lock is only ever identified by its digest in the chain contract.
 *
 * Deliberately built as a complete `DslV2ResolvedImportLock` rather than cast
 * from a partial: a cast here would suppress exactly the prefix mismatch above,
 * and the failure would surface as an unrelated "tampered at rest" error.
 */
function lock(seed: string): DslV2ResolvedImportLock {
  return {
    schema: "dzupagent.dslV2ResolvedImportLock/v1",
    catalogs: EMPTY_CATALOGS,
    lockSha256: digestOf(seed),
  };
}

describe("DrizzleV2ImportLockChainBackend — SQL shape", () => {
  it("read returns the stored document verbatim", async () => {
    const document = '{"schema":"x","entries":[]}';
    const select = mockSelect([{ flowId: "flow-a", document }]);
    const db = { select: select.select } as unknown as DrizzleStoreDatabase;

    const backend = new DrizzleV2ImportLockChainBackend(db);
    expect(await backend.read("flow-a")).toBe(document);
    expect(select.from).toHaveBeenCalledWith(flowImportLockChains);
  });

  it("read filters on the requested flow id", async () => {
    const select = mockSelect([]);
    const db = { select: select.select } as unknown as DrizzleStoreDatabase;

    await new DrizzleV2ImportLockChainBackend(db).read("flow-a");

    // Without this, a backend that selected on a constant would still pass
    // every round-trip test above while serving one flow's chain for another —
    // silently merging two independent revision lines.
    expect(select.where).toHaveBeenCalledWith(
      eq(flowImportLockChains.flowId, "flow-a")
    );
  });

  it("read returns undefined for a flow with no chain", async () => {
    const select = mockSelect([]);
    const db = { select: select.select } as unknown as DrizzleStoreDatabase;

    const backend = new DrizzleV2ImportLockChainBackend(db);
    // Not null, not a throw: the contract says undefined, and the store reads
    // that as "root a new chain".
    expect(await backend.read("unknown")).toBeUndefined();
  });

  it("write upserts on flow id and preserves createdAt on update", async () => {
    const insert = mockInsert();
    const db = { insert: insert.insert } as unknown as DrizzleStoreDatabase;

    const backend = new DrizzleV2ImportLockChainBackend(db, {
      now: () => 1_700_000_000_000,
    });
    await backend.write("flow-a", "DOC");

    expect(insert.values).toHaveBeenCalledWith({
      flowId: "flow-a",
      document: "DOC",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });

    const config = insert.onConflictDoUpdate.mock.calls[0]?.[0] as {
      target: unknown;
      set: Args;
    };
    expect(config.target).toBe(flowImportLockChains.flowId);
    expect(config.set).toEqual({
      document: "DOC",
      updatedAt: 1_700_000_000_000,
    });
    // The load-bearing assertion: resetting createdAt on every write would
    // erase when the chain was first established.
    expect(config.set).not.toHaveProperty("createdAt");
  });

  it("stores the document byte-for-byte, without re-encoding", async () => {
    const insert = mockInsert();
    const db = { insert: insert.insert } as unknown as DrizzleStoreDatabase;

    // Key order and whitespace must survive: the chain's digests are computed
    // over these exact bytes, which is why the column is text and not jsonb.
    const exact = '{\n  "b": 1,\n  "a": 2\n}';
    await new DrizzleV2ImportLockChainBackend(db).write("f", exact);

    const values = insert.values.mock.calls[0]?.[0] as Args;
    expect(values.document).toBe(exact);
  });
});

/**
 * Last-write-wins fake with real storage semantics — the minimum a backend owes
 * the store. Deliberately not a Drizzle mock: this exercises behavior, not SQL.
 */
class FakeBackend implements V2ImportLockChainBackend {
  readonly documents = new Map<string, string>();
  async read(flowId: string): Promise<string | undefined> {
    return this.documents.get(flowId);
  }
  async write(flowId: string, serialized: string): Promise<void> {
    this.documents.set(flowId, serialized);
  }
}

describe("DurableV2ImportLockChainStore over a SQL-shaped backend", () => {
  it("retains lineage across store instances", async () => {
    const backend = new FakeBackend();

    // Two separate stores over one backend stands in for two processes — the
    // case the whole durable-chain feature exists for.
    const first = new DurableV2ImportLockChainStore(backend);
    const root = createV2ImportLockChainEntry(lock("aaa"), undefined);
    await first.append("flow-a", root);

    const second = new DurableV2ImportLockChainStore(backend);
    const head = await second.head("flow-a");
    expect(head?.lockSha256).toBe(digestOf("aaa"));
    expect(head?.revision).toBe(0);

    const next = createV2ImportLockChainEntry(lock("bbb"), head);
    await second.append("flow-a", next);

    expect(
      await new DurableV2ImportLockChainStore(backend).read("flow-a")
    ).toHaveLength(2);
  });

  it("treats a re-lowered unchanged flow as a no-op", async () => {
    const backend = new FakeBackend();
    const store = new DurableV2ImportLockChainStore(backend);

    const root = createV2ImportLockChainEntry(lock("aaa"), undefined);
    await store.append("flow-a", root);
    const afterFirst = backend.documents.get("flow-a");

    // Same lock, head as parent — a well-formed revision 1 that nonetheless
    // records no content change. It must not extend the chain or churn a write.
    const replay = createV2ImportLockChainEntry(lock("aaa"), root);
    await store.append("flow-a", replay);

    expect(await store.read("flow-a")).toHaveLength(1);
    expect(backend.documents.get("flow-a")).toBe(afterFirst);
  });

  it("refuses an entry that forks the retained chain", async () => {
    const backend = new FakeBackend();
    const store = new DurableV2ImportLockChainStore(backend);

    const root = createV2ImportLockChainEntry(lock("aaa"), undefined);
    await store.append("flow-a", root);
    await store.append(
      "flow-a",
      createV2ImportLockChainEntry(lock("bbb"), root)
    );

    // Descends from the root, not the current head.
    const fork = createV2ImportLockChainEntry(lock("ccc"), root);
    await expect(store.append("flow-a", fork)).rejects.toThrow(
      /does not extend the stored head/
    );
    expect(await store.read("flow-a")).toHaveLength(2);
  });

  it("refuses a chain tampered with at rest", async () => {
    const backend = new FakeBackend();
    const store = new DurableV2ImportLockChainStore(backend);
    await store.append(
      "flow-a",
      createV2ImportLockChainEntry(lock("aaa"), undefined)
    );

    // Edit the persisted bytes the way a text editor or bad merge would. The
    // shape stays valid, so only re-verification catches it — this is the
    // property that distinguishes a durable backend from the in-memory store.
    const stored = backend.documents.get("flow-a") as string;
    // Swap in another *well-formed* digest, so the entry still passes shape
    // validation and only the recomputed lineage can reveal the edit.
    backend.documents.set(
      "flow-a",
      stored.replace(digestOf("aaa"), digestOf("evil"))
    );

    await expect(store.read("flow-a")).rejects.toThrow(/tampered with at rest/);
  });

  it("keeps separate flows on independent chains", async () => {
    const backend = new FakeBackend();
    const store = new DurableV2ImportLockChainStore(backend);

    await store.append(
      "flow-a",
      createV2ImportLockChainEntry(lock("aaa"), undefined)
    );
    await store.append(
      "flow-b",
      createV2ImportLockChainEntry(lock("bbb"), undefined)
    );

    // Both root at revision 0 — one flow's history must not constrain another's.
    expect((await store.head("flow-a"))?.lockSha256).toBe(digestOf("aaa"));
    expect((await store.head("flow-b"))?.lockSha256).toBe(digestOf("bbb"));
  });
});
