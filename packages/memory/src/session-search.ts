/**
 * Session Search — lightweight in-memory full-text search over indexed memory records.
 *
 * Supports basic TF-style scoring (matched-terms / total-terms), namespace filtering,
 * limit, minScore filtering, and explicit invalidation. Designed for short-lived
 * session-scoped use; not a replacement for a real search backend.
 *
 * @example
 * ```ts
 * const search = new SessionSearch(memoryService)
 * await search.index('decisions', { tenantId: 't1' })
 * const results = await search.search({ text: 'postgres database' })
 * ```
 */

/** Optional configuration knobs for SessionSearch. */
export interface SessionSearchConfig {
  /** Maximum results to return by default (default: 20) */
  defaultLimit?: number;
  /** Minimum relevance score to include in results (default: 0) */
  minScore?: number;
}

/** Search query parameters. */
export interface SearchQuery {
  /** Free-text query — tokenized on whitespace, case-insensitive. */
  text: string;
  /** Restrict search to specific namespaces (default: all indexed). */
  namespaces?: string[];
  /** Override default result limit. */
  limit?: number;
  /** Override default minimum score threshold. */
  minScore?: number;
}

/** A single search hit with provenance and score. */
export interface SearchResult {
  /** The record's real store key, as written to the store. */
  key: string;
  /** Namespace the record was indexed under. */
  namespace: string;
  /** Scope provided when the namespace was indexed. */
  scope: Record<string, string>;
  /** Original record value. */
  value: Record<string, unknown>;
  /** Relevance score in [0, 1] = matchedTerms / totalQueryTerms. */
  score: number;
  /** Lower-cased query terms that matched the record's text. */
  matchedTerms: string[];
}

/** Backing store contract: just the `get` method we need. */
export interface SessionSearchStore {
  get(
    namespace: string,
    scope: Record<string, string>,
    key?: string
  ): Promise<Record<string, unknown>[]>;
  /**
   * Read records paired with the store key they were written under.
   *
   * Required. `get()` returns bare values, so a record's real key is not
   * recoverable from it; the fallback this replaces read `value['key']`, which
   * against a real store is absent, leaving every `SearchResult.key`
   * undefined. "Optional for backward compatibility" is what let a store
   * without it type-check into the silently-keyless path.
   */
  getKeyed(
    namespace: string,
    scope: Record<string, string>
  ): Promise<Array<{ key: string; value: Record<string, unknown> }>>;
}

interface IndexedRecord {
  namespace: string;
  scope: Record<string, string>;
  value: Record<string, unknown>;
  /** Real store key. Always present — the store's keyed read is required. */
  key: string;
}

export class SessionSearch {
  private indexMap = new Map<string, IndexedRecord[]>();
  private readonly config: Required<SessionSearchConfig>;

  constructor(
    private readonly store: SessionSearchStore,
    config?: SessionSearchConfig
  ) {
    this.config = {
      defaultLimit: config?.defaultLimit ?? 20,
      minScore: config?.minScore ?? 0,
    };
  }

  /** Index all records from a namespace+scope into the search index. */
  async index(namespace: string, scope: Record<string, string>): Promise<void> {
    const keyed = await this.store.getKeyed(namespace, scope);
    this.indexMap.set(
      namespace,
      keyed.map((k) => ({ namespace, scope, value: k.value, key: k.key }))
    );
  }

  /** Search across indexed records using simple token-presence scoring. */
  async search(query: SearchQuery): Promise<SearchResult[]> {
    if (!query.text || !query.text.trim()) return [];

    const terms = tokenize(query.text);
    if (terms.length === 0) return [];

    const namespacesToSearch = query.namespaces ?? [...this.indexMap.keys()];

    const results: SearchResult[] = [];
    for (const ns of namespacesToSearch) {
      const records = this.indexMap.get(ns) ?? [];
      for (const record of records) {
        const text = extractText(record.value).toLowerCase();
        const matchedTerms = terms.filter((t) => text.includes(t));
        if (matchedTerms.length === 0) continue;
        const score = matchedTerms.length / terms.length;
        results.push({
          key: record.key,
          namespace: ns,
          scope: record.scope,
          value: record.value,
          score,
          matchedTerms,
        });
      }
    }

    const minScore = query.minScore ?? this.config.minScore;
    const limit = query.limit ?? this.config.defaultLimit;

    return results
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Invalidate index for a namespace (or all if not specified). */
  invalidate(namespace?: string): void {
    if (namespace) {
      this.indexMap.delete(namespace);
    } else {
      this.indexMap.clear();
    }
  }

  /** Number of indexed records across all namespaces. */
  get indexedCount(): number {
    let count = 0;
    for (const records of this.indexMap.values()) count += records.length;
    return count;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function extractText(record: Record<string, unknown>): string {
  return Object.values(record)
    .filter((v) => typeof v === "string")
    .join(" ");
}
