/**
 * LangGraph Store item <-> MemoryFrame bidirectional adapter.
 *
 * Converts LangGraph's namespace-tuple-keyed store items to and from
 * Arrow Tables conforming to the MemoryFrame schema.
 */

import type { Table } from 'apache-arrow'
import type { MemoryFrameAdapter, AdapterValidationResult } from './adapter-interface.js'
import { createEmptyColumns, buildTable, getString, getBigInt } from './frame-columns.js'

/**
 * LangGraph store item — mirrors the StoreItem from @langchain/langgraph.
 * We define our own type to avoid a runtime dependency.
 */
export interface LangGraphStoreItem {
  value: Record<string, unknown>
  key: string
  namespace: string[]
  createdAt: Date
  updatedAt: Date
  score?: number
}

export class LangGraphAdapter implements MemoryFrameAdapter<LangGraphStoreItem> {
  readonly sourceSystem = 'langgraph'

  readonly fieldMapping: Record<string, string> = {
    id: 'key',
    namespace: 'namespace[1]',
    key: 'key',
    scope_tenant: 'namespace[0]',
    scope_project: 'namespace[2]',
    text: 'value.text',
    payload_json: 'JSON.stringify(remainingValueFields)',
    system_created_at: 'createdAt.getTime()',
    valid_from: 'createdAt.getTime()',
  }

  canAdapt(record: unknown): record is LangGraphStoreItem {
    if (record === null || typeof record !== 'object') return false
    const r = record as Record<string, unknown>
    return (
      typeof r['key'] === 'string' &&
      Array.isArray(r['namespace']) &&
      typeof r['value'] === 'object' &&
      r['value'] !== null &&
      r['createdAt'] instanceof Date
    )
  }

  validate(records: unknown[]): AdapterValidationResult {
    let valid = 0
    let invalid = 0
    const warnings: AdapterValidationResult['warnings'] = []

    for (let i = 0; i < records.length; i++) {
      if (this.canAdapt(records[i])) {
        valid++
        const item = records[i] as LangGraphStoreItem
        if (item.namespace.length < 2) {
          warnings.push({
            index: i,
            field: 'namespace',
            message: 'Namespace tuple has fewer than 2 elements; namespace column will be empty',
          })
        }
      } else {
        invalid++
        warnings.push({
          index: i,
          field: '*',
          message: 'Does not match LangGraphStoreItem shape',
        })
      }
    }

    return { valid, invalid, warnings }
  }

  toFrame(records: LangGraphStoreItem[]): Table {
    const cols = createEmptyColumns()

    for (const item of records) {
      const createdMs = item.createdAt.getTime()

      // Extract text from value, remaining fields go to payload_json
      const { text, ...remaining } = item.value as Record<string, unknown> & { text?: string }
      const hasRemaining = Object.keys(remaining).length > 0

      // Extract importance/category from value if present
      const importance =
        typeof remaining['importance'] === 'number'
          ? remaining['importance']
          : typeof remaining['confidence'] === 'number'
            ? remaining['confidence']
            : null
      const category =
        typeof remaining['category'] === 'string'
          ? remaining['category']
          : typeof remaining['type'] === 'string'
            ? remaining['type']
            : null

      cols.id.push(item.key)
      cols.namespace.push(item.namespace[1] ?? '')
      cols.key.push(item.key)
      cols.scope_tenant.push(item.namespace[0] ?? null)
      cols.scope_project.push(item.namespace[2] ?? null)
      cols.scope_agent.push(null)
      cols.scope_session.push(null)
      cols.text.push(typeof text === 'string' ? text : null)
      cols.payload_json.push(hasRemaining ? JSON.stringify(remaining) : null)
      cols.system_created_at.push(BigInt(createdMs))
      cols.system_expired_at.push(null)
      cols.valid_from.push(BigInt(createdMs))
      cols.valid_until.push(null)
      cols.decay_strength.push(null)
      cols.decay_half_life_ms.push(null)
      cols.decay_last_accessed_at.push(null)
      cols.decay_access_count.push(null)
      cols.agent_id.push(null)
      cols.category.push(category)
      cols.importance.push(importance)
      cols.provenance_source.push('imported')
      cols.is_active.push(true)
    }

    return buildTable(cols)
  }

  fromFrame(table: Table): LangGraphStoreItem[] {
    const results: LangGraphStoreItem[] = []
    const numRows = table.numRows

    for (let i = 0; i < numRows; i++) {
      const key = getString(table, 'key', i)
      if (key === null) continue

      const tenant = getString(table, 'scope_tenant', i)
      const ns = getString(table, 'namespace', i)
      const project = getString(table, 'scope_project', i)
      const text = getString(table, 'text', i)
      const payload = getString(table, 'payload_json', i)
      const created = getBigInt(table, 'system_created_at', i)

      // Reconstruct namespace tuple
      const namespace: string[] = []
      if (tenant !== null) namespace.push(tenant)
      if (ns !== null) namespace.push(ns)
      if (project !== null) namespace.push(project)

      // Reconstruct value
      const value: Record<string, unknown> = {}
      if (text !== null) value['text'] = text
      if (payload !== null) {
        try {
          Object.assign(value, JSON.parse(payload) as Record<string, unknown>)
        } catch {
          // Non-fatal: payload parse failure
        }
      }

      const createdAt = created !== null ? new Date(Number(created)) : new Date()

      results.push({
        key,
        namespace,
        value,
        createdAt,
        updatedAt: createdAt,
      })
    }

    return results
  }
}
