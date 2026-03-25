/**
 * Extension methods that add Arrow export/import to MemoryService.
 *
 * Uses a minimal MemoryServiceLike interface to avoid hard dependency
 * on @forgeagent/memory. Works with any object that has get/search/put methods.
 */

import { type Table } from 'apache-arrow'
import { FrameBuilder } from './frame-builder.js'
import { FrameReader } from './frame-reader.js'
import { serializeToIPC, deserializeFromIPC } from './ipc-serializer.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for exporting a memory frame. */
export interface ExportFrameOptions {
  /** If provided, use search() instead of get(). */
  query?: string
  /** Max records to retrieve. Default: 1000 */
  limit?: number
}

/** Result of an import operation. */
export interface ImportFrameResult {
  imported: number
  skipped: number
  conflicts: number
}

/** Strategy for handling existing records during import. */
export type ImportStrategy = 'upsert' | 'append' | 'replace'

/**
 * Minimal interface for MemoryService.
 * Avoids hard dependency on @forgeagent/memory.
 */
export interface MemoryServiceLike {
  get(
    namespace: string,
    scope: Record<string, string>,
    key?: string,
  ): Promise<Record<string, unknown>[]>
  search(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]>
  put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void>
}

/** The Arrow extension methods added to a MemoryService. */
export interface MemoryServiceArrowExtension {
  exportFrame(
    namespace: string,
    scope: Record<string, string>,
    options?: ExportFrameOptions,
  ): Promise<Table>
  importFrame(
    namespace: string,
    scope: Record<string, string>,
    table: Table,
    strategy?: ImportStrategy,
  ): Promise<ImportFrameResult>
  exportIPC(
    namespace: string,
    scope: Record<string, string>,
    options?: ExportFrameOptions,
  ): Promise<Uint8Array>
  importIPC(
    namespace: string,
    scope: Record<string, string>,
    ipcBytes: Uint8Array,
    strategy?: ImportStrategy,
  ): Promise<ImportFrameResult>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a string field from a record, returning null if absent or not a string.
 */
function extractString(
  record: Record<string, unknown>,
  field: string,
): string | null {
  const val = record[field]
  return typeof val === 'string' ? val : null
}

/**
 * Generate a deterministic ID for a record from namespace + key.
 * Falls back to a random suffix if key is not available.
 */
function generateId(namespace: string, key: string | null, index: number): string {
  if (key) {
    return `${namespace}:${key}`
  }
  return `${namespace}:auto-${index}-${Date.now()}`
}

/**
 * Convert a MemoryService record into FrameBuilder-compatible value and meta.
 */
function recordToFrame(
  record: Record<string, unknown>,
  namespace: string,
  scope: Record<string, string>,
  index: number,
): {
  value: Record<string, unknown>
  meta: { id: string; namespace: string; key: string; scope?: Record<string, string | null> }
} {
  const key = extractString(record, 'key') ?? extractString(record, 'id') ?? `rec-${index}`
  const id = generateId(namespace, key, index)

  // Build the value object — pass everything through.
  // FrameBuilder knows which keys are "known" and which overflow to payload_json.
  const value: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    // Skip the key/id since those go to meta
    if (k === 'key' || k === 'id') continue
    value[k] = v
  }

  // Ensure text exists for the frame
  if (!('text' in value) || typeof value['text'] !== 'string') {
    // Try to synthesize text from other string fields
    const textCandidate =
      extractString(record, 'content') ??
      extractString(record, 'value') ??
      extractString(record, 'text')
    if (textCandidate) {
      value['text'] = textCandidate
    }
  }

  const frameScope: Record<string, string | null> = {
    tenant: scope['tenant'] ?? null,
    project: scope['project'] ?? null,
    agent: scope['agent'] ?? null,
    session: scope['session'] ?? null,
  }

  return {
    value,
    meta: { id, namespace, key, scope: frameScope },
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Extend a MemoryService instance with Arrow frame export/import.
 * Returns a wrapper that adds exportFrame, importFrame, exportIPC, importIPC.
 */
export function extendMemoryServiceWithArrow(
  memoryService: MemoryServiceLike,
): MemoryServiceArrowExtension {
  return {
    async exportFrame(
      namespace: string,
      scope: Record<string, string>,
      options?: ExportFrameOptions,
    ): Promise<Table> {
      const limit = options?.limit ?? 1000
      let records: Record<string, unknown>[]

      if (options?.query) {
        records = await memoryService.search(
          namespace,
          scope,
          options.query,
          limit,
        )
      } else {
        records = await memoryService.get(namespace, scope)
        if (records.length > limit) {
          records = records.slice(0, limit)
        }
      }

      const builder = new FrameBuilder()
      for (let i = 0; i < records.length; i++) {
        const rec = records[i]
        if (!rec) continue
        const { value, meta } = recordToFrame(rec, namespace, scope, i)
        builder.add(value, meta)
      }

      return builder.build()
    },

    async importFrame(
      namespace: string,
      scope: Record<string, string>,
      table: Table,
      strategy: ImportStrategy = 'upsert',
    ): Promise<ImportFrameResult> {
      const reader = new FrameReader(table)
      const frameRecords = reader.toRecords()

      const result: ImportFrameResult = {
        imported: 0,
        skipped: 0,
        conflicts: 0,
      }

      if (strategy === 'replace') {
        // For replace, we attempt to delete existing records first by fetching them.
        // Since MemoryServiceLike has no delete(), we overwrite via put().
        // This is effectively the same as upsert for this interface.
      }

      for (const frameRecord of frameRecords) {
        const key = frameRecord.meta.key
        if (!key) {
          result.skipped++
          continue
        }

        try {
          if (strategy === 'append') {
            // Check if key already exists
            const existing = await memoryService.get(namespace, scope, key)
            if (existing.length > 0) {
              result.skipped++
              continue
            }
          }

          // Build the value to put
          const putValue: Record<string, unknown> = { ...frameRecord.value }

          await memoryService.put(namespace, scope, key, putValue)
          result.imported++
        } catch {
          // Non-fatal: count as conflict and continue
          result.conflicts++
        }
      }

      return result
    },

    async exportIPC(
      namespace: string,
      scope: Record<string, string>,
      options?: ExportFrameOptions,
    ): Promise<Uint8Array> {
      const table = await this.exportFrame(namespace, scope, options)
      return serializeToIPC(table)
    },

    async importIPC(
      namespace: string,
      scope: Record<string, string>,
      ipcBytes: Uint8Array,
      strategy: ImportStrategy = 'upsert',
    ): Promise<ImportFrameResult> {
      const table = deserializeFromIPC(ipcBytes)
      return this.importFrame(namespace, scope, table, strategy)
    },
  }
}
