import { describe, expect, it } from "vitest";

import { lowerDslV2Document } from "../v2/lower-v2.js";
import {
  createV2ImportLockChainEntry,
  verifyV2ImportLockChain,
} from "../v2/import-lock-chain.js";
import {
  InMemoryV2ImportLockChainStore,
  type V2ImportLockChainStore,
} from "../v2/import-lock-chain-store.js";
import type { DslV2ResolvedImportLock } from "../v2/types.js";

const SOURCE = {
  dsl: "dzupflow/v2",
  version: "2.0.0",
  id: "chain-store-flow",
  inputs: { ready: "boolean" },
  steps: [
    {
      id: "choose",
      use: "core.branch@1",
      when: { ref: "inputs.ready" },
      with: { then: [], else: [] },
    },
  ],
};

function lower(
  options: Parameters<typeof lowerDslV2Document>[1] = {},
): NonNullable<ReturnType<typeof lowerDslV2Document>["metadata"]> {
  const result = lowerDslV2Document(SOURCE, options);
  if (!result.ok || result.metadata === null) {
    throw new Error("lowering rejected a valid v2 document");
  }
  return result.metadata;
}

/** A synthetic lock, for chains that do not need a real lowering. */
function lockOf(hex: string): DslV2ResolvedImportLock {
  return {
    lockSha256: `sha256:${hex.repeat(64).slice(0, 64)}`,
  } as DslV2ResolvedImportLock;
}

describe("v2 import-lock chain store", () => {
  describe("reading an absent chain", () => {
    it("reports an unknown flow as an empty chain rather than throwing", async () => {
      const store = new InMemoryV2ImportLockChainStore();

      expect(await store.read("never-written")).toEqual([]);
      expect(await store.head("never-written")).toBeUndefined();
    });

    it("treats the empty chain as vacuously valid", async () => {
      const store = new InMemoryV2ImportLockChainStore();

      expect(verifyV2ImportLockChain(await store.read("absent"))).toEqual([]);
    });
  });

  describe("appending", () => {
    it("accepts a root entry and returns it as the head", async () => {
      const store = new InMemoryV2ImportLockChainStore();
      const root = createV2ImportLockChainEntry(lockOf("a"));

      await store.append("flow", root);

      expect(await store.head("flow")).toEqual(root);
      expect(await store.read("flow")).toEqual([root]);
    });

    it("extends a line and preserves append order", async () => {
      const store = new InMemoryV2ImportLockChainStore();
      const root = createV2ImportLockChainEntry(lockOf("a"));
      const next = createV2ImportLockChainEntry(lockOf("b"), root);

      await store.append("flow", root);
      await store.append("flow", next);

      expect((await store.read("flow")).map((e) => e.revision)).toEqual([0, 1]);
      expect(await store.head("flow")).toEqual(next);
    });

    it("keeps chains for different flows independent", async () => {
      const store = new InMemoryV2ImportLockChainStore();
      const rootA = createV2ImportLockChainEntry(lockOf("a"));
      const rootB = createV2ImportLockChainEntry(lockOf("b"));

      await store.append("flow-a", rootA);
      await store.append("flow-b", rootB);

      expect(await store.read("flow-a")).toEqual([rootA]);
      expect(await store.read("flow-b")).toEqual([rootB]);
    });
  });

  describe("rejecting a fork", () => {
    it("refuses a second root once a chain exists", async () => {
      const store = new InMemoryV2ImportLockChainStore();
      await store.append("flow", createV2ImportLockChainEntry(lockOf("a")));

      await expect(
        store.append("flow", createV2ImportLockChainEntry(lockOf("b"))),
      ).rejects.toThrow(/root/i);
    });

    it("refuses an entry whose parent is not the current head", async () => {
      const store = new InMemoryV2ImportLockChainStore();
      const root = createV2ImportLockChainEntry(lockOf("a"));
      const sibling = createV2ImportLockChainEntry(lockOf("c"));
      await store.append("flow", root);

      // Built on a *different* root — a genuine fork, not an extension.
      const forked = createV2ImportLockChainEntry(lockOf("b"), sibling);

      await expect(store.append("flow", forked)).rejects.toThrow(/head/i);
    });

    it("refuses an entry with a tampered lineage digest", async () => {
      const store = new InMemoryV2ImportLockChainStore();
      const root = createV2ImportLockChainEntry(lockOf("a"));
      await store.append("flow", root);

      const next = createV2ImportLockChainEntry(lockOf("b"), root);
      const tampered = {
        ...next,
        chainSha256: `sha256:${"0".repeat(64)}`,
      } as typeof next;

      await expect(store.append("flow", tampered)).rejects.toThrow(/digest/i);
    });

    it("leaves the stored chain untouched when an append is refused", async () => {
      const store = new InMemoryV2ImportLockChainStore();
      const root = createV2ImportLockChainEntry(lockOf("a"));
      await store.append("flow", root);

      await expect(
        store.append("flow", createV2ImportLockChainEntry(lockOf("b"))),
      ).rejects.toThrow();

      expect(await store.read("flow")).toEqual([root]);
      expect(await store.head("flow")).toEqual(root);
    });
  });

  describe("idempotent re-append", () => {
    it("accepts re-appending the current head as a no-op", async () => {
      const store = new InMemoryV2ImportLockChainStore();
      const root = createV2ImportLockChainEntry(lockOf("a"));

      await store.append("flow", root);
      await store.append("flow", root);

      // A retried run must not double-count as two revisions.
      expect(await store.read("flow")).toEqual([root]);
    });

    it("does not treat a recurring lock at a new position as a replay", async () => {
      // A revert restores earlier *content*; that is a new revision, not a
      // no-op, because its lineage digest differs.
      const store = new InMemoryV2ImportLockChainStore();
      const root = createV2ImportLockChainEntry(lockOf("a"));
      const changed = createV2ImportLockChainEntry(lockOf("b"), root);
      const reverted = createV2ImportLockChainEntry(lockOf("a"), changed);

      await store.append("flow", root);
      await store.append("flow", changed);
      await store.append("flow", reverted);

      expect((await store.read("flow")).map((e) => e.revision)).toEqual([
        0, 1, 2,
      ]);
    });
  });

  describe("round trip with the producer", () => {
    it("persists lineage across runs so a later run extends it", async () => {
      const store = new InMemoryV2ImportLockChainStore();

      // Run 1: nothing stored yet, so lowering roots a chain.
      const firstPrior = await store.head(SOURCE.id);
      const first = lower({ priorImportLockChainEntry: firstPrior });
      await store.append(SOURCE.id, first.importLockChainEntry);

      // Run 2: the store supplies the prior entry the producer needs.
      const secondPrior = await store.head(SOURCE.id);
      const second = lower({ priorImportLockChainEntry: secondPrior });
      await store.append(SOURCE.id, second.importLockChainEntry);

      // Identical document ⇒ identical lock ⇒ the second run is a replay of
      // the head, so the chain stays at one revision.
      expect(await store.read(SOURCE.id)).toEqual([first.importLockChainEntry]);
    });

    it("yields a stored chain that verifies end to end", async () => {
      const store = new InMemoryV2ImportLockChainStore();
      const root = createV2ImportLockChainEntry(lockOf("a"));
      const next = createV2ImportLockChainEntry(lockOf("b"), root);
      const third = createV2ImportLockChainEntry(lockOf("c"), next);

      await store.append("flow", root);
      await store.append("flow", next);
      await store.append("flow", third);

      expect(verifyV2ImportLockChain(await store.read("flow"))).toEqual([]);
    });
  });

  describe("store contract", () => {
    it("returns a snapshot that cannot mutate stored state", async () => {
      const store = new InMemoryV2ImportLockChainStore();
      const root = createV2ImportLockChainEntry(lockOf("a"));
      await store.append("flow", root);

      const snapshot = await store.read("flow");
      expect(() => {
        (snapshot as unknown as unknown[]).push({});
      }).toThrow();
      expect(await store.read("flow")).toEqual([root]);
    });

    it("is usable through the interface alone", async () => {
      const store: V2ImportLockChainStore =
        new InMemoryV2ImportLockChainStore();
      const root = createV2ImportLockChainEntry(lockOf("a"));

      await store.append("flow", root);

      expect(await store.head("flow")).toEqual(root);
    });
  });
});
