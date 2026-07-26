import { describe, expect, it } from "vitest";

import { lowerDslV2Document } from "../v2/lower-v2.js";
import { verifyV2ImportLockChain } from "../v2/import-lock-chain.js";

const SOURCE = {
  dsl: "dzupflow/v2",
  version: "2.0.0",
  id: "chain-producer-flow",
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
  options: Parameters<typeof lowerDslV2Document>[1] = {}
): ReturnType<typeof lowerDslV2Document> {
  return lowerDslV2Document(SOURCE, options);
}

describe("v2 lowering — import-lock chain producer", () => {
  it("roots a chain when no prior entry is supplied", () => {
    const result = lower();

    expect(result.ok).toBe(true);
    if (!result.ok || result.metadata === null) {
      throw new Error("lowering rejected a valid v2 document");
    }
    expect(result.metadata.importLockChainEntry).toMatchObject({
      schema: "dzupagent.dslV2ImportLockChain/v1",
      parentLockSha256: null,
      revision: 0,
    });
  });

  it("pins the chain entry to the lock produced by the same lowering", () => {
    const result = lower();
    if (!result.ok || result.metadata === null)
      throw new Error("lowering failed");

    expect(result.metadata.importLockChainEntry.lockSha256).toBe(
      result.metadata.resolvedImportLock.lockSha256
    );
  });

  it("links to a supplied prior entry and increments the revision", () => {
    const first = lower();
    if (!first.ok || first.metadata === null)
      throw new Error("lowering failed");

    const second = lower({
      priorImportLockChainEntry: first.metadata.importLockChainEntry,
    });
    if (!second.ok || second.metadata === null)
      throw new Error("lowering failed");

    expect(second.metadata.importLockChainEntry).toMatchObject({
      parentLockSha256: first.metadata.importLockChainEntry.lockSha256,
      revision: 1,
    });
  });

  it("produces a chain that verifies end to end", () => {
    const first = lower();
    if (!first.ok || first.metadata === null)
      throw new Error("lowering failed");
    const second = lower({
      priorImportLockChainEntry: first.metadata.importLockChainEntry,
    });
    if (!second.ok || second.metadata === null)
      throw new Error("lowering failed");

    expect(
      verifyV2ImportLockChain([
        first.metadata.importLockChainEntry,
        second.metadata.importLockChainEntry,
      ])
    ).toEqual([]);
  });

  it("keeps the resolved lock itself unchanged by chaining", () => {
    // The whole point of the sibling design: history must not perturb the
    // content-addressed lock.
    const rooted = lower();
    if (!rooted.ok || rooted.metadata === null)
      throw new Error("lowering failed");
    const chained = lower({
      priorImportLockChainEntry: rooted.metadata.importLockChainEntry,
    });
    if (!chained.ok || chained.metadata === null)
      throw new Error("lowering failed");

    expect(chained.metadata.resolvedImportLock).toEqual(
      rooted.metadata.resolvedImportLock
    );
  });

  it("freezes the produced chain entry", () => {
    const result = lower();
    if (!result.ok || result.metadata === null)
      throw new Error("lowering failed");

    expect(Object.isFrozen(result.metadata.importLockChainEntry)).toBe(true);
  });
});
