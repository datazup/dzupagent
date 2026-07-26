import { describe, expect, it } from "vitest";

import {
  createV2ImportLockChainEntry,
  verifyV2ImportLockChain,
  type DslV2ImportLockChainEntry,
} from "../v2/import-lock-chain.js";
import type { DslV2ResolvedImportLock } from "../v2/types.js";

const LOCK_A = lock("a");
const LOCK_B = lock("b");
const LOCK_C = lock("c");

function lock(seed: string): DslV2ResolvedImportLock {
  return Object.freeze({
    schema: "dzupagent.dslV2ResolvedImportLock/v1",
    catalogs: Object.freeze({
      primitives: [],
      profiles: [],
      schemas: [],
      fragments: [],
      connectors: [],
      roles: [],
      flows: [],
    }),
    lockSha256: `sha256:${seed.repeat(64).slice(0, 64)}`,
  }) as DslV2ResolvedImportLock;
}

/** Build a well-formed chain of the given locks, each parented to the prior. */
function chainOf(
  ...locks: readonly DslV2ResolvedImportLock[]
): DslV2ImportLockChainEntry[] {
  const entries: DslV2ImportLockChainEntry[] = [];
  for (const current of locks) {
    entries.push(createV2ImportLockChainEntry(current, entries.at(-1)));
  }
  return entries;
}

describe("dslV2ImportLockChain", () => {
  it("roots the first revision at parentLockSha256 null and revision 0", () => {
    const [root] = chainOf(LOCK_A);

    expect(root).toMatchObject({
      schema: "dzupagent.dslV2ImportLockChain/v1",
      lockSha256: LOCK_A.lockSha256,
      parentLockSha256: null,
      revision: 0,
      chainSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(Object.isFrozen(root)).toBe(true);
  });

  it("links each successor to its predecessor and increments the revision", () => {
    const [, second, third] = chainOf(LOCK_A, LOCK_B, LOCK_C);

    expect(second).toMatchObject({
      lockSha256: LOCK_B.lockSha256,
      parentLockSha256: LOCK_A.lockSha256,
      revision: 1,
    });
    expect(third).toMatchObject({
      lockSha256: LOCK_C.lockSha256,
      parentLockSha256: LOCK_B.lockSha256,
      revision: 2,
    });
  });

  it("derives chainSha256 deterministically from the entry, not from wall time", () => {
    const first = chainOf(LOCK_A, LOCK_B);
    const second = chainOf(LOCK_A, LOCK_B);

    expect(first).toEqual(second);
  });

  it("distinguishes identical locks that sit at different chain positions", () => {
    // Same content-addressed lock, different history: the lock digest is equal
    // by design, so only the chain digest can tell the two revisions apart.
    const [root] = chainOf(LOCK_A);
    const [, replayed] = chainOf(LOCK_B, LOCK_A);

    expect(replayed.lockSha256).toBe(root.lockSha256);
    expect(replayed.chainSha256).not.toBe(root.chainSha256);
  });

  it("accepts a well-formed chain", () => {
    expect(verifyV2ImportLockChain(chainOf(LOCK_A, LOCK_B, LOCK_C))).toEqual(
      []
    );
  });

  it("accepts an empty chain", () => {
    expect(verifyV2ImportLockChain([])).toEqual([]);
  });

  it("rejects a chain whose first entry is not a root", () => {
    const [, second] = chainOf(LOCK_A, LOCK_B);

    // A non-root head is defective on every axis at once — parent, revision,
    // and the lineage digest that commits to both — so all three are reported.
    expect(verifyV2ImportLockChain([second])).toContainEqual(
      expect.objectContaining({
        code: "V2_INVALID_IMPORT_LOCK_CHAIN",
        path: "importLockChain[0].parentLockSha256",
      })
    );
  });

  it("detects a broken parent link", () => {
    const [first, , third] = chainOf(LOCK_A, LOCK_B, LOCK_C);

    // Drop the middle revision: third still claims LOCK_B as its parent.
    expect(verifyV2ImportLockChain([first, third])).toContainEqual(
      expect.objectContaining({
        code: "V2_INVALID_IMPORT_LOCK_CHAIN",
        path: "importLockChain[1].parentLockSha256",
      })
    );
  });

  it("detects reordered revisions", () => {
    const [first, second, third] = chainOf(LOCK_A, LOCK_B, LOCK_C);

    expect(verifyV2ImportLockChain([first, third, second])).not.toEqual([]);
  });

  it("detects a non-monotonic revision counter", () => {
    const [first, second] = chainOf(LOCK_A, LOCK_B);
    const forged = Object.freeze({
      ...second,
      revision: 7,
    }) as DslV2ImportLockChainEntry;

    expect(verifyV2ImportLockChain([first, forged])).toContainEqual(
      expect.objectContaining({
        code: "V2_INVALID_IMPORT_LOCK_CHAIN",
        path: "importLockChain[1].revision",
      })
    );
  });

  it("detects a tampered chain digest", () => {
    const [first, second] = chainOf(LOCK_A, LOCK_B);
    const forged = Object.freeze({
      ...second,
      chainSha256: LOCK_C.lockSha256,
    }) as DslV2ImportLockChainEntry;

    expect(verifyV2ImportLockChain([first, forged])).toContainEqual(
      expect.objectContaining({
        code: "V2_INVALID_IMPORT_LOCK_CHAIN",
        path: "importLockChain[1].chainSha256",
      })
    );
  });

  it("detects a fork: two revisions claiming the same parent", () => {
    const [first] = chainOf(LOCK_A);
    const branchB = createV2ImportLockChainEntry(LOCK_B, first);
    const branchC = createV2ImportLockChainEntry(LOCK_C, first);

    expect(verifyV2ImportLockChain([first, branchB, branchC])).not.toEqual([]);
  });
});
