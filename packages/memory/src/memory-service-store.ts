/**
 * Write/read primitives for {@link MemoryService}.
 *
 * Encapsulates the namespace tuple resolution, sanitization, PII redaction,
 * decay-metadata population, and reference tracking that surround every
 * direct put/get/delete call against the backing `BaseStore`.
 *
 * Pure helpers — no class state. The coordinator class threads its own
 * state in via parameters.
 */
import type { BaseStore } from "@langchain/langgraph";
import type { NamespaceConfig, SemanticStoreAdapter } from "./memory-types.js";
import { sanitizeMemoryContent } from "./memory-sanitizer.js";
import { createDecayMetadata } from "./decay-engine.js";
import type { MemoryStoreCapabilities } from "./store-capabilities.js";
import type { ReferenceTracker } from "./provenance/reference-tracker.js";
import { deriveMemoryEntryId } from "./provenance/reference-tracker.js";
import type {
  MemoryEventBus,
  MemoryServiceOptions,
  ReadContext,
} from "./memory-service-types.js";

/**
 * Resolve the configured namespace by name or throw when unknown.
 */
export function getNamespace(
  nsMap: Map<string, NamespaceConfig>,
  name: string
): NamespaceConfig {
  const ns = nsMap.get(name);
  if (!ns) throw new Error(`Unknown namespace: ${name}`);
  return ns;
}

/**
 * Project a scope object into the ordered tuple required by the namespace,
 * throwing when any required scope key is missing.
 *
 * The namespace NAME is the first tuple element. Without it two namespaces
 * declared with identical `scopeKeys` (the common case — `["tenantId"]`)
 * share one storage tuple, and identical keys silently overwrite each other
 * across namespace boundaries.
 *
 * This is the single source of truth for the storage tuple: every read,
 * write, delete, search, and consolidation path MUST build its tuple here.
 * Any caller that reimplements the layout will silently target records that
 * do not exist.
 *
 * NOTE: the tuple layout is the on-disk memory layout. Changing it
 * invalidates previously written records. This stack has no production
 * consumers, so no migration path is provided.
 */
export function buildNamespaceTuple(
  ns: NamespaceConfig,
  scope: Record<string, string>
): string[] {
  return [
    ns.name,
    ...ns.scopeKeys.map((k) => {
      const val = scope[k];
      if (!val) {
        throw new Error(`Missing scope key "${k}" for namespace "${ns.name}"`);
      }
      return val;
    }),
  ];
}

/**
 * Metadata key carrying the namespace name on an indexed vector document.
 *
 * Underscore-prefixed so it cannot be shadowed by a caller scope key named
 * `namespace` — which `memory-kit`'s own `tenantScope()` helper produces.
 */
export const VECTOR_NAMESPACE_META_KEY = "_ns";

/** Metadata key carrying the original store key on an indexed vector document. */
export const VECTOR_KEY_META_KEY = "_key";

/**
 * Vector collection name for a namespace. Collections are per-namespace;
 * tenant separation inside a collection is by metadata filter, so both the
 * doc id and the filter must carry the full scope.
 */
export function buildVectorCollectionName(ns: NamespaceConfig): string {
  return `memory_${ns.name}`;
}

/**
 * Globally unique vector document id.
 *
 * The bare store `key` is only unique within one namespace tuple, but a
 * collection holds every tenant's documents. Prefixing with the full storage
 * tuple stops one tenant's write from overwriting another's document under
 * the same key (the write-side twin of the read-side scope filter).
 */
export function buildVectorDocId(
  ns: NamespaceConfig,
  scope: Record<string, string>,
  key: string
): string {
  return [...buildNamespaceTuple(ns, scope), key]
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * Metadata written alongside an indexed vector document — the scope record
 * plus the internal namespace/key markers the read path filters and
 * de-duplicates on.
 */
export function buildVectorMetadata(
  ns: NamespaceConfig,
  scope: Record<string, string>,
  key: string
): Record<string, unknown> {
  return {
    ...scope,
    [VECTOR_NAMESPACE_META_KEY]: ns.name,
    [VECTOR_KEY_META_KEY]: key,
  };
}

interface PutDeps {
  store: BaseStore;
  semanticStore: SemanticStoreAdapter | undefined;
  rejectUnsafe: boolean;
  options: MemoryServiceOptions | undefined;
  eventBus: MemoryEventBus | undefined;
  agentId: string | undefined;
  /**
   * Collections already passed through `ensureCollection` on this service
   * instance. Owned by the coordinator so the guarantee survives across
   * calls; omit it and every write pays one extra `ensureCollection`.
   */
  ensuredCollections?: Set<string> | undefined;
}

/**
 * Create the vector collection on first write to it.
 *
 * Nothing else in the service ever calls `ensureCollection`, and both
 * `InMemoryVectorStore.upsert` and `.search` throw on a missing collection.
 * Because the upsert failure is non-fatal by design, an unensured collection
 * makes semantic indexing permanently, silently inert.
 */
async function ensureCollectionOnce(
  semanticStore: SemanticStoreAdapter,
  collection: string,
  ensured: Set<string> | undefined
): Promise<void> {
  if (ensured?.has(collection)) return;
  await semanticStore.ensureCollection(collection);
  ensured?.add(collection);
}

/**
 * Persist a value under [namespace + scope] → key with sanitization,
 * PII redaction, decay metadata, and (optionally) semantic indexing.
 *
 * Non-fatal: never throws. Unsafe content is silently dropped.
 */
export async function putMemoryRecord(
  ns: NamespaceConfig,
  scope: Record<string, string>,
  key: string,
  value: Record<string, unknown>,
  deps: PutDeps
): Promise<void> {
  let workingValue = value;
  let textContent =
    typeof workingValue["text"] === "string"
      ? (workingValue["text"] as string)
      : JSON.stringify(workingValue);

  if (deps.rejectUnsafe) {
    const result = sanitizeMemoryContent(textContent);
    if (!result.safe) {
      deps.eventBus?.emit({
        type: "memory:threat_detected",
        agentId: deps.agentId ?? "unknown",
        namespace: ns.name,
        threats: result.threats,
      });
      return;
    }
  }

  // PII detection / redaction (non-fatal). When a detector is supplied
  // and redaction is enabled (default), rewrite `text` to the redacted
  // form so persisted memories never contain raw PII.
  if (deps.options?.piiRedactionEnabled !== false && deps.options?.detectPII) {
    try {
      const piiResult = deps.options.detectPII(textContent);
      if (piiResult.hasPII) {
        textContent = piiResult.redacted;
        workingValue = { ...workingValue, text: textContent };
        deps.eventBus?.emit({
          type: "memory:pii_redacted",
          agentId: deps.agentId ?? "unknown",
        });
      }
    } catch {
      // PII detection must never abort a write
    }
  }

  const tuple = buildNamespaceTuple(ns, scope);
  try {
    // For searchable namespaces, ensure a "text" field exists in the value.
    // PostgresStore uses this field for embedding/indexing. Without it,
    // semantic search silently returns no results.
    let enriched = workingValue;
    if (ns.searchable && typeof enriched["text"] !== "string") {
      enriched = { ...enriched, text: JSON.stringify(enriched) };
    }

    // Auto-populate decay metadata so every persisted memory participates
    // in decay-aware retrieval (strength, accessCount, half-life). Caller-
    // supplied `_decay` is preserved when present.
    if (!enriched["_decay"]) {
      const importance =
        typeof enriched["importance"] === "number"
          ? (enriched["importance"] as number)
          : 0.5;
      enriched = { ...enriched, _decay: createDecayMetadata({ importance }) };
    }
    await deps.store.put(tuple, key, enriched);

    // Auto-index into SemanticStore for vector search (non-fatal)
    if (deps.semanticStore && ns.searchable) {
      const text =
        typeof enriched["text"] === "string"
          ? enriched["text"]
          : JSON.stringify(enriched);
      const collectionName = buildVectorCollectionName(ns);
      const semanticStore = deps.semanticStore;
      await (async () => {
        await ensureCollectionOnce(
          semanticStore,
          collectionName,
          deps.ensuredCollections
        );
        await semanticStore.upsert(collectionName, [
          {
            id: buildVectorDocId(ns, scope, key),
            text,
            metadata: buildVectorMetadata(ns, scope, key),
          },
        ]);
      })().catch((err: unknown) => {
          // Non-fatal — vector indexing failures should not break pipelines.
          // But they MUST NOT be silent: a swallowed upsert leaves the
          // semantic index drifting out of sync with the primary store even
          // though the primary write (and any `memory:written` event) already
          // succeeded. Surface via structured log + telemetry event so the
          // drift is observable.
          const message = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error("[memory] semantic index upsert failed", {
            namespace: ns.name,
            key,
            error: message,
          });
          deps.eventBus?.emit({
            type: "memory:error",
            namespace: ns.name,
            key,
            message,
            agentId: deps.agentId ?? "unknown",
          });
        });
    }
  } catch (err: unknown) {
    // Non-fatal — memory write failures should not break pipelines. But a
    // fully swallowed primary write is a data-loss hazard, so log + emit a
    // failure event rather than dropping it silently.
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[memory] primary store write failed", {
      namespace: ns.name,
      key,
      error: message,
    });
    deps.eventBus?.emit({
      type: "memory:put_failed",
      namespace: ns.name,
      key,
      message,
      agentId: deps.agentId ?? "unknown",
    });
  }
}

interface GetDeps {
  store: BaseStore;
  referenceTracker: ReferenceTracker | undefined;
}

/**
 * A stored record paired with the store key it was written under.
 *
 * `getMemoryRecords` returns bare values, dropping the key the caller passed
 * to `put()`. Callers that need record identity — export, reconciliation,
 * de-duplication — cannot recover it from the value, because `put()` does not
 * write the key into the record. This pairing carries it explicitly.
 */
export interface KeyedMemoryRecord {
  /** The store key the record was written under. */
  key: string;
  /** The record value, returned verbatim — never mutated to carry the key. */
  value: Record<string, unknown>;
}

/**
 * Read every record in a namespace together with its store key.
 *
 * Unlike {@link getMemoryRecords}, this preserves the key each record was
 * written under instead of discarding it. Values are returned untouched, so
 * this does not change what a record's content hash or export signature is
 * computed over.
 *
 * Non-fatal: returns `[]` on error, matching the plain read path.
 */
export async function getKeyedMemoryRecords(
  ns: NamespaceConfig,
  scope: Record<string, string>,
  store: BaseStore
): Promise<KeyedMemoryRecord[]> {
  const tuple = buildNamespaceTuple(ns, scope);
  try {
    const items = await store.search(tuple);
    return items.map((i) => ({
      key: i.key,
      value: i.value as Record<string, unknown>,
    }));
  } catch {
    return [];
  }
}

/**
 * Read records from a namespace; either a single key or all entries.
 *
 * Non-fatal: returns `[]` on error. When `readContext` and a tracker are
 * configured, citations are recorded fire-and-forget without blocking
 * the read path.
 */
export async function getMemoryRecords(
  ns: NamespaceConfig,
  scope: Record<string, string>,
  key: string | undefined,
  readContext: ReadContext | undefined,
  deps: GetDeps
): Promise<Record<string, unknown>[]> {
  const tuple = buildNamespaceTuple(ns, scope);
  let results: Record<string, unknown>[];
  try {
    if (key) {
      const item = await deps.store.get(tuple, key);
      results = item ? [item.value as Record<string, unknown>] : [];
    } else {
      const items = await deps.store.search(tuple);
      results = items.map((i) => i.value as Record<string, unknown>);
    }
  } catch {
    return [];
  }

  // Fire-and-forget reference tracking (never blocks the read path)
  if (readContext && deps.referenceTracker && results.length > 0) {
    const tracker = deps.referenceTracker;
    const { runId } = readContext;
    void Promise.all(
      results.map((record, rank) => {
        const entryId = deriveMemoryEntryId(record, rank);
        return tracker.trackReference(runId, entryId, {
          namespace: ns.name,
          rank,
        });
      })
    ).catch(() => {
      /* swallow tracker errors — non-fatal */
    });
  }

  return results;
}

/**
 * Delete a single record from the backing store.
 *
 * Returns `false` when delete is unsupported or the store rejected the op,
 * `true` when the underlying delete completed without error.
 */
export async function deleteMemoryRecord(
  ns: NamespaceConfig,
  scope: Record<string, string>,
  key: string,
  store: BaseStore,
  capabilities: MemoryStoreCapabilities
): Promise<boolean> {
  if (!capabilities.supportsDelete) {
    return false;
  }
  const tuple = buildNamespaceTuple(ns, scope);
  try {
    await store.delete(tuple, key);
    return true;
  } catch {
    // Non-fatal — callers can fall back to tombstones when needed.
    return false;
  }
}
