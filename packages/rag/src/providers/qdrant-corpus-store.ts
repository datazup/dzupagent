/**
 * `QdrantCorpusStore` — `VectorStore` facade for `CorpusManager` that
 * lets multiple logical corpora share a single physical Qdrant
 * collection.
 *
 * The `collection` argument supplied by `CorpusManager` is recorded
 * into a payload field (`_collection`, configurable) so the same
 * physical collection can host multiple corpora without cross-talk.
 * Tenant filtering is delegated to the underlying
 * {@link QdrantVectorStore}.
 */

import type {
  CollectionConfig,
  VectorSearchResult as VectorDBSearchResult,
  VectorDeleteFilter,
  MetadataFilter,
  VectorEntry,
  VectorQuery,
  VectorStore,
  VectorStoreHealth,
} from "@dzupagent/core/vectordb";

import type { QdrantVectorStore } from "./qdrant-store.js";
import type { QdrantFilter, QdrantFilterClause } from "./qdrant-types.js";

/**
 * Translates a normalized {@link MetadataFilter} into Qdrant `must` clauses.
 *
 * Only the operators this store can express as a positive `must` clause are
 * supported. Everything else throws: a delete filter that is silently dropped
 * or partially applied deletes more rows than the caller asked for, so a loud
 * failure is the only safe response.
 */
function toQdrantConditions(filter: MetadataFilter): QdrantFilterClause[] {
  if ("and" in filter) return filter.and.flatMap(toQdrantConditions);
  if ("or" in filter) {
    throw new Error(
      "QdrantCorpusStore.delete: `or` filters are not supported; " +
        "a top-level `must` cannot express disjunction without widening the delete",
    );
  }
  switch (filter.op) {
    case "eq":
      return [{ key: filter.field, match: { value: filter.value } }];
    case "in":
      return [{ key: filter.field, match: { any: filter.value } }];
    default:
      throw new Error(
        `QdrantCorpusStore.delete: unsupported filter operator '${filter.op}' ` +
          `on field '${filter.field}'`,
      );
  }
}

export class QdrantCorpusStore implements VectorStore {
  readonly provider = "qdrant-shared" as const;

  private readonly store: QdrantVectorStore;
  private readonly collectionField: string;
  /** Track logical "collections" the manager has asked us to create. */
  private readonly knownCollections = new Set<string>();

  constructor(
    store: QdrantVectorStore,
    options: { collectionField?: string } = {},
  ) {
    this.store = store;
    this.collectionField = options.collectionField ?? "_collection";
  }

  async createCollection(
    name: string,
    _config: CollectionConfig,
  ): Promise<void> {
    // Single physical collection — provisioning is the operator's job.
    this.knownCollections.add(name);
  }

  async deleteCollection(name: string): Promise<void> {
    if (!this.knownCollections.has(name)) return;
    this.knownCollections.delete(name);
    // Best-effort delete by filter — leaves the physical collection intact.
    await this.store.client.scroll(this.store.collectionName, {
      limit: 1,
      with_payload: false,
      filter: { must: [{ key: this.collectionField, match: { value: name } }] },
    });
    // Issue a delete via the underlying client when supported.
    const client = this.store.client as unknown as {
      delete?: (c: string, body: { filter: QdrantFilter }) => Promise<unknown>;
    };
    if (typeof client.delete === "function") {
      await client.delete(this.store.collectionName, {
        filter: {
          must: [{ key: this.collectionField, match: { value: name } }],
        },
      });
    }
  }

  async listCollections(): Promise<string[]> {
    return [...this.knownCollections];
  }

  async collectionExists(name: string): Promise<boolean> {
    return this.knownCollections.has(name);
  }

  async upsert(collection: string, entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.store.upsertMany(
      entries.map((e) => ({
        id: e.id,
        vector: e.vector,
        payload: {
          ...e.metadata,
          ...(e.text !== undefined ? { text: e.text } : {}),
          [this.collectionField]: collection,
        },
      })),
    );
  }

  async search(
    collection: string,
    query: VectorQuery,
  ): Promise<VectorDBSearchResult[]> {
    // Inject the synthetic _collection filter alongside any tenant filter.
    const filter: Record<string, unknown> = {
      [this.collectionField]: collection,
    };
    const tenantId = pickTenant(query.filter);
    if (tenantId !== undefined) filter["tenantId"] = tenantId;

    const hits = await this.store.search(query.vector, query.limit, filter);
    const filtered =
      typeof query.minScore === "number"
        ? hits.filter((h) => h.score >= query.minScore!)
        : hits;
    return filtered.map((h) => {
      const payload = { ...h.payload };
      const text =
        typeof payload["text"] === "string"
          ? (payload["text"] as string)
          : undefined;
      delete payload["text"];
      delete payload[this.collectionField];
      return {
        id: h.id,
        score: h.score,
        metadata: payload,
        ...(text !== undefined ? { text } : {}),
      };
    });
  }

  async delete(collection: string, filter: VectorDeleteFilter): Promise<void> {
    const client = this.store.client as unknown as {
      delete?: (
        c: string,
        body: { points?: Array<string | number>; filter?: QdrantFilter },
      ) => Promise<unknown>;
    };
    if (typeof client.delete !== "function") return;
    if ("ids" in filter) {
      await client.delete(this.store.collectionName, { points: filter.ids });
      return;
    }
    // Metadata-filter deletes are scoped to this logical collection *and*
    // narrowed by the caller's filter. Dropping the caller's terms here would
    // silently widen "delete where quality < 0.2" into "delete everything in
    // the collection", so an untranslatable filter throws instead.
    await client.delete(this.store.collectionName, {
      filter: {
        must: [
          { key: this.collectionField, match: { value: collection } },
          ...toQdrantConditions(filter.filter),
        ],
      },
    });
  }

  /**
   * Count the vectors belonging to one logical collection.
   *
   * Scoped by the synthetic `_collection` payload field, because several
   * logical corpora share one physical Qdrant collection; a bare count of the
   * physical collection would report every corpus's vectors as this one's.
   *
   * Throws when the injected client cannot count. `count` returns a plain
   * `number` with no sentinel for "unknown", and callers subtract counts to
   * derive a result — `RagPipeline.deleteBySourceId` returns `before - after`
   * as its deleted-chunk total. A fabricated `0` makes a purge of thousands of
   * vectors report `0 deleted`, which is precisely the value that already
   * means "nothing matched". A measurement that was never taken must not be
   * spelled the same way as one that was.
   */
  async count(collection: string): Promise<number> {
    const client = this.store.client as unknown as {
      count?: (
        c: string,
        body: { filter?: QdrantFilter; exact?: boolean },
      ) => Promise<{ count: number } | { result: { count: number } }>;
    };
    if (typeof client.count !== "function") {
      throw new Error(
        "QdrantCorpusStore.count: the injected Qdrant client does not " +
          "implement `count`. Returning 0 would be indistinguishable from an " +
          "empty collection, so the count is refused instead.",
      );
    }
    const response = await client.count(this.store.collectionName, {
      filter: {
        must: [{ key: this.collectionField, match: { value: collection } }],
      },
      exact: true,
    });
    const count = "result" in response ? response.result.count : response.count;
    if (typeof count !== "number" || !Number.isFinite(count)) {
      throw new Error(
        "QdrantCorpusStore.count: Qdrant returned a non-numeric count",
      );
    }
    return count;
  }

  /**
   * Probe the backing Qdrant instance.
   *
   * Reports `healthy: false` when the round-trip fails, and when the client
   * exposes no probe method at all. An unconditional `healthy: true` claims
   * the remote is reachable without ever having asked it — the single thing a
   * health check exists to establish.
   */
  async healthCheck(): Promise<VectorStoreHealth> {
    const startedAt = Date.now();
    const client = this.store.client as unknown as {
      getCollections?: () => Promise<unknown>;
    };
    if (typeof client.getCollections !== "function") {
      return {
        healthy: false,
        latencyMs: 0,
        provider: this.provider,
        details: {
          reason:
            "client exposes no probe method; reachability was never checked",
        },
      };
    }
    try {
      await client.getCollections();
      return {
        healthy: true,
        latencyMs: Date.now() - startedAt,
        provider: this.provider,
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - startedAt,
        provider: this.provider,
        details: {
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async close(): Promise<void> {
    // Underlying client is fetch-based; nothing to release.
  }
}

function pickTenant(
  filter: VectorQuery["filter"] | undefined,
): string | number | boolean | undefined {
  if (!filter) return undefined;
  if ("and" in filter || "or" in filter) {
    const branches = "and" in filter ? filter.and : filter.or;
    for (const child of branches) {
      const v = pickTenant(child);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  if ("field" in filter && filter.field === "tenantId" && filter.op === "eq") {
    return filter.value;
  }
  return undefined;
}
