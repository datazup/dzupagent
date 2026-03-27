/**
 * FrameBuilder accumulates DzipAgent memory records and builds an Arrow Table.
 *
 * Records are plain objects with optional convention fields (_temporal, _decay,
 * _provenance, _agent, text, category, importance). Fields not mapped to schema
 * columns overflow into `payload_json`.
 */

import {
  Table,
  tableFromArrays,
} from 'apache-arrow'

import { serializeToIPC } from './ipc-serializer.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Scope metadata for a memory record. */
export interface FrameScope {
  tenant?: string | null
  project?: string | null
  agent?: string | null
  session?: string | null
}

/** Temporal metadata matching DzipAgent's TemporalMetadata convention. */
export interface FrameTemporal {
  systemCreatedAt?: number
  systemExpiredAt?: number | null
  validFrom?: number
  validUntil?: number | null
}

/** Decay metadata matching DzipAgent's DecayMetadata convention. */
export interface FrameDecay {
  strength?: number | null
  halfLifeMs?: number | null
  lastAccessedAt?: number | null
  accessCount?: number | null
}

/** Provenance metadata for a memory record. */
export interface FrameProvenance {
  createdBy?: string | null
  source?: string | null
}

/** Metadata envelope passed alongside a record value. */
export interface FrameRecordMeta {
  id: string
  namespace: string
  key: string
  scope?: FrameScope
}

/** A value object as stored in DzipAgent memory. */
export interface FrameRecordValue {
  text?: string | null
  _temporal?: FrameTemporal
  _decay?: FrameDecay
  _provenance?: FrameProvenance
  _agent?: string | null
  category?: string | null
  type?: string | null
  importance?: number | null
  [extra: string]: unknown
}

// ---------------------------------------------------------------------------
// Known keys that map to dedicated schema columns (excluded from payload_json)
// ---------------------------------------------------------------------------

const KNOWN_VALUE_KEYS = new Set([
  'text',
  '_temporal',
  '_decay',
  '_provenance',
  '_agent',
  'category',
  'type',
  'importance',
])

// ---------------------------------------------------------------------------
// Column buffers — parallel arrays, one per schema column
// ---------------------------------------------------------------------------

interface ColumnBuffers {
  id: string[]
  namespace: string[]
  key: string[]
  scope_tenant: (string | null)[]
  scope_project: (string | null)[]
  scope_agent: (string | null)[]
  scope_session: (string | null)[]
  text: (string | null)[]
  payload_json: (string | null)[]
  system_created_at: (bigint)[]
  system_expired_at: (bigint | null)[]
  valid_from: (bigint)[]
  valid_until: (bigint | null)[]
  decay_strength: (number | null)[]
  decay_half_life_ms: (number | null)[]
  decay_last_accessed_at: (bigint | null)[]
  decay_access_count: (bigint | null)[]
  agent_id: (string | null)[]
  category: (string | null)[]
  importance: (number | null)[]
  provenance_source: (string | null)[]
  is_active: boolean[]
}

function createEmptyBuffers(): ColumnBuffers {
  return {
    id: [],
    namespace: [],
    key: [],
    scope_tenant: [],
    scope_project: [],
    scope_agent: [],
    scope_session: [],
    text: [],
    payload_json: [],
    system_created_at: [],
    system_expired_at: [],
    valid_from: [],
    valid_until: [],
    decay_strength: [],
    decay_half_life_ms: [],
    decay_last_accessed_at: [],
    decay_access_count: [],
    agent_id: [],
    category: [],
    importance: [],
    provenance_source: [],
    is_active: [],
  }
}

// ---------------------------------------------------------------------------
// FrameBuilder
// ---------------------------------------------------------------------------

/**
 * Accumulates DzipAgent memory records and builds an Arrow Table.
 *
 * Usage:
 * ```ts
 * const builder = new FrameBuilder()
 * builder.add({ text: 'hello' }, { id: '1', namespace: 'notes', key: 'k1' })
 * const table = builder.build()
 * const bytes = builder.toIPC()
 * ```
 *
 * Single-use: after `build()` is called, the builder is consumed and cannot
 * accept more records.
 */
export class FrameBuilder {
  private buffers: ColumnBuffers = createEmptyBuffers()
  private consumed = false

  /** Number of records accumulated so far. */
  get size(): number {
    return this.buffers.id.length
  }

  /**
   * Add a single record.
   *
   * @param value  The record value (may contain _temporal, _decay, etc.)
   * @param meta   Identity + scope metadata
   */
  add(value: FrameRecordValue, meta: FrameRecordMeta): this {
    if (this.consumed) {
      throw new Error('FrameBuilder has already been consumed by build()')
    }

    const b = this.buffers
    const now = BigInt(Date.now())

    // --- Identity ---
    b.id.push(meta.id)
    b.namespace.push(meta.namespace)
    b.key.push(meta.key)

    // --- Scope ---
    b.scope_tenant.push(meta.scope?.tenant ?? null)
    b.scope_project.push(meta.scope?.project ?? null)
    b.scope_agent.push(meta.scope?.agent ?? null)
    b.scope_session.push(meta.scope?.session ?? null)

    // --- Content ---
    b.text.push(value.text ?? null)

    // Overflow: collect all value keys not in KNOWN_VALUE_KEYS
    const overflow: Record<string, unknown> = {}
    let hasOverflow = false
    for (const [k, v] of Object.entries(value)) {
      if (!KNOWN_VALUE_KEYS.has(k)) {
        overflow[k] = v
        hasOverflow = true
      }
    }
    b.payload_json.push(hasOverflow ? JSON.stringify(overflow) : null)

    // --- Temporal ---
    const temporal = value._temporal
    b.system_created_at.push(
      temporal?.systemCreatedAt != null ? BigInt(temporal.systemCreatedAt) : now,
    )
    const expiredAt =
      temporal?.systemExpiredAt != null
        ? BigInt(temporal.systemExpiredAt)
        : null
    b.system_expired_at.push(expiredAt)
    b.valid_from.push(
      temporal?.validFrom != null ? BigInt(temporal.validFrom) : now,
    )
    b.valid_until.push(
      temporal?.validUntil != null ? BigInt(temporal.validUntil) : null,
    )

    // --- Decay ---
    const decay = value._decay
    b.decay_strength.push(decay?.strength ?? null)
    b.decay_half_life_ms.push(decay?.halfLifeMs ?? null)
    b.decay_last_accessed_at.push(
      decay?.lastAccessedAt != null ? BigInt(decay.lastAccessedAt) : null,
    )
    b.decay_access_count.push(
      decay?.accessCount != null ? BigInt(decay.accessCount) : null,
    )

    // --- Provenance ---
    const agentId = value._agent ?? value._provenance?.createdBy ?? null
    b.agent_id.push(agentId)
    b.category.push(value.category ?? value.type ?? null)
    b.importance.push(value.importance ?? null)
    b.provenance_source.push(value._provenance?.source ?? null)

    // --- Flags ---
    b.is_active.push(expiredAt === null)

    return this
  }

  /**
   * Add multiple records at once.
   */
  addBatch(
    records: ReadonlyArray<{ value: FrameRecordValue; meta: FrameRecordMeta }>,
  ): this {
    for (const rec of records) {
      this.add(rec.value, rec.meta)
    }
    return this
  }

  /**
   * Build the Arrow Table from accumulated records.
   *
   * This is a single-use operation; the builder is consumed after this call.
   */
  build(): Table {
    if (this.consumed) {
      throw new Error('FrameBuilder has already been consumed by build()')
    }
    this.consumed = true

    const b = this.buffers

    return tableFromArrays({
      id: b.id,
      namespace: b.namespace,
      key: b.key,
      scope_tenant: b.scope_tenant,
      scope_project: b.scope_project,
      scope_agent: b.scope_agent,
      scope_session: b.scope_session,
      text: b.text,
      payload_json: b.payload_json,
      system_created_at: b.system_created_at,
      system_expired_at: b.system_expired_at,
      valid_from: b.valid_from,
      valid_until: b.valid_until,
      decay_strength: b.decay_strength,
      decay_half_life_ms: b.decay_half_life_ms,
      decay_last_accessed_at: b.decay_last_accessed_at,
      decay_access_count: b.decay_access_count,
      agent_id: b.agent_id,
      category: b.category,
      importance: b.importance,
      provenance_source: b.provenance_source,
      is_active: b.is_active,
    })
  }

  /**
   * Build and serialize to IPC bytes (convenience).
   */
  toIPC(): Uint8Array {
    return serializeToIPC(this.build())
  }

  /**
   * Build and copy to a SharedArrayBuffer (for worker threads).
   */
  toSharedBuffer(): SharedArrayBuffer {
    const ipc = this.toIPC()
    const shared = new SharedArrayBuffer(ipc.byteLength)
    const view = new Uint8Array(shared)
    view.set(ipc)
    return shared
  }
}
