/**
 * Mem0 memory <-> MemoryFrame bidirectional adapter.
 *
 * Converts Mem0's memory records (from the mem0ai package) to and from
 * Arrow Tables conforming to the MemoryFrame schema.
 */

import type { Table } from 'apache-arrow'
import type { MemoryFrameAdapter, AdapterValidationResult } from './adapter-interface.js'
import { createEmptyColumns, buildTable, safeParseDate, getString, getBigInt } from './frame-columns.js'

/**
 * Mem0 memory record — mirrors the mem0ai package's format.
 */
export interface Mem0Memory {
  id: string
  memory: string
  user_id: string
  agent_id?: string
  metadata?: Record<string, unknown>
  created_at: string
  updated_at: string
  hash?: string
  categories?: string[]
}

export class Mem0Adapter implements MemoryFrameAdapter<Mem0Memory> {
  readonly sourceSystem = 'mem0'

  readonly fieldMapping: Record<string, string> = {
    id: 'id',
    text: 'memory',
    scope_tenant: 'user_id',
    scope_agent: 'agent_id',
    system_created_at: 'Date.parse(created_at)',
    category: 'categories[0]',
    payload_json: 'JSON.stringify({ metadata, categories, hash })',
  }

  canAdapt(record: unknown): record is Mem0Memory {
    if (record === null || typeof record !== 'object') return false
    const r = record as Record<string, unknown>
    return (
      typeof r['id'] === 'string' &&
      typeof r['memory'] === 'string' &&
      typeof r['user_id'] === 'string' &&
      typeof r['created_at'] === 'string'
    )
  }

  validate(records: unknown[]): AdapterValidationResult {
    let valid = 0
    let invalid = 0
    const warnings: AdapterValidationResult['warnings'] = []

    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      if (this.canAdapt(r)) {
        valid++
        if (r.created_at && Number.isNaN(Date.parse(r.created_at))) {
          warnings.push({
            index: i,
            field: 'created_at',
            message: `Invalid date format: ${r.created_at}`,
          })
        }
      } else {
        invalid++
        if (r === null || typeof r !== 'object') {
          warnings.push({ index: i, field: '*', message: 'Record is not an object' })
        } else {
          const obj = r as Record<string, unknown>
          if (typeof obj['id'] !== 'string')
            warnings.push({ index: i, field: 'id', message: 'Missing or non-string id' })
          if (typeof obj['memory'] !== 'string')
            warnings.push({ index: i, field: 'memory', message: 'Missing or non-string memory' })
          if (typeof obj['user_id'] !== 'string')
            warnings.push({ index: i, field: 'user_id', message: 'Missing or non-string user_id' })
          if (typeof obj['created_at'] !== 'string')
            warnings.push({ index: i, field: 'created_at', message: 'Missing or non-string created_at' })
        }
      }
    }

    return { valid, invalid, warnings }
  }

  toFrame(records: Mem0Memory[]): Table {
    const now = Date.now()
    const cols = createEmptyColumns()

    for (const mem of records) {
      const createdMs = safeParseDate(mem.created_at, now)

      // Build payload_json from metadata, remaining categories, and hash
      const payloadParts: Record<string, unknown> = {}
      if (mem.metadata && Object.keys(mem.metadata).length > 0) {
        payloadParts['metadata'] = mem.metadata
      }
      if (mem.categories && mem.categories.length > 0) {
        payloadParts['categories'] = mem.categories
      }
      if (mem.hash) {
        payloadParts['hash'] = mem.hash
      }
      const payloadJson =
        Object.keys(payloadParts).length > 0 ? JSON.stringify(payloadParts) : null

      // Extract importance from metadata if present
      const importance =
        mem.metadata && typeof mem.metadata['importance'] === 'number'
          ? mem.metadata['importance']
          : null

      // First category becomes the Arrow category column
      const category = mem.categories?.[0] ?? 'semantic'

      cols.id.push(mem.id)
      cols.namespace.push('mem0-memories')
      cols.key.push(mem.id)
      cols.scope_tenant.push(mem.user_id)
      cols.scope_project.push(null)
      cols.scope_agent.push(mem.agent_id ?? null)
      cols.scope_session.push(null)
      cols.text.push(mem.memory)
      cols.payload_json.push(payloadJson)
      cols.system_created_at.push(BigInt(createdMs))
      cols.system_expired_at.push(null)
      cols.valid_from.push(BigInt(createdMs))
      cols.valid_until.push(null)
      cols.decay_strength.push(null)
      cols.decay_half_life_ms.push(null)
      cols.decay_last_accessed_at.push(null)
      cols.decay_access_count.push(null)
      cols.agent_id.push(mem.agent_id ?? null)
      cols.category.push(category)
      cols.importance.push(importance)
      cols.provenance_source.push('imported')
      cols.is_active.push(true)
    }

    return buildTable(cols)
  }

  fromFrame(table: Table): Mem0Memory[] {
    const results: Mem0Memory[] = []
    const numRows = table.numRows

    for (let i = 0; i < numRows; i++) {
      const id = getString(table, 'id', i)
      const text = getString(table, 'text', i)
      if (!id || !text) continue

      const tenant = getString(table, 'scope_tenant', i)
      const agent = getString(table, 'scope_agent', i)
      const created = getBigInt(table, 'system_created_at', i)

      const createdIso =
        created !== null
          ? new Date(Number(created)).toISOString()
          : new Date().toISOString()

      const mem: Mem0Memory = {
        id,
        memory: text,
        user_id: tenant ?? 'unknown',
        created_at: createdIso,
        updated_at: createdIso,
      }

      if (agent !== null) mem.agent_id = agent

      const payload = getString(table, 'payload_json', i)
      if (payload !== null) {
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>
          if (parsed['metadata'] && typeof parsed['metadata'] === 'object') {
            mem.metadata = parsed['metadata'] as Record<string, unknown>
          }
          if (Array.isArray(parsed['categories'])) {
            mem.categories = parsed['categories'] as string[]
          }
          if (typeof parsed['hash'] === 'string') {
            mem.hash = parsed['hash']
          }
        } catch {
          // Non-fatal: payload parse failure
        }
      }

      results.push(mem)
    }

    return results
  }
}
