/**
 * Canonical Arrow schema for DzipAgent memory frames.
 *
 * Defines the 21-column schema used for zero-copy IPC between agents.
 * Dictionary-encoded columns (namespace, agent_id, category, provenance_source)
 * compress repeated string values efficiently.
 *
 * All timestamps are Int64 milliseconds since epoch (stored as BigInt).
 */

import {
  Schema,
  Field,
  Utf8,
  Int32,
  Int64,
  Float64,
  Bool,
  Dictionary,
} from 'apache-arrow'

/** Current schema version. Stored as schema-level metadata. */
export const MEMORY_FRAME_VERSION = 1

/**
 * Canonical Arrow schema for memory frames.
 *
 * Columns:
 * - Identity: id, namespace, key
 * - Scope: scope_tenant, scope_project, scope_agent, scope_session
 * - Content: text, payload_json
 * - Temporal: system_created_at, system_expired_at, valid_from, valid_until
 * - Decay: decay_strength, decay_half_life_ms, decay_last_accessed_at, decay_access_count
 * - Provenance: agent_id, category, importance, provenance_source
 * - Flags: is_active
 */
export const MEMORY_FRAME_SCHEMA = new Schema(
  [
    // --- Identity ---
    new Field('id', new Utf8(), false),
    new Field('namespace', new Dictionary(new Utf8(), new Int32()), false),
    new Field('key', new Utf8(), false),

    // --- Scope ---
    new Field('scope_tenant', new Utf8(), true),
    new Field('scope_project', new Utf8(), true),
    new Field('scope_agent', new Utf8(), true),
    new Field('scope_session', new Utf8(), true),

    // --- Content ---
    new Field('text', new Utf8(), true),
    new Field('payload_json', new Utf8(), true),

    // --- Temporal (ms since epoch) ---
    new Field('system_created_at', new Int64(), false),
    new Field('system_expired_at', new Int64(), true),
    new Field('valid_from', new Int64(), false),
    new Field('valid_until', new Int64(), true),

    // --- Decay ---
    new Field('decay_strength', new Float64(), true),
    new Field('decay_half_life_ms', new Float64(), true),
    new Field('decay_last_accessed_at', new Int64(), true),
    new Field('decay_access_count', new Int64(), true),

    // --- Provenance ---
    new Field('agent_id', new Dictionary(new Utf8(), new Int32()), true),
    new Field('category', new Dictionary(new Utf8(), new Int32()), true),
    new Field('importance', new Float64(), true),
    new Field('provenance_source', new Dictionary(new Utf8(), new Int32()), true),

    // --- Flags ---
    new Field('is_active', new Bool(), false),
  ],
  new Map([['memory_frame_version', String(MEMORY_FRAME_VERSION)]]),
)

/** Column names in the schema, in order. */
export const MEMORY_FRAME_COLUMNS = MEMORY_FRAME_SCHEMA.fields.map(
  (f) => f.name,
) as readonly string[]

/** Type for column name literals. */
export type MemoryFrameColumn = (typeof MEMORY_FRAME_COLUMNS)[number]

/** Number of columns in the schema. */
export const MEMORY_FRAME_FIELD_COUNT = MEMORY_FRAME_SCHEMA.fields.length
