/**
 * CacheBackend-backed (Redis) reference store. Uses sorted sets for the two
 * bidirectional indexes (by run, by entry) and a regular cache value for the
 * per-citation retrieval context. Depends only on the minimal `@dzupagent/cache`
 * CacheBackend contract — never on ioredis directly.
 */

import type { CacheBackend } from "@dzupagent/cache";

import type {
  ReferenceQueryOptions,
  ReferenceRecord,
  ReferenceStore,
  RetrievalContext,
} from "./types.js";

export interface RedisReferenceStoreOptions {
  /** Key prefix (default: 'dz:refs'). */
  prefix?: string;
  /**
   * Optional error sink. Called when backend operations fail. Defaults to a
   * no-op so reference-tracking failures never surface to the caller.
   */
  onError?: (operation: string, err: unknown) => void;
}

/**
 * CacheBackend-backed reference store using sorted sets for the bidirectional
 * indexes and a regular cache value for per-citation retrieval context.
 *
 * Members are encoded as `{id}@{retrievedAt}` so a single sorted-set lookup
 * carries enough information to re-derive the timestamp without WITHSCORES
 * (which is intentionally outside the minimal CacheBackend contract).
 *
 * Pass any `CacheBackend` implementation — typically a `RedisCacheBackend`
 * from `@dzupagent/cache` for production, or `InMemoryCacheBackend` for tests.
 */
export class RedisReferenceStore implements ReferenceStore {
  private readonly cache: CacheBackend;
  private readonly prefix: string;
  private readonly onError: (operation: string, err: unknown) => void;

  constructor(cache: CacheBackend, options?: RedisReferenceStoreOptions) {
    this.cache = cache;
    this.prefix = options?.prefix ?? "dz:refs";
    this.onError =
      options?.onError ??
      (() => {
        /* swallow */
      });
  }

  private runKey(runId: string): string {
    return `${this.prefix}:run:${runId}`;
  }

  private entryKey(entryId: string): string {
    return `${this.prefix}:entry:${entryId}`;
  }

  private ctxKey(runId: string, entryId: string, retrievedAt: number): string {
    return `${this.prefix}:ctx:${runId}:${entryId}@${retrievedAt}`;
  }

  private encodeMember(id: string, retrievedAt: number): string {
    return `${id}@${retrievedAt}`;
  }

  /** Parse `{id}@{ts}` back into its parts; returns null on malformed input. */
  private decodeMember(
    member: string
  ): { id: string; retrievedAt: number } | null {
    const at = member.lastIndexOf("@");
    if (at <= 0 || at === member.length - 1) return null;
    const id = member.slice(0, at);
    const ts = Number(member.slice(at + 1));
    if (!Number.isFinite(ts)) return null;
    return { id, retrievedAt: ts };
  }

  async record(record: ReferenceRecord): Promise<void> {
    try {
      const { runId, memoryEntryId, retrievedAt, retrievalContext } = record;
      await Promise.all([
        this.cache.zadd(
          this.runKey(runId),
          retrievedAt,
          this.encodeMember(memoryEntryId, retrievedAt)
        ),
        this.cache.zadd(
          this.entryKey(memoryEntryId),
          retrievedAt,
          this.encodeMember(runId, retrievedAt)
        ),
        this.cache.set(
          this.ctxKey(runId, memoryEntryId, retrievedAt),
          JSON.stringify(retrievalContext)
        ),
      ]);
    } catch (err) {
      this.onError("record", err);
    }
  }

  async listByRun(
    runId: string,
    options?: ReferenceQueryOptions
  ): Promise<ReferenceRecord[]> {
    try {
      const members = await this.rangeMembers(this.runKey(runId), options);
      const results: ReferenceRecord[] = [];
      for (const { id: memoryEntryId, retrievedAt } of members) {
        const ctxRaw = await this.cache
          .get(this.ctxKey(runId, memoryEntryId, retrievedAt))
          .catch(() => null);
        results.push({
          runId,
          memoryEntryId,
          retrievedAt,
          retrievalContext: parseContext(ctxRaw),
        });
      }
      return results;
    } catch (err) {
      this.onError("listByRun", err);
      return [];
    }
  }

  async listByEntry(
    entryId: string,
    options?: ReferenceQueryOptions
  ): Promise<ReferenceRecord[]> {
    try {
      const members = await this.rangeMembers(this.entryKey(entryId), options);
      const results: ReferenceRecord[] = [];
      for (const { id: runId, retrievedAt } of members) {
        const ctxRaw = await this.cache
          .get(this.ctxKey(runId, entryId, retrievedAt))
          .catch(() => null);
        results.push({
          runId,
          memoryEntryId: entryId,
          retrievedAt,
          retrievalContext: parseContext(ctxRaw),
        });
      }
      return results;
    } catch (err) {
      this.onError("listByEntry", err);
      return [];
    }
  }

  async clearRun(runId: string): Promise<void> {
    try {
      // Pull every member of the run sorted set so we can scrub the reverse
      // indexes and per-citation context entries.
      const runKey = this.runKey(runId);
      const rawMembers = await this.cache.zrangebyscore(
        runKey,
        -Infinity,
        Infinity
      );

      for (const member of rawMembers) {
        const decoded = this.decodeMember(member);
        if (!decoded) continue;
        const { id: entryId, retrievedAt } = decoded;

        // Remove (runId@ts) from the reverse entry-keyed sorted set
        await this.cache
          .zrem(this.entryKey(entryId), this.encodeMember(runId, retrievedAt))
          .catch((err: unknown) => this.onError("clearRun:zrem", err));

        // Remove the per-citation context value
        await this.cache
          .delete(this.ctxKey(runId, entryId, retrievedAt))
          .catch((err: unknown) => this.onError("clearRun:ctx-delete", err));

        // Remove the member from the run sorted set itself
        await this.cache
          .zrem(runKey, member)
          .catch((err: unknown) => this.onError("clearRun:zrem-self", err));
      }
    } catch (err) {
      this.onError("clearRun", err);
    }
  }

  /**
   * Read a window of members from a sorted set, decode their embedded
   * timestamps, sort most-recent-first, and apply `limit`.
   */
  private async rangeMembers(
    key: string,
    options?: ReferenceQueryOptions
  ): Promise<Array<{ id: string; retrievedAt: number }>> {
    const limit = options?.limit ?? 100;
    const min = options?.sinceMs ?? -Infinity;
    const max = options?.untilMs ?? Infinity;

    const raw = await this.cache.zrangebyscore(key, min, max);
    const decoded: Array<{ id: string; retrievedAt: number }> = [];
    for (const member of raw) {
      const d = this.decodeMember(member);
      if (d) decoded.push(d);
    }
    decoded.sort((a, b) => b.retrievedAt - a.retrievedAt);
    return decoded.slice(0, Math.max(0, limit));
  }
}

function parseContext(raw: string | null): RetrievalContext {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RetrievalContext;
    }
    return {};
  } catch {
    return {};
  }
}
