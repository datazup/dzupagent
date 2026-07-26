import {
  createV2ImportLockChainEntry,
  verifyV2ImportLockChain,
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
 * Raw persistence for {@link DurableV2ImportLockChainStore}.
 *
 * Deliberately the narrowest surface that can back a chain: opaque strings in,
 * opaque strings out, keyed by flow id. `flow-dsl` has no filesystem, path, or
 * OS imports anywhere in its source and stays that way — a package that reads
 * files cannot run everywhere the DSL is lowered. Keeping the I/O behind this
 * interface leaves the *integrity* rules here, in the one place that already
 * owns them, while the *storage* lives wherever the caller needs it: a file, a
 * database row, an object store, a git note.
 *
 * Implementations only need last-write-wins semantics per flow id. They are
 * not asked to validate anything; the store refuses bad data on the way in and
 * re-checks it on the way out.
 */
export interface V2ImportLockChainBackend {
  /** The stored document for a flow, or `undefined` if it has none yet. */
  read(flowId: string): Promise<string | undefined>;

  /** Replace the stored document for a flow. */
  write(flowId: string, serialized: string): Promise<void>;
}

/** Envelope written by {@link DurableV2ImportLockChainStore}. */
interface PersistedChainDocument {
  readonly schema: typeof PERSISTED_CHAIN_SCHEMA;
  readonly flowId: string;
  readonly entries: readonly DslV2ImportLockChainEntry[];
}

const PERSISTED_CHAIN_SCHEMA = "dzupagent.dslV2ImportLockChainDocument/v1";

/**
 * A {@link V2ImportLockChainStore} whose lineage outlives the process.
 *
 * The in-memory store is enough for a single run, but a chain that starts at
 * revision 0 on every process start records no lineage at all — which is the
 * gap this closes (ADR-0001 C2 / L1, open question 4).
 *
 * Crossing a process boundary changes the threat model, and that drives the
 * two ways this differs from the in-memory store:
 *
 *  - **Reads are verified, not trusted.** In memory, the only way to reach the
 *    retained chain is through `append`, so anything present was already
 *    checked. Persisted bytes can be edited between runs by a text editor, a
 *    bad merge, or an attacker, so `read`/`head` re-run
 *    `verifyV2ImportLockChain` and refuse a chain that no longer verifies
 *    rather than handing back history that only looks valid.
 *  - **The head is re-read per call.** Nothing is cached across operations,
 *    because another process may have appended in between; a cached head would
 *    silently authorize a fork.
 */
export class DurableV2ImportLockChainStore implements V2ImportLockChainStore {
  constructor(private readonly backend: V2ImportLockChainBackend) {}

  async read(flowId: string): Promise<readonly DslV2ImportLockChainEntry[]> {
    return Object.freeze(await this.load(flowId));
  }

  async head(flowId: string): Promise<DslV2ImportLockChainEntry | undefined> {
    const chain = await this.load(flowId);
    return chain[chain.length - 1];
  }

  async append(
    flowId: string,
    entry: DslV2ImportLockChainEntry
  ): Promise<void> {
    const chain = await this.load(flowId);
    const head = chain[chain.length - 1];

    // A replayed head must not write. Beyond saving a round-trip, rewriting
    // identical bytes on every lowering would churn the backend (and any
    // mtime/version/audit trail hanging off it) for a run that changed nothing.
    if (isReplayOfHead(entry, head)) return;

    assertExtendsHead(flowId, entry, head);

    const document: PersistedChainDocument = {
      schema: PERSISTED_CHAIN_SCHEMA,
      flowId,
      entries: [...chain, entry],
    };
    await this.backend.write(flowId, JSON.stringify(document, null, 2));
  }

  /** Parse and re-verify the stored chain; empty for an unknown flow. */
  private async load(flowId: string): Promise<DslV2ImportLockChainEntry[]> {
    const serialized = await this.backend.read(flowId);
    if (serialized === undefined) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (cause) {
      throw new Error(
        `import-lock chain for '${flowId}' is not readable: the stored document is not ` +
          `valid JSON, so its integrity cannot be established`,
        { cause }
      );
    }

    const document = parsed as Partial<PersistedChainDocument>;
    if (document?.schema !== PERSISTED_CHAIN_SCHEMA) {
      throw new Error(
        `import-lock chain for '${flowId}' has an unsupported document schema ` +
          `'${String(document?.schema)}'; expected '${PERSISTED_CHAIN_SCHEMA}'`
      );
    }
    if (!Array.isArray(document.entries)) {
      throw new Error(
        `import-lock chain for '${flowId}' is malformed: 'entries' is not an array`
      );
    }

    // The load-bearing difference from the in-memory store: recompute rather
    // than trust. An entry edited at rest keeps a well-formed shape, so only
    // re-verification catches it.
    const diagnostics = verifyV2ImportLockChain(document.entries);
    if (diagnostics.length > 0) {
      throw new Error(
        `import-lock chain for '${flowId}' failed its integrity check and appears to have ` +
          `been tampered with at rest: ${diagnostics
            .map((diagnostic) => diagnostic.message)
            .join("; ")}`
      );
    }

    return [...document.entries];
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
