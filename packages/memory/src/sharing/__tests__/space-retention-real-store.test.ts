/**
 * Real-store retention tests.
 *
 * These deliberately avoid a mocked MemoryService. The retention defects these
 * cover (tombstones written under fabricated `record-N` keys, compaction
 * deleting keys that never existed) were invisible to spy-based tests because
 * a spy can only observe *that* `put`/`delete` was called, never the resulting
 * namespace contents. Assert on store state, not on call args or report counts.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@langchain/langgraph";
import { MemoryService } from "../../memory-service.js";
import type { SharedMemorySpace } from "../types.js";
import {
  compactTombstonesForSpace,
  enforceRetentionForSpace,
} from "../space-retention.js";

const SPACE_ID = "sp1";
const NS = `space:${SPACE_ID}`;
const SCOPE = { _space: SPACE_ID };

function makeService(): MemoryService {
  return new MemoryService(new InMemoryStore(), [
    { name: NS, scopeKeys: ["_space"], searchable: false },
  ]);
}

function makeSpace(
  retentionPolicy?: SharedMemorySpace["retentionPolicy"]
): SharedMemorySpace {
  return { id: SPACE_ID, retentionPolicy } as SharedMemorySpace;
}

async function seed(svc: MemoryService, keys: string[]): Promise<void> {
  for (const k of keys) {
    await svc.put(NS, SCOPE, k, {
      text: k,
      createdAt: new Date(2020, 0, 1).toISOString(),
    });
  }
}

const keysIn = async (svc: MemoryService): Promise<string[]> =>
  (await svc.getKeyed(NS, SCOPE)).map((r) => r.key).sort();

describe("enforceRetentionForSpace (real store)", () => {
  it("tombstones the pruned records in place without adding new keys", async () => {
    const svc = makeService();
    await seed(svc, ["alpha", "beta", "gamma"]);

    const result = await enforceRetentionForSpace(svc, makeSpace({ maxRecords: 1 }));

    expect(result.pruned).toBe(2);
    // The namespace must not grow: no fabricated `record-N` entries.
    expect(await keysIn(svc)).toEqual(["alpha", "beta", "gamma"]);

    const keyed = await svc.getKeyed(NS, SCOPE);
    const tombstoned = keyed
      .filter((r) => r.value["_tombstone"] === true)
      .map((r) => r.key)
      .sort();
    expect(tombstoned).toHaveLength(2);
    // The surviving record is a real one, not a tombstone.
    expect(tombstoned).not.toContain("alpha");
  });

  it("is idempotent — repeated passes do not grow the namespace", async () => {
    const svc = makeService();
    await seed(svc, ["alpha", "beta", "gamma"]);
    const space = makeSpace({ maxRecords: 1 });

    await enforceRetentionForSpace(svc, space);
    const afterFirst = await keysIn(svc);
    await enforceRetentionForSpace(svc, space);
    const afterSecond = await keysIn(svc);

    expect(afterSecond).toEqual(afterFirst);
  });
});

describe("compactTombstonesForSpace (real store)", () => {
  it("actually removes the tombstones it reports as compacted", async () => {
    const svc = makeService();
    await seed(svc, ["alpha", "beta", "gamma"]);
    const space = makeSpace({ maxRecords: 1 });

    await enforceRetentionForSpace(svc, space);
    const report = await compactTombstonesForSpace(svc, space, Date.now());

    const remaining = await svc.getKeyed(NS, SCOPE);
    // Reported compactions must match real deletions.
    expect(remaining).toHaveLength(3 - report.tombstonesCompacted);
    // Nothing left behind that was counted as removed.
    expect(remaining.filter((r) => r.value["_tombstone"] === true)).toHaveLength(
      report.tombstonesFound - report.tombstonesCompacted
    );
  });
});
