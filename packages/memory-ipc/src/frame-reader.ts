/**
 * FrameReader wraps an Arrow Table and provides typed accessors, filtering,
 * and conversion back to DzipAgent record format.
 *
 * Reconstructs convention fields (_temporal, _decay, _provenance, _agent)
 * from the flat Arrow columns.
 */

import {
  Table,
  type Vector,
  tableFromArrays,
} from 'apache-arrow'

import { MEMORY_FRAME_SCHEMA } from './schema.js'
import { deserializeFromIPC } from './ipc-serializer.js'
import type {
  FrameRecordMeta,
  FrameRecordValue,
  FrameScope,
  FrameTemporal,
  FrameDecay,
  FrameProvenance,
} from './frame-builder.js'

// ---------------------------------------------------------------------------
// Reconstructed record type
// ---------------------------------------------------------------------------

/** A fully reconstructed record from an Arrow table row. */
export interface FrameRecord {
  meta: FrameRecordMeta
  value: FrameRecordValue
}

// ---------------------------------------------------------------------------
// Helper: safe column read
// ---------------------------------------------------------------------------

function getString(col: Vector | null, idx: number): string | null {
  if (!col) return null
  const v: unknown = col.get(idx)
  return typeof v === 'string' ? v : null
}

function getBigInt(col: Vector | null, idx: number): bigint | null {
  if (!col) return null
  const v: unknown = col.get(idx)
  return typeof v === 'bigint' ? v : null
}

function getFloat(col: Vector | null, idx: number): number | null {
  if (!col) return null
  const v: unknown = col.get(idx)
  return typeof v === 'number' ? v : null
}

// ---------------------------------------------------------------------------
// FrameReader
// ---------------------------------------------------------------------------

/**
 * Read-only wrapper around an Arrow Table conforming to MEMORY_FRAME_SCHEMA.
 *
 * Provides typed column access, filtering, and reconstruction of DzipAgent
 * convention fields.
 */
export class FrameReader {
  private readonly table: Table

  constructor(table: Table) {
    this.table = table
  }

  // -------------------------------------------------------------------------
  // Static factories
  // -------------------------------------------------------------------------

  /** Construct from IPC bytes (e.g. from a file or network). */
  static fromIPC(bytes: Uint8Array): FrameReader {
    return new FrameReader(deserializeFromIPC(bytes))
  }

  /** Construct from a SharedArrayBuffer (e.g. from a worker thread). */
  static fromSharedBuffer(buf: SharedArrayBuffer): FrameReader {
    const bytes = new Uint8Array(buf)
    return new FrameReader(deserializeFromIPC(bytes))
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** The underlying Arrow schema. */
  get schema(): Table['schema'] {
    return this.table.schema
  }

  /** Number of rows in the table. */
  get rowCount(): number {
    return this.table.numRows
  }

  /** Unique namespace values present in the table. */
  get namespaces(): string[] {
    const col = this.table.getChild('namespace')
    if (!col) return []
    const set = new Set<string>()
    for (let i = 0; i < col.length; i++) {
      const v: unknown = col.get(i)
      if (typeof v === 'string') set.add(v)
    }
    return Array.from(set)
  }

  /** Get a typed column vector by name. Returns null if not found. */
  getColumn(name: string): Vector | null {
    return this.table.getChild(name)
  }

  /** Get the underlying Arrow Table. */
  getTable(): Table {
    return this.table
  }

  // -------------------------------------------------------------------------
  // Conversion
  // -------------------------------------------------------------------------

  /**
   * Convert all rows back to DzipAgent record format.
   *
   * Reconstructs _temporal, _decay, _provenance convention fields.
   * Parses payload_json back into top-level value fields.
   */
  toRecords(): FrameRecord[] {
    const n = this.table.numRows
    const records: FrameRecord[] = []

    // Cache column references for performance
    const colId = this.table.getChild('id')
    const colNs = this.table.getChild('namespace')
    const colKey = this.table.getChild('key')
    const colScopeTenant = this.table.getChild('scope_tenant')
    const colScopeProject = this.table.getChild('scope_project')
    const colScopeAgent = this.table.getChild('scope_agent')
    const colScopeSession = this.table.getChild('scope_session')
    const colText = this.table.getChild('text')
    const colPayload = this.table.getChild('payload_json')
    const colSysCreated = this.table.getChild('system_created_at')
    const colSysExpired = this.table.getChild('system_expired_at')
    const colValidFrom = this.table.getChild('valid_from')
    const colValidUntil = this.table.getChild('valid_until')
    const colDecayStr = this.table.getChild('decay_strength')
    const colDecayHalf = this.table.getChild('decay_half_life_ms')
    const colDecayLast = this.table.getChild('decay_last_accessed_at')
    const colDecayCount = this.table.getChild('decay_access_count')
    const colAgentId = this.table.getChild('agent_id')
    const colCategory = this.table.getChild('category')
    const colImportance = this.table.getChild('importance')
    const colProvSrc = this.table.getChild('provenance_source')

    for (let i = 0; i < n; i++) {
      const id = getString(colId, i) ?? ''
      const namespace = getString(colNs, i) ?? ''
      const key = getString(colKey, i) ?? ''

      // --- Scope ---
      const scopeTenant = getString(colScopeTenant, i)
      const scopeProject = getString(colScopeProject, i)
      const scopeAgent = getString(colScopeAgent, i)
      const scopeSession = getString(colScopeSession, i)

      const hasScope =
        scopeTenant !== null ||
        scopeProject !== null ||
        scopeAgent !== null ||
        scopeSession !== null

      const scope: FrameScope | undefined = hasScope
        ? {
            tenant: scopeTenant,
            project: scopeProject,
            agent: scopeAgent,
            session: scopeSession,
          }
        : undefined

      // --- Value ---
      const value: FrameRecordValue = {}

      const text = getString(colText, i)
      if (text !== null) value.text = text

      // --- Temporal ---
      const sysCreated = getBigInt(colSysCreated, i)
      const sysExpired = getBigInt(colSysExpired, i)
      const validFrom = getBigInt(colValidFrom, i)
      const validUntil = getBigInt(colValidUntil, i)

      if (
        sysCreated !== null ||
        sysExpired !== null ||
        validFrom !== null ||
        validUntil !== null
      ) {
        const temporal: FrameTemporal = {}
        if (sysCreated !== null)
          temporal.systemCreatedAt = Number(sysCreated)
        if (sysExpired !== null)
          temporal.systemExpiredAt = Number(sysExpired)
        if (validFrom !== null) temporal.validFrom = Number(validFrom)
        if (validUntil !== null)
          temporal.validUntil = Number(validUntil)
        value._temporal = temporal
      }

      // --- Decay ---
      const decayStr = getFloat(colDecayStr, i)
      const decayHalf = getFloat(colDecayHalf, i)
      const decayLast = getBigInt(colDecayLast, i)
      const decayCount = getBigInt(colDecayCount, i)

      if (
        decayStr !== null ||
        decayHalf !== null ||
        decayLast !== null ||
        decayCount !== null
      ) {
        const decay: FrameDecay = {}
        if (decayStr !== null) decay.strength = decayStr
        if (decayHalf !== null) decay.halfLifeMs = decayHalf
        if (decayLast !== null)
          decay.lastAccessedAt = Number(decayLast)
        if (decayCount !== null)
          decay.accessCount = Number(decayCount)
        value._decay = decay
      }

      // --- Agent ---
      const agentId = getString(colAgentId, i)
      if (agentId !== null) value._agent = agentId

      // --- Category ---
      const category = getString(colCategory, i)
      if (category !== null) value.category = category

      // --- Importance ---
      const importance = getFloat(colImportance, i)
      if (importance !== null) value.importance = importance

      // --- Provenance ---
      const provSrc = getString(colProvSrc, i)
      if (provSrc !== null || agentId !== null) {
        const prov: FrameProvenance = {}
        if (agentId !== null) prov.createdBy = agentId
        if (provSrc !== null) prov.source = provSrc
        value._provenance = prov
      }

      // --- Payload overflow ---
      const payloadJson = getString(colPayload, i)
      if (payloadJson !== null) {
        try {
          const parsed: unknown = JSON.parse(payloadJson)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [pk, pv] of Object.entries(parsed as Record<string, unknown>)) {
              value[pk] = pv
            }
          }
        } catch {
          // Non-fatal: if payload_json is malformed, skip it
        }
      }

      records.push({
        meta: { id, namespace, key, scope },
        value,
      })
    }

    return records
  }

  // -------------------------------------------------------------------------
  // Filters — return new FrameReader with subset of rows
  // -------------------------------------------------------------------------

  /** Filter rows to those matching a specific namespace. */
  filterByNamespace(ns: string): FrameReader {
    const col = this.table.getChild('namespace')
    if (!col) return new FrameReader(this.buildEmptyTable())
    const indices: number[] = []
    for (let i = 0; i < this.table.numRows; i++) {
      if (col.get(i) === ns) indices.push(i)
    }
    return new FrameReader(this.buildSubset(indices))
  }

  /** Filter rows to only active records (is_active = true). */
  filterActive(): FrameReader {
    const col = this.table.getChild('is_active')
    if (!col) return new FrameReader(this.table) // If no column, return all
    const indices: number[] = []
    for (let i = 0; i < this.table.numRows; i++) {
      if (col.get(i) === true) indices.push(i)
    }
    return new FrameReader(this.buildSubset(indices))
  }

  /** Filter rows where decay_strength >= threshold. */
  filterByDecayAbove(threshold: number): FrameReader {
    const col = this.table.getChild('decay_strength')
    if (!col) return new FrameReader(this.table) // No decay column = include all
    const indices: number[] = []
    for (let i = 0; i < this.table.numRows; i++) {
      const v: unknown = col.get(i)
      // Include rows with null decay (not subject to decay) or above threshold
      if (v === null || (typeof v === 'number' && v >= threshold)) {
        indices.push(i)
      }
    }
    return new FrameReader(this.buildSubset(indices))
  }

  /** Filter rows by agent_id. */
  filterByAgent(agentId: string): FrameReader {
    const col = this.table.getChild('agent_id')
    if (!col) return new FrameReader(this.buildEmptyTable())
    const indices: number[] = []
    for (let i = 0; i < this.table.numRows; i++) {
      if (col.get(i) === agentId) indices.push(i)
    }
    return new FrameReader(this.buildSubset(indices))
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private buildSubset(indices: number[]): Table {
    if (indices.length === 0) return this.buildEmptyTable()

    const arrays: Record<string, unknown[]> = {}
    for (const field of this.table.schema.fields) {
      const srcCol = this.table.getChild(field.name)
      if (!srcCol) continue
      arrays[field.name] = indices.map((i) => srcCol.get(i))
    }

    return tableFromArrays(arrays)
  }

  private buildEmptyTable(): Table {
    const arrays: Record<string, unknown[]> = {}
    for (const field of MEMORY_FRAME_SCHEMA.fields) {
      arrays[field.name] = []
    }
    return tableFromArrays(arrays)
  }
}
