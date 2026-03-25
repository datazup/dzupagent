/**
 * Shared column builder for all adapters.
 * Collects column arrays and builds an Arrow Table via tableFromArrays().
 */

import { tableFromArrays, type Table } from 'apache-arrow'

/**
 * Mutable column arrays matching the MemoryFrame schema.
 * Adapters push values into these arrays, then call `buildTable()`.
 */
export interface FrameColumnArrays {
  id: string[]
  namespace: string[]
  key: string[]
  scope_tenant: (string | null)[]
  scope_project: (string | null)[]
  scope_agent: (string | null)[]
  scope_session: (string | null)[]
  text: (string | null)[]
  payload_json: (string | null)[]
  system_created_at: bigint[]
  system_expired_at: (bigint | null)[]
  valid_from: bigint[]
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

/**
 * Create empty column arrays ready for population.
 */
export function createEmptyColumns(): FrameColumnArrays {
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

/**
 * Build an Arrow Table from populated column arrays.
 */
export function buildTable(cols: FrameColumnArrays): Table {
  return tableFromArrays({
    id: cols.id,
    namespace: cols.namespace,
    key: cols.key,
    scope_tenant: cols.scope_tenant,
    scope_project: cols.scope_project,
    scope_agent: cols.scope_agent,
    scope_session: cols.scope_session,
    text: cols.text,
    payload_json: cols.payload_json,
    system_created_at: cols.system_created_at,
    system_expired_at: cols.system_expired_at,
    valid_from: cols.valid_from,
    valid_until: cols.valid_until,
    decay_strength: cols.decay_strength,
    decay_half_life_ms: cols.decay_half_life_ms,
    decay_last_accessed_at: cols.decay_last_accessed_at,
    decay_access_count: cols.decay_access_count,
    agent_id: cols.agent_id,
    category: cols.category,
    importance: cols.importance,
    provenance_source: cols.provenance_source,
    is_active: cols.is_active,
  })
}

/**
 * Push default/null values for columns that many adapters do not map.
 * Pushes null for decay columns, null for system_expired_at/valid_until,
 * true for is_active, 'imported' for provenance_source.
 */
export function pushDefaults(
  cols: FrameColumnArrays,
  overrides?: {
    scopeProject?: string | null
    scopeSession?: string | null
    scopeAgent?: string | null
    agentId?: string | null
    category?: string | null
    importance?: number | null
  },
): void {
  cols.system_expired_at.push(null)
  cols.valid_until.push(null)
  cols.decay_strength.push(null)
  cols.decay_half_life_ms.push(null)
  cols.decay_last_accessed_at.push(null)
  cols.decay_access_count.push(null)
  cols.provenance_source.push('imported')
  cols.is_active.push(true)

  if (overrides) {
    if (overrides.scopeProject !== undefined) {
      // Already pushed by caller
    }
    if (overrides.category !== undefined) {
      // Already pushed by caller
    }
  }
}

/**
 * Safely parse an ISO date string to epoch milliseconds.
 * Returns fallback (default: Date.now()) on invalid input.
 */
export function safeParseDate(dateStr: string, fallback?: number): number {
  const ms = Date.parse(dateStr)
  if (Number.isNaN(ms)) return fallback ?? Date.now()
  return ms
}

/**
 * Read a string column value from an Arrow Table row.
 */
export function getString(table: Table, col: string, row: number): string | null {
  const child = table.getChild(col)
  if (!child) return null
  const val = child.get(row) as string | null | undefined
  return val ?? null
}

/**
 * Read a bigint column value from an Arrow Table row.
 */
export function getBigInt(table: Table, col: string, row: number): bigint | null {
  const child = table.getChild(col)
  if (!child) return null
  const val = child.get(row) as bigint | null | undefined
  return val ?? null
}

/**
 * Read a number (float64) column value from an Arrow Table row.
 */
export function getFloat(table: Table, col: string, row: number): number | null {
  const child = table.getChild(col)
  if (!child) return null
  const val = child.get(row) as number | null | undefined
  return val ?? null
}
