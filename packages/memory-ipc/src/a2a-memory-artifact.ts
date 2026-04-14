/**
 * A2A Memory Artifact — Arrow IPC memory transfer wrapper for Agent-to-Agent protocol.
 *
 * Wraps Arrow Tables in a standardized artifact envelope for inter-agent
 * memory exchange, with sanitization support for safe export.
 */

import { type Table, tableFromArrays } from 'apache-arrow'

import {
  serializeToIPC,
  deserializeFromIPC,
  ipcToBase64,
  base64ToIPC,
} from './ipc-serializer.js'
import { FrameReader } from './frame-reader.js'
import { MEMORY_FRAME_VERSION } from './schema.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata attached to a memory artifact part. */
export interface MemoryArtifactMetadata {
  schema_version: number
  record_count: number
  namespaces: string[]
  source_agent: string
  temporal_range: { earliest: number; latest: number }
}

/** A single data part within a MemoryArtifact. */
export interface MemoryArtifactPart {
  kind: 'data'
  mimeType: 'application/vnd.apache.arrow.stream'
  data: string // base64 Arrow IPC
  metadata: MemoryArtifactMetadata
}

/** A2A Artifact envelope for memory batch transfer. */
export interface MemoryArtifact {
  name: 'dzupagent_memory_batch'
  description: string
  parts: [MemoryArtifactPart]
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a MemoryArtifact from an Arrow Table.
 *
 * Serializes the table to Arrow IPC stream format, base64-encodes it,
 * and wraps it in the A2A artifact envelope with computed metadata.
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param sourceAgent URI or identifier of the source agent
 * @param description Optional human-readable description
 */
export function createMemoryArtifact(
  table: Table,
  sourceAgent: string,
  description?: string,
): MemoryArtifact {
  const ipcBytes = serializeToIPC(table)
  const b64 = ipcToBase64(ipcBytes)

  const reader = new FrameReader(table)
  const namespaces = reader.namespaces

  // Compute temporal range from system_created_at column
  const temporalRange = computeTemporalRange(table)

  return {
    name: 'dzupagent_memory_batch',
    description:
      description ??
      `Memory batch from ${sourceAgent} (${table.numRows} records)`,
    parts: [
      {
        kind: 'data',
        mimeType: 'application/vnd.apache.arrow.stream',
        data: b64,
        metadata: {
          schema_version: MEMORY_FRAME_VERSION,
          record_count: table.numRows,
          namespaces,
          source_agent: sourceAgent,
          temporal_range: temporalRange,
        },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse a MemoryArtifact back into an Arrow Table.
 *
 * @param artifact The A2A artifact to parse
 * @returns The deserialized table and its metadata
 */
export function parseMemoryArtifact(artifact: MemoryArtifact): {
  table: Table
  metadata: MemoryArtifactMetadata
} {
  const part = artifact.parts[0]
  const ipcBytes = base64ToIPC(part.data)
  const table = deserializeFromIPC(ipcBytes)

  return {
    table,
    metadata: part.metadata,
  }
}

// ---------------------------------------------------------------------------
// Sanitize
// ---------------------------------------------------------------------------

/** Options for sanitizing a table before export. */
export interface SanitizeOptions {
  /** Column names to redact (set to null in output). */
  redactColumns?: string[]
  /** Namespaces to exclude entirely. */
  excludeNamespaces?: string[]
  /** If true, strip the payload_json column. */
  stripPayload?: boolean
}

/**
 * Strip sensitive columns before export.
 *
 * Returns a new table with the specified columns redacted or excluded,
 * along with a list of fields that were redacted.
 *
 * @param table Source Arrow Table
 * @param options Sanitization options
 */
export function sanitizeForExport(
  table: Table,
  options: SanitizeOptions,
): { table: Table; redactedFields: string[] } {
  const redactedFields: string[] = []
  const redactSet = new Set(options.redactColumns ?? [])
  const excludeNs = new Set(options.excludeNamespaces ?? [])

  if (options.stripPayload) {
    redactSet.add('payload_json')
  }

  // Step 1: Filter out excluded namespaces
  let filteredIndices: number[] | null = null
  if (excludeNs.size > 0) {
    const nsCol = table.getChild('namespace')
    if (nsCol) {
      filteredIndices = []
      for (let i = 0; i < table.numRows; i++) {
        const ns: unknown = nsCol.get(i)
        if (typeof ns === 'string' && excludeNs.has(ns)) {
          continue
        }
        filteredIndices.push(i)
      }
    }
  }

  // Step 2: Build output column arrays
  const outputColumns: Record<string, unknown[]> = {}
  const rowCount = filteredIndices ? filteredIndices.length : table.numRows

  for (const field of table.schema.fields) {
    const col = table.getChild(field.name)
    if (!col) {
      outputColumns[field.name] = new Array<unknown>(rowCount).fill(null)
      continue
    }

    if (redactSet.has(field.name)) {
      // Redact: fill with nulls
      outputColumns[field.name] = new Array<unknown>(rowCount).fill(null)
      redactedFields.push(field.name)
    } else if (filteredIndices) {
      // Pick only non-excluded rows
      outputColumns[field.name] = filteredIndices.map(
        (i) => col.get(i) as unknown,
      )
    } else {
      // Copy all rows
      const values: unknown[] = []
      for (let i = 0; i < table.numRows; i++) {
        values.push(col.get(i) as unknown)
      }
      outputColumns[field.name] = values
    }
  }

  const resultTable =
    rowCount === 0
      ? buildEmptyTable(table)
      : tableFromArrays(outputColumns)

  return { table: resultTable, redactedFields }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeTemporalRange(table: Table): {
  earliest: number
  latest: number
} {
  const col = table.getChild('system_created_at')
  if (!col || table.numRows === 0) {
    return { earliest: 0, latest: 0 }
  }

  let earliest = Number.MAX_SAFE_INTEGER
  let latest = 0

  for (let i = 0; i < table.numRows; i++) {
    const raw: unknown = col.get(i)
    if (raw === null || raw === undefined) continue
    const val = typeof raw === 'bigint' ? Number(raw) : (raw as number)
    if (val < earliest) earliest = val
    if (val > latest) latest = val
  }

  if (earliest === Number.MAX_SAFE_INTEGER) earliest = 0

  return { earliest, latest }
}

function buildEmptyTable(source: Table): Table {
  const empty: Record<string, unknown[]> = {}
  for (const field of source.schema.fields) {
    empty[field.name] = []
  }
  return tableFromArrays(empty)
}
