import { describe, expect, it } from "vitest";

import {
  createV2ImportLockChainEntry,
  verifyV2ImportLockChain,
  type DslV2ImportLockChainEntry,
} from "../v2/import-lock-chain.js";
import {
  DurableV2ImportLockChainStore,
  type V2ImportLockChainBackend,
} from "../v2/import-lock-chain-store.js";
import type { DslV2ResolvedImportLock } from "../v2/types.js";

/** A synthetic lock, for chains that do not need a real lowering. */
function lockOf(hex: string): DslV2ResolvedImportLock {
  return {
    lockSha256: `sha256:${hex.repeat(64).slice(0, 64)}`,
  } as DslV2ResolvedImportLock;
}

/**
 * A backend standing in for a real one (a file, a row, an object store).
 *
 * It keeps only opaque strings, which is the point: the store must survive a
 * process boundary carrying nothing but what it wrote here.
 */
class FakeBackend implements V2ImportLockChainBackend {
  readonly documents = new Map<string, string>();
  writes = 0;

  async read(flowId: string): Promise<string | undefined> {
    return this.documents.get(flowId);
  }

  async write(flowId: string, serialized: string): Promise<void> {
    this.writes += 1;
    this.documents.set(flowId, serialized);
  }
}

/**
 * Build a valid chain of `hexes.length` entries, each descending from the last.
 *
 * Returns a tuple type so destructuring yields entries rather than
 * `entry | undefined` — these fixtures are built here, so their presence is a
 * fact about the helper, not something each test should have to re-assert.
 */
function chainOf<const T extends readonly string[]>(
  ...hexes: T
): { [K in keyof T]: DslV2ImportLockChainEntry } {
  const entries: DslV2ImportLockChainEntry[] = [];
  let parent: DslV2ImportLockChainEntry | undefined = undefined;
  for (const hex of hexes) {
    parent = createV2ImportLockChainEntry(lockOf(hex), parent);
    entries.push(parent);
  }
  return entries as { [K in keyof T]: DslV2ImportLockChainEntry };
}

const A = "a";
const B = "b";
const C = "c";

describe("DurableV2ImportLockChainStore", () => {
  it("carries a chain across a process boundary", async () => {
    const backend = new FakeBackend();
    const [root, second] = chainOf(A, B);

    const before = new DurableV2ImportLockChainStore(backend);
    await before.append("flow", root);
    await before.append("flow", second);

    // A brand-new store over the same bytes — nothing shared in memory.
    const after = new DurableV2ImportLockChainStore(backend);

    expect(await after.head("flow")).toEqual(second);
    expect(await after.read("flow")).toEqual([root, second]);
    expect(verifyV2ImportLockChain(await after.read("flow"))).toEqual([]);
  });

  it("keeps enforcing lineage against a head it never saw written", async () => {
    const backend = new FakeBackend();
    const [root, second] = chainOf(A, B);
    await new DurableV2ImportLockChainStore(backend).append("flow", root);

    // The fork is built against a *different* history, so it neither extends
    // the persisted head nor restates it.
    const [forkRoot] = chainOf(C);
    const fork = createV2ImportLockChainEntry(lockOf(B), forkRoot);

    const reopened = new DurableV2ImportLockChainStore(backend);
    await expect(reopened.append("flow", fork)).rejects.toThrow(
      /does not extend the stored head/
    );

    // A refused append must not corrupt what was retained.
    expect(await reopened.read("flow")).toEqual([root]);
    // ...and the legitimate successor still lands.
    await expect(reopened.append("flow", second)).resolves.toBeUndefined();
  });

  it("treats a replayed head as a no-op and writes nothing", async () => {
    const backend = new FakeBackend();
    const [root] = chainOf(A);
    const store = new DurableV2ImportLockChainStore(backend);
    await store.append("flow", root);

    const writesAfterRoot = backend.writes;
    await store.append("flow", root);

    expect(backend.writes).toBe(writesAfterRoot);
    expect(await store.read("flow")).toEqual([root]);
  });

  it("refuses a persisted chain that was tampered with at rest", async () => {
    const backend = new FakeBackend();
    const [root, second] = chainOf(A, B);
    const store = new DurableV2ImportLockChainStore(backend);
    await store.append("flow", root);
    await store.append("flow", second);

    // Edit the stored bytes the way an attacker or a bad merge would.
    const parsed = JSON.parse(backend.documents.get("flow") as string);
    parsed.entries[1].lockSha256 = lockOf(C).lockSha256;
    backend.documents.set("flow", JSON.stringify(parsed));

    const reopened = new DurableV2ImportLockChainStore(backend);
    await expect(reopened.read("flow")).rejects.toThrow(/tampered|integrity/i);
  });

  it("isolates flows from one another", async () => {
    const backend = new FakeBackend();
    const [rootA] = chainOf(A);
    const [rootB] = chainOf(B);
    const store = new DurableV2ImportLockChainStore(backend);

    await store.append("flow-one", rootA);
    await store.append("flow-two", rootB);

    expect(await store.head("flow-one")).toEqual(rootA);
    expect(await store.head("flow-two")).toEqual(rootB);
  });

  it("reports an unknown flow as an empty chain rather than failing", async () => {
    const store = new DurableV2ImportLockChainStore(new FakeBackend());

    expect(await store.read("never-written")).toEqual([]);
    expect(await store.head("never-written")).toBeUndefined();
  });
});
