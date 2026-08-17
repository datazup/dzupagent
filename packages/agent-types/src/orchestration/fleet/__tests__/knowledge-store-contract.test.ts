/**
 * Self-test for the shared KnowledgeStore conformance contract.
 *
 * The contract is now plain data (no vitest at module scope) so it can ship
 * through `@dzupagent/agent-types/fleet-contract`. Refactoring assertions out
 * of a test framework carries one specific hazard: the cases can quietly stop
 * failing. These tests close that hole by running every case against a
 * conforming reference store (all must pass) and then against deliberately
 * broken variants of the same store (the targeted case must fail, and only it).
 */
import { describe, expect, it } from "vitest";
import {
  KnowledgeStoreContractViolation,
  knowledgeStoreContractCases,
} from "../knowledge-store-contract.js";
import type { KnowledgeEnvelope } from "../fleet-types.js";
import type {
  KnowledgeFilter,
  KnowledgeRef,
  KnowledgeStore,
  Unsubscribe,
} from "../knowledge-store.js";
import { KnowledgeCollisionError } from "../knowledge-store.js";

interface ReferenceStoreDefects {
  /** append() returns a ref with no id. */
  refWithoutId?: boolean;
  /** read() returns the oldest version instead of the newest. */
  readReturnsOldest?: boolean;
  /** append() overwrites instead of rejecting a version collision. */
  acceptsCollision?: boolean;
  /** query() ignores the kind filter. */
  queryIgnoresKind?: boolean;
  /** subscribe() registers the handler but never calls it. */
  neverNotifies?: boolean;
}

/**
 * Minimal conforming in-memory KnowledgeStore, plus switches to break exactly
 * one behaviour at a time. Test-only: it never leaves this file.
 */
function makeReferenceStore(defects: ReferenceStoreDefects = {}): KnowledgeStore {
  const entries: Array<{ scope: string; entry: KnowledgeEnvelope }> = [];
  const subscribers: Array<{
    filter: KnowledgeFilter;
    handler: (e: KnowledgeEnvelope) => void;
  }> = [];

  const matches = (
    scope: string,
    entry: KnowledgeEnvelope,
    filter: KnowledgeFilter,
    honourKind: boolean
  ): boolean => {
    if (filter.scope !== undefined && filter.scope !== scope) return false;
    if (honourKind && filter.kind !== undefined && filter.kind !== entry.kind) {
      return false;
    }
    if (filter.key !== undefined && filter.key !== entry.key) return false;
    if (filter.repo !== undefined && filter.repo !== entry.repo) return false;
    return true;
  };

  return {
    async append(scope, entry): Promise<KnowledgeRef> {
      const clash = entries.find(
        (row) =>
          row.scope === scope &&
          row.entry.kind === entry.kind &&
          row.entry.key === entry.key &&
          row.entry.version === entry.version
      );
      if (clash && !defects.acceptsCollision) {
        throw new KnowledgeCollisionError(
          scope,
          entry.kind,
          entry.key,
          entry.version
        );
      }
      entries.push({ scope, entry });
      if (!defects.neverNotifies) {
        for (const sub of subscribers) {
          if (matches(scope, entry, sub.filter, true)) sub.handler(entry);
        }
      }
      return {
        id: defects.refWithoutId ? "" : entry.id,
        version: entry.version,
      };
    },

    async read(scope, kind, key) {
      const live = entries
        .filter(
          (row) =>
            row.scope === scope &&
            row.entry.kind === kind &&
            row.entry.key === key &&
            row.entry.supersededAt === null
        )
        .map((row) => row.entry)
        .sort((a, b) => a.version - b.version);
      const picked = defects.readReturnsOldest
        ? live.at(0)
        : live.at(live.length - 1);
      // The contract's generic read<T> is narrower than KnowledgeEnvelope; this
      // reference store has no per-kind refinement to offer.
      return (picked ?? null) as never;
    },

    async *query(filter) {
      for (const row of entries) {
        if (matches(row.scope, row.entry, filter, !defects.queryIgnoresKind)) {
          yield row.entry;
        }
      }
    },

    subscribe(filter, handler): Unsubscribe {
      const record = { filter, handler };
      subscribers.push(record);
      return () => {
        const at = subscribers.indexOf(record);
        if (at >= 0) subscribers.splice(at, 1);
      };
    },
  };
}

const caseNames = knowledgeStoreContractCases.map((c) => c.name);

async function runCase(
  name: string,
  defects: ReferenceStoreDefects
): Promise<void> {
  const found = knowledgeStoreContractCases.find((c) => c.name === name);
  if (!found) throw new Error(`no contract case named "${name}"`);
  await found.run(async () => makeReferenceStore(defects));
}

describe("knowledgeStoreContractCases", () => {
  it("exposes a non-empty set of uniquely named cases", () => {
    expect(knowledgeStoreContractCases.length).toBeGreaterThan(0);
    expect(new Set(caseNames).size).toBe(caseNames.length);
  });

  it("every case passes against a conforming reference store", async () => {
    for (const contractCase of knowledgeStoreContractCases) {
      await contractCase.run(async () => makeReferenceStore());
    }
  });

  // One row per defect: the named case must fail, and every other case must
  // still pass. That second half is what makes the cases non-redundant — a
  // suite where any defect reddens everything cannot localise a violation.
  const defectRows: Array<[string, keyof ReferenceStoreDefects]> = [
    ["append returns a ref with id and version", "refWithoutId"],
    [
      "read returns the latest non-superseded entry for (kind,key)",
      "readReturnsOldest",
    ],
    ["append rejects on (scope, kind, key, version) collision", "acceptsCollision"],
    ["query yields entries matching kind filter", "queryIgnoresKind"],
    ["subscribe invokes handler for new matching entries", "neverNotifies"],
  ];

  for (const [targetName, defect] of defectRows) {
    it(`detects "${defect}" via the case "${targetName}"`, async () => {
      const defects: ReferenceStoreDefects = { [defect]: true };

      await expect(runCase(targetName, defects)).rejects.toBeInstanceOf(
        KnowledgeStoreContractViolation
      );

      for (const other of caseNames.filter((n) => n !== targetName)) {
        await runCase(other, defects);
      }
    });
  }
});
