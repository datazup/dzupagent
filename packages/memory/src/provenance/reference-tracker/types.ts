/**
 * Public type surface for the reference tracker — the (run, entry) citation
 * record shape, query options, and the backend-agnostic ReferenceStore
 * contract shared by every store implementation and the ReferenceTracker
 * facade.
 */

/**
 * Context describing *why* a memory entry was retrieved by a run.
 */
export interface RetrievalContext {
  /** Free-form query string that triggered the retrieval (if any). */
  query?: string | undefined;
  /** Namespace the entry was retrieved from. */
  namespace?: string | undefined;
  /** Rank within the result set (0-based). */
  rank?: number | undefined;
  /** Relevance/similarity score as surfaced by the retriever. */
  score?: number | undefined;
  /** Arbitrary caller-supplied tags (e.g. phase, tool name). */
  tags?: Record<string, string> | undefined;
}

/**
 * A single reference record — one (run, entry) citation event.
 */
export interface ReferenceRecord {
  runId: string;
  memoryEntryId: string;
  /** Unix epoch milliseconds when the entry was cited. */
  retrievedAt: number;
  retrievalContext: RetrievalContext;
}

/**
 * Options for querying reference history.
 */
export interface ReferenceQueryOptions {
  /** Max results to return (default: 100). */
  limit?: number | undefined;
  /** Include only references at/after this epoch ms. */
  sinceMs?: number | undefined;
  /** Include only references at/before this epoch ms. */
  untilMs?: number | undefined;
}

/**
 * Backend-agnostic storage interface for reference tuples.
 * Implementations MUST be safe to call from fire-and-forget contexts.
 */
export interface ReferenceStore {
  /** Record a single citation event. */
  record(record: ReferenceRecord): Promise<void>;
  /** List entries cited by a run (most recent first). */
  listByRun(
    runId: string,
    options?: ReferenceQueryOptions
  ): Promise<ReferenceRecord[]>;
  /** List runs that cited a given entry (most recent first). */
  listByEntry(
    entryId: string,
    options?: ReferenceQueryOptions
  ): Promise<ReferenceRecord[]>;
  /** Clear all records for a run (useful for tests / GDPR). */
  clearRun(runId: string): Promise<void>;
}
