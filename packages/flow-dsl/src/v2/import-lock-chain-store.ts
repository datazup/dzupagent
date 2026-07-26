import {
  createV2ImportLockChainEntry,
  type DslV2ImportLockChainEntry,
} from "./import-lock-chain.js";
import type { DslV2ResolvedImportLock } from "./types.js";

/**
 * Persistence for import-lock revision chains (ADR-0001 C2 / L1, open question 4).
 *
 * C2 shipped a producer that emits a chain entry on every lowering, but an
 * entry only carries lineage if something *retains* the previous one — a
 * producer with nothing behind it re-roots at revision 0 every run, which is
 * indistinguishable from having no lineage at all. This is the missing half:
 * the reader that hands the producer its parent, and the writer that keeps the
 * line.
 *
 * The store is deliberately the enforcement point for chain integrity. The
 * producer is a pure function and cannot know what came before; `append` is
 * the only place that sees both the incoming entry and the retained head, so
 * it is the only place a fork can be caught at write time rather than found
 * later by `verifyV2ImportLockChain`.
 *
 * Keyed by flow id: each flow document owns one line of revisions.
 */
export interface V2ImportLockChainStore {
  /** The full retained chain, oldest first. Empty for an unknown flow. */
  read(flowId: string): Promise<readonly DslV2ImportLockChainEntry[]>;

  /**
   * The latest entry, or `undefined` when no chain exists yet.
   *
   * This is the value to pass as the producer's `priorImportLockChainEntry`:
   * `undefined` roots a new chain, which is exactly right for a first run.
   */
  head(flowId: string): Promise<DslV2ImportLockChainEntry | undefined>;

  /**
   * Extend the flow's chain by one entry.
   *
   * Re-appending the current head is an accepted no-op, so a retried or
   * repeated run does not inflate the revision count. Any other entry that
   * does not descend from the head is rejected.
   *
   * @throws if the entry would fork the chain or carries a bad lineage digest.
   */
  append(flowId: string, entry: DslV2ImportLockChainEntry): Promise<void>;
}

/**
 * In-memory {@link V2ImportLockChainStore}.
 *
 * Suitable for testing, development, and single-process runs. Durable
 * lineage across processes needs a persistent implementation of the same
 * interface — the integrity rules live here in `assertExtendsHead` and should
 * be reused rather than re-derived.
 */
export class InMemoryV2ImportLockChainStore implements V2ImportLockChainStore {
  private readonly chains = new Map<string, DslV2ImportLockChainEntry[]>();

  async read(flowId: string): Promise<readonly DslV2ImportLockChainEntry[]> {
    // Frozen copy: a caller must not be able to reach in and edit history.
    return Object.freeze([...(this.chains.get(flowId) ?? [])]);
  }

  async head(flowId: string): Promise<DslV2ImportLockChainEntry | undefined> {
    const chain = this.chains.get(flowId);
    return chain?.[chain.length - 1];
  }

  async append(
    flowId: string,
    entry: DslV2ImportLockChainEntry
  ): Promise<void> {
    const chain = this.chains.get(flowId) ?? [];
    const head = chain[chain.length - 1];

    if (isReplayOfHead(entry, head)) return;

    assertExtendsHead(flowId, entry, head);

    // Mutate only after every check has passed, so a refused append leaves
    // the retained chain exactly as it was.
    this.chains.set(flowId, [...chain, entry]);
  }
}

/**
 * Whether this entry restates the head's *content* and so adds no revision.
 *
 * Compared by `lockSha256`, not `chainSha256`. This is the load-bearing
 * choice: the producer is a pure function of the document, so re-lowering an
 * unchanged flow with the head as its parent yields a well-formed child entry
 * carrying the *same lock* at revision N+1. Keying the check on the lineage
 * digest would accept every one of those, and a flow lowered on each run would
 * accrue thousands of revisions that record no change at all.
 *
 * A revision line exists to record content changes, so an unchanged lock is a
 * no-op regardless of how its lineage digest came out. Note this is a
 * head-only check: a revert that restores earlier content *after* an
 * intervening change has a different lock than the current head, so it is
 * correctly recorded as a new revision rather than collapsed.
 */
function isReplayOfHead(
  entry: DslV2ImportLockChainEntry,
  head: DslV2ImportLockChainEntry | undefined
): boolean {
  return head !== undefined && entry.lockSha256 === head.lockSha256;
}

/**
 * Refuse anything that is not a single-step extension of the retained head.
 *
 * Recomputing the digest rather than trusting it is what makes the store's
 * guarantee independent of the caller: a hand-built or tampered entry cannot
 * be written even if its parent and revision fields look consistent.
 */
function assertExtendsHead(
  flowId: string,
  entry: DslV2ImportLockChainEntry,
  head: DslV2ImportLockChainEntry | undefined
): void {
  if (head === undefined) {
    if (entry.parentLockSha256 !== null || entry.revision !== 0) {
      throw new Error(
        `import-lock chain for '${flowId}' is empty, so the first entry must be a root ` +
          `(parentLockSha256 null, revision 0); got parent ` +
          `${String(entry.parentLockSha256)} at revision ${entry.revision}`
      );
    }
  } else if (entry.parentLockSha256 === null) {
    throw new Error(
      `import-lock chain for '${flowId}' already has a root at revision ${head.revision}; ` +
        `refusing to append a second root entry`
    );
  } else if (entry.parentLockSha256 !== head.lockSha256) {
    throw new Error(
      `import-lock chain entry for '${flowId}' does not extend the stored head: ` +
        `parent ${entry.parentLockSha256} != head ${head.lockSha256}`
    );
  } else if (entry.revision !== head.revision + 1) {
    throw new Error(
      `import-lock chain entry for '${flowId}' must be revision ${
        head.revision + 1
      }, got ${entry.revision}`
    );
  }

  const recomputed = createV2ImportLockChainEntry(
    { lockSha256: entry.lockSha256 } as DslV2ResolvedImportLock,
    head
  );
  if (entry.chainSha256 !== recomputed.chainSha256) {
    throw new Error(
      `import-lock chain entry for '${flowId}' carries a lineage digest that does not ` +
        `match its recomputed value; the entry has been altered or was built against a ` +
        `different history`
    );
  }
}
