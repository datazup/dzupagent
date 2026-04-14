/**
 * MCP Memory Transport — Zod schemas and handler logic for MCP memory exchange tools.
 *
 * Provides framework-agnostic handlers for exporting/importing memory as Arrow IPC
 * or JSON, suitable for use in MCP tool handlers, Hono routes, or any other transport.
 */

import { z } from 'zod'
import type { Table } from 'apache-arrow'
import type { FrameRecordValue } from './frame-builder.js'

import {
  serializeToIPC,
  deserializeFromIPC,
  ipcToBase64,
  base64ToIPC,
} from './ipc-serializer.js'
import { MEMORY_FRAME_SCHEMA, MEMORY_FRAME_VERSION } from './schema.js'
import { FrameReader } from './frame-reader.js'

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const exportMemoryInputSchema = z.object({
  namespace: z.string().describe('Memory namespace to export'),
  scope: z.record(z.string(), z.string()).optional().describe('Scope filter'),
  query: z.string().optional().describe('Semantic search query'),
  format: z.enum(['arrow_ipc', 'json']).default('arrow_ipc'),
  limit: z.number().default(100),
})

export const exportMemoryOutputSchema = z.object({
  data: z.string().describe('Base64-encoded Arrow IPC or JSON array'),
  format: z.enum(['arrow_ipc', 'json']),
  schema_version: z.number(),
  record_count: z.number(),
  namespaces: z.array(z.string()),
  byte_size: z.number(),
})

export const importMemoryInputSchema = z.object({
  data: z.string().describe('Base64-encoded Arrow IPC or JSON array'),
  format: z.enum(['arrow_ipc', 'json']).default('arrow_ipc'),
  namespace: z.string(),
  scope: z.record(z.string(), z.string()).optional(),
  merge_strategy: z.enum(['upsert', 'append', 'replace']).default('upsert'),
})

export const importMemoryOutputSchema = z.object({
  imported: z.number(),
  skipped: z.number(),
  conflicts: z.number(),
  warnings: z.array(z.string()),
})

export const memorySchemaOutputSchema = z.object({
  schema_version: z.number(),
  fields: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      nullable: z.boolean(),
      description: z.string(),
    }),
  ),
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportMemoryInput = z.infer<typeof exportMemoryInputSchema>
export type ExportMemoryOutput = z.infer<typeof exportMemoryOutputSchema>
export type ImportMemoryInput = z.infer<typeof importMemoryInputSchema>
export type ImportMemoryOutput = z.infer<typeof importMemoryOutputSchema>
export type MemorySchemaOutput = z.infer<typeof memorySchemaOutputSchema>

// ---------------------------------------------------------------------------
// Field descriptions for handleMemorySchema
// ---------------------------------------------------------------------------

const FIELD_DESCRIPTIONS: Record<string, string> = {
  id: 'Unique record identifier',
  namespace: 'Memory namespace (dictionary-encoded)',
  key: 'Record key within namespace',
  scope_tenant: 'Tenant scope identifier',
  scope_project: 'Project scope identifier',
  scope_agent: 'Agent scope identifier',
  scope_session: 'Session scope identifier',
  text: 'Human-readable text content',
  payload_json: 'JSON-serialized overflow/extra fields',
  system_created_at: 'System creation timestamp (ms epoch)',
  system_expired_at: 'System expiration timestamp (ms epoch)',
  valid_from: 'Validity start timestamp (ms epoch)',
  valid_until: 'Validity end timestamp (ms epoch)',
  decay_strength: 'Current memory decay strength (0.0-1.0)',
  decay_half_life_ms: 'Decay half-life in milliseconds',
  decay_last_accessed_at: 'Last access timestamp for decay (ms epoch)',
  decay_access_count: 'Number of times this record was accessed',
  agent_id: 'Agent that created this record (dictionary-encoded)',
  category: 'Record category/type (dictionary-encoded)',
  importance: 'Importance score (0.0-1.0)',
  provenance_source: 'Source of this record (dictionary-encoded)',
  is_active: 'Whether this record is active (not expired)',
}

// ---------------------------------------------------------------------------
// Handler: Export Memory
// ---------------------------------------------------------------------------

/** Dependencies for handleExportMemory. */
export interface ExportMemoryDeps {
  exportFrame: (
    ns: string,
    scope: Record<string, string>,
    opts?: { query?: string; limit?: number },
  ) => Promise<Table>
}

/**
 * Handle a memory export request.
 *
 * Calls deps.exportFrame to get an Arrow Table, then serializes to
 * the requested format (arrow_ipc or json) and base64-encodes the result.
 */
export async function handleExportMemory(
  input: ExportMemoryInput,
  deps: ExportMemoryDeps,
): Promise<ExportMemoryOutput> {
  const table = await deps.exportFrame(
    input.namespace,
    input.scope ?? {},
    { ...(input.query !== undefined ? { query: input.query } : {}), limit: input.limit },
  )

  const reader = new FrameReader(table)
  const namespaces = reader.namespaces
  const recordCount = table.numRows

  if (input.format === 'json') {
    const records = reader.toRecords()
    const jsonStr = JSON.stringify(records)
    const b64 = ipcToBase64(new TextEncoder().encode(jsonStr))
    return {
      data: b64,
      format: 'json',
      schema_version: MEMORY_FRAME_VERSION,
      record_count: recordCount,
      namespaces,
      byte_size: jsonStr.length,
    }
  }

  // Default: arrow_ipc
  const ipcBytes = serializeToIPC(table)
  const b64 = ipcToBase64(ipcBytes)
  return {
    data: b64,
    format: 'arrow_ipc',
    schema_version: MEMORY_FRAME_VERSION,
    record_count: recordCount,
    namespaces,
    byte_size: ipcBytes.byteLength,
  }
}

// ---------------------------------------------------------------------------
// Handler: Import Memory
// ---------------------------------------------------------------------------

/** Dependencies for handleImportMemory. */
export interface ImportMemoryDeps {
  importFrame: (
    ns: string,
    scope: Record<string, string>,
    table: Table,
    strategy?: string,
  ) => Promise<{ imported: number; skipped: number; conflicts: number }>
}

/**
 * Handle a memory import request.
 *
 * Base64-decodes the data, deserializes from the specified format,
 * then calls deps.importFrame with the resulting Arrow Table.
 */
export async function handleImportMemory(
  input: ImportMemoryInput,
  deps: ImportMemoryDeps,
): Promise<ImportMemoryOutput> {
  const warnings: string[] = []

  let table: Table

  if (input.format === 'json') {
    // Decode base64 → JSON string → records → Arrow Table via FrameBuilder
    const jsonBytes = base64ToIPC(input.data)
    const jsonStr = new TextDecoder().decode(jsonBytes)
    try {
      const parsed: unknown = JSON.parse(jsonStr)
      if (!Array.isArray(parsed)) {
        return {
          imported: 0,
          skipped: 0,
          conflicts: 0,
          warnings: ['Invalid JSON data: expected an array'],
        }
      }

      // Use dynamic import to avoid circular deps — FrameBuilder is in same package
      const { FrameBuilder } = await import('./frame-builder.js')
      const builder = new FrameBuilder()

      for (const item of parsed) {
        if (
          typeof item === 'object' &&
          item !== null &&
          'meta' in item &&
          'value' in item
        ) {
          const rec = item as {
            meta: { id: string; namespace: string; key: string; scope?: Record<string, string | null> }
            value: Record<string, unknown>
          }
          builder.add(
            rec.value as FrameRecordValue,
            {
              id: rec.meta.id,
              namespace: rec.meta.namespace,
              key: rec.meta.key,
              scope: rec.meta.scope
                ? {
                    tenant: rec.meta.scope['tenant'] ?? null,
                    project: rec.meta.scope['project'] ?? null,
                    agent: rec.meta.scope['agent'] ?? null,
                    session: rec.meta.scope['session'] ?? null,
                  }
                : undefined,
            },
          )
        } else {
          warnings.push('Skipped malformed record (missing meta/value)')
        }
      }

      table = builder.build()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        imported: 0,
        skipped: 0,
        conflicts: 0,
        warnings: [`Failed to parse JSON data: ${msg}`],
      }
    }
  } else {
    // arrow_ipc: base64 decode → deserialize
    const ipcBytes = base64ToIPC(input.data)
    if (ipcBytes.byteLength === 0) {
      return {
        imported: 0,
        skipped: 0,
        conflicts: 0,
        warnings: ['Empty or invalid Arrow IPC data'],
      }
    }
    table = deserializeFromIPC(ipcBytes)
  }

  if (table.numRows === 0) {
    return {
      imported: 0,
      skipped: 0,
      conflicts: 0,
      warnings: [...warnings, 'No records found in import data'],
    }
  }

  const result = await deps.importFrame(
    input.namespace,
    input.scope ?? {},
    table,
    input.merge_strategy,
  )

  return {
    imported: result.imported,
    skipped: result.skipped,
    conflicts: result.conflicts,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Handler: Memory Schema
// ---------------------------------------------------------------------------

/**
 * Return the canonical memory frame schema description.
 *
 * No dependencies needed — reads directly from MEMORY_FRAME_SCHEMA.
 */
export function handleMemorySchema(): MemorySchemaOutput {
  const fields = MEMORY_FRAME_SCHEMA.fields.map((field) => ({
    name: field.name,
    type: field.type.toString(),
    nullable: field.nullable,
    description: FIELD_DESCRIPTIONS[field.name] ?? field.name,
  }))

  return {
    schema_version: MEMORY_FRAME_VERSION,
    fields,
  }
}
