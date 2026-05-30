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
 */
export function buildNamespaceTuple(
  ns: NamespaceConfig,
  scope: Record<string, string>
): string[] {
  return ns.scopeKeys.map((k) => {
    const val = scope[k];
    if (!val) {
      throw new Error(`Missing scope key "${k}" for namespace "${ns.name}"`);
    }
    return val;
  });
}

interface PutDeps {
  store: BaseStore;
  semanticStore: SemanticStoreAdapter | undefined;
  rejectUnsafe: boolean;
  options: MemoryServiceOptions | undefined;
  eventBus: MemoryEventBus | undefined;
  agentId: string | undefined;
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
      const collectionName = `memory_${ns.name}`;
      await deps.semanticStore
        .upsert(collectionName, [
          {
            id: key,
            text,
            metadata: { namespace: ns.name, ...scope },
          },
        ])
        .catch(() => {
          // Non-fatal — vector indexing failures should not break pipelines
        });
    }
  } catch {
    // Non-fatal — memory write failures should not break pipelines
  }
}

interface GetDeps {
  store: BaseStore;
  referenceTracker: ReferenceTracker | undefined;
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
