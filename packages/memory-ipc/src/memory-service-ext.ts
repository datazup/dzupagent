/**
 * Extension methods that add Arrow export/import to MemoryService.
 *
 * Uses a minimal MemoryServiceLike interface to avoid hard dependency
 * on @dzupagent/memory. Works with any object that has get/search/put methods,
 * and supports delete-aware replace semantics when delete() is available.
 */

import { type Table } from "apache-arrow";
import { FrameBuilder } from "./frame-builder.js";
import { FrameReader } from "./frame-reader.js";
import { serializeToIPC, deserializeFromIPC } from "./ipc-serializer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for exporting a memory frame. */
export interface ExportFrameOptions {
  /** If provided, use search() instead of get(). */
  query?: string;
  /** Max records to retrieve. Default: 1000 */
  limit?: number;
}

/** Result of an import operation. */
export interface ImportFrameResult {
  imported: number;
  skipped: number;
  conflicts: number;
}

/** Strategy for handling existing records during import. */
export type ImportStrategy = "upsert" | "append" | "replace";

/**
 * Minimal interface for MemoryService.
 * Avoids hard dependency on @dzupagent/memory.
 */
export interface MemoryServiceLike {
  get(
    namespace: string,
    scope: Record<string, string>,
    key?: string
  ): Promise<Record<string, unknown>[]>;
  search(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit?: number
  ): Promise<Record<string, unknown>[]>;
  put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>
  ): Promise<void>;
  delete?(
    namespace: string,
    scope: Record<string, string>,
    key: string
  ): Promise<boolean | void>;
  /**
   * Read records paired with the store key they were written under.
   *
   * Required. `get()` returns bare values and `put()` does not write the key
   * into the record, so a record's store key is **not recoverable from its
   * value**. Every attempt to recover it anyway — reading `value['key']`,
   * `value['id']`, or falling back to the array index — has produced a defect
   * in which an operation reports success while acting on a key that
   * identifies nothing.
   *
   * This was optional, guarding fallbacks that did exactly that. The
   * optionality was the defect class: a caller passing a service without
   * `getKeyed` type-checked cleanly and silently took the fabricating path.
   * Consumers that genuinely never need identity should take
   * {@link ReadOnlyMemoryServiceLike} instead of widening this back.
   */
  getKeyed(
    namespace: string,
    scope: Record<string, string>
  ): Promise<Array<{ key: string; value: Record<string, unknown> }>>;
}

/**
 * A memory service for consumers that read values and never need identity.
 *
 * Use this for search/browse paths. It deliberately omits `getKeyed` rather
 * than making it optional, so "I don't need keys" is stated in the type
 * instead of being indistinguishable from "keys silently unavailable".
 */
export type ReadOnlyMemoryServiceLike = Omit<MemoryServiceLike, "getKeyed">;

/** The Arrow extension methods added to a MemoryService. */
export interface MemoryServiceArrowExtension {
  exportFrame(
    namespace: string,
    scope: Record<string, string>,
    options?: ExportFrameOptions
  ): Promise<Table>;
  importFrame(
    namespace: string,
    scope: Record<string, string>,
    table: Table,
    strategy?: ImportStrategy
  ): Promise<ImportFrameResult>;
  exportIPC(
    namespace: string,
    scope: Record<string, string>,
    options?: ExportFrameOptions
  ): Promise<Uint8Array>;
  importIPC(
    namespace: string,
    scope: Record<string, string>,
    ipcBytes: Uint8Array,
    strategy?: ImportStrategy
  ): Promise<ImportFrameResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a string field from a record, returning null if absent or not a string.
 */
function extractString(
  record: Record<string, unknown>,
  field: string
): string | null {
  const val = record[field];
  return typeof val === "string" ? val : null;
}

/**
 * Generate a deterministic ID for a record from namespace + key.
 *
 * Always deterministic now that the real store key is required upstream. The
 * former `${namespace}:auto-${index}-${Date.now()}` branch made an export's IDs
 * depend on wall-clock time and array position, so two exports of an unchanged
 * namespace disagreed.
 */
function generateId(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

/**
 * Convert a MemoryService record into FrameBuilder-compatible value and meta.
 */
function recordToFrame(
  record: Record<string, unknown>,
  namespace: string,
  scope: Record<string, string>,
  /**
   * The record's real store key, from `getKeyed()`.
   *
   * Required, and never derived from `record`. This previously fell back to
   * `record['key'] ?? record['id'] ?? \`rec-${index}\``; against a real store
   * none of those exist, so every export silently stamped positional keys
   * (`rec-0`, `rec-1`, …). A `replace` re-import of such a frame then deleted
   * by keys identifying nothing, and round-tripping a namespace renamed every
   * record in it.
   */
  key: string
): {
  value: Record<string, unknown>;
  meta: {
    id: string;
    namespace: string;
    key: string;
    scope?: Record<string, string | null>;
  };
} {
  const id = generateId(namespace, key);

  // Build the value object — pass everything through.
  // FrameBuilder knows which keys are "known" and which overflow to payload_json.
  const value: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    // Skip the key/id since those go to meta
    if (k === "key" || k === "id") continue;
    value[k] = v;
  }

  // Ensure text exists for the frame
  if (!("text" in value) || typeof value["text"] !== "string") {
    // Try to synthesize text from other string fields
    const textCandidate =
      extractString(record, "content") ??
      extractString(record, "value") ??
      extractString(record, "text");
    if (textCandidate) {
      value["text"] = textCandidate;
    }
  }

  const frameScope: Record<string, string | null> = {
    tenant: scope["tenant"] ?? null,
    project: scope["project"] ?? null,
    agent: scope["agent"] ?? null,
    session: scope["session"] ?? null,
  };

  return {
    value,
    meta: { id, namespace, key, scope: frameScope },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Extend a MemoryService instance with Arrow frame export/import.
 * Returns a wrapper that adds exportFrame, importFrame, exportIPC, importIPC.
 */
export function extendMemoryServiceWithArrow(
  memoryService: MemoryServiceLike
): MemoryServiceArrowExtension {
  return {
    async exportFrame(
      namespace: string,
      scope: Record<string, string>,
      options?: ExportFrameOptions
    ): Promise<Table> {
      const limit = options?.limit ?? 1000;

      // Always read keyed. An exported frame's whole purpose is to be
      // re-importable, which requires each row to carry the key it came from —
      // and neither `get()` nor `search()` returns keys.
      //
      // Drop holes before anything destructures an entry: a sparse or
      // null-bearing result would otherwise throw here rather than skip the
      // bad row, turning one unreadable record into a failed whole export.
      let records = (await memoryService.getKeyed(namespace, scope)).filter(
        (entry): entry is { key: string; value: Record<string, unknown> } =>
          entry != null
      );

      if (options?.query) {
        // Filter the keyed set rather than delegating to `search()`. `search()`
        // returns bare values, so routing the query through it would restore
        // exactly the identity loss this read exists to avoid. Matching is
        // substring-based over the record's string fields, which is what the
        // previous non-searchable-namespace path degraded to anyway.
        const needle = options.query.toLowerCase();
        records = records.filter(({ value }) =>
          Object.values(value).some(
            (v) => typeof v === "string" && v.toLowerCase().includes(needle)
          )
        );
      }

      if (records.length > limit) records = records.slice(0, limit);

      const builder = new FrameBuilder();
      for (const { key, value } of records) {
        const frame = recordToFrame(value, namespace, scope, key);
        builder.add(frame.value, frame.meta);
      }

      return builder.build();
    },

    async importFrame(
      namespace: string,
      scope: Record<string, string>,
      table: Table,
      strategy: ImportStrategy = "upsert"
    ): Promise<ImportFrameResult> {
      const reader = new FrameReader(table);
      const frameRecords = reader.toRecords();

      const result: ImportFrameResult = {
        imported: 0,
        skipped: 0,
        conflicts: 0,
      };

      if (strategy === "replace") {
        if (!memoryService.delete) {
          throw new Error(
            "replace strategy requires delete() support on MemoryServiceLike"
          );
        }

        // Keyed read, unconditionally. The `get()` + `record['key'] ?? ['id']`
        // fallback that used to live here could not work against a real store —
        // `put()` never writes the key into the value — so it either threw or,
        // where a value happened to carry an unrelated `id` field, deleted the
        // wrong record.
        const existing = await memoryService.getKeyed(namespace, scope);
        for (const { key: existingKey } of existing) {
          await memoryService.delete(namespace, scope, existingKey);
        }
      }

      for (const frameRecord of frameRecords) {
        const key = frameRecord.meta.key;
        if (!key) {
          result.skipped++;
          continue;
        }

        try {
          if (strategy === "append") {
            // Check if key already exists
            const existing = await memoryService.get(namespace, scope, key);
            if (existing.length > 0) {
              result.skipped++;
              continue;
            }
          }

          // Build the value to put
          const putValue: Record<string, unknown> = { ...frameRecord.value };

          await memoryService.put(namespace, scope, key, putValue);
          result.imported++;
        } catch {
          // Non-fatal: count as conflict and continue
          result.conflicts++;
        }
      }

      return result;
    },

    async exportIPC(
      namespace: string,
      scope: Record<string, string>,
      options?: ExportFrameOptions
    ): Promise<Uint8Array> {
      const table = await this.exportFrame(namespace, scope, options);
      return serializeToIPC(table);
    },

    async importIPC(
      namespace: string,
      scope: Record<string, string>,
      ipcBytes: Uint8Array,
      strategy: ImportStrategy = "upsert"
    ): Promise<ImportFrameResult> {
      const table = deserializeFromIPC(ipcBytes);
      return this.importFrame(namespace, scope, table, strategy);
    },
  };
}
