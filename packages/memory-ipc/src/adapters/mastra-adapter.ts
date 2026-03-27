/**
 * Mastra observation <-> MemoryFrame bidirectional adapter.
 *
 * Converts Mastra's observation records (from @mastra/memory) to and from
 * Arrow Tables conforming to the MemoryFrame schema.
 */

import type { Table } from 'apache-arrow'
import type { MemoryFrameAdapter, AdapterValidationResult } from './adapter-interface.js'
import { createEmptyColumns, buildTable, safeParseDate, getString, getBigInt, getFloat } from './frame-columns.js'

/**
 * Mastra observation record — mirrors @mastra/memory's format.
 * We define our own type to avoid a runtime dependency.
 */
export interface MastraObservation {
  content: string
  date: string
  priority: number
  threadId: string
  resourceId: string
  agentId?: string
  tags?: string[]
  id?: string
  createdAt?: string
}

export class MastraAdapter implements MemoryFrameAdapter<MastraObservation> {
  readonly sourceSystem = 'mastra'

  readonly fieldMapping: Record<string, string> = {
    id: 'id',
    namespace: '"observations" (static)',
    key: 'id',
    scope_tenant: 'resourceId',
    scope_session: 'threadId',
    scope_agent: 'agentId',
    text: 'content',
    payload_json: 'JSON.stringify({ tags })',
    system_created_at: 'Date.parse(createdAt)',
    valid_from: 'Date.parse(date)',
    importance: 'priority / 5.0',
    category: '"observation" (static)',
    agent_id: 'agentId',
    provenance_source: '"imported" (static)',
  }

  canAdapt(record: unknown): record is MastraObservation {
    if (record === null || typeof record !== 'object') return false
    const r = record as Record<string, unknown>
    return (
      typeof r['content'] === 'string' &&
      typeof r['date'] === 'string' &&
      typeof r['priority'] === 'number' &&
      typeof r['threadId'] === 'string' &&
      typeof r['resourceId'] === 'string'
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
        if (r.priority < 1 || r.priority > 5) {
          warnings.push({
            index: i,
            field: 'priority',
            message: `Priority ${String(r.priority)} outside expected range 1-5, will be clamped`,
          })
        }
        if (r.date && Number.isNaN(Date.parse(r.date))) {
          warnings.push({
            index: i,
            field: 'date',
            message: `Invalid date format: ${r.date}`,
          })
        }
      } else {
        invalid++
        if (r === null || typeof r !== 'object') {
          warnings.push({ index: i, field: '*', message: 'Record is not an object' })
        } else {
          const obj = r as Record<string, unknown>
          if (typeof obj['content'] !== 'string')
            warnings.push({ index: i, field: 'content', message: 'Missing or non-string content' })
          if (typeof obj['date'] !== 'string')
            warnings.push({ index: i, field: 'date', message: 'Missing or non-string date' })
          if (typeof obj['priority'] !== 'number')
            warnings.push({ index: i, field: 'priority', message: 'Missing or non-number priority' })
          if (typeof obj['threadId'] !== 'string')
            warnings.push({ index: i, field: 'threadId', message: 'Missing or non-string threadId' })
          if (typeof obj['resourceId'] !== 'string')
            warnings.push({ index: i, field: 'resourceId', message: 'Missing or non-string resourceId' })
        }
      }
    }

    return { valid, invalid, warnings }
  }

  toFrame(records: MastraObservation[]): Table {
    const now = Date.now()
    const cols = createEmptyColumns()

    for (let i = 0; i < records.length; i++) {
      const obs = records[i]!
      const id = obs.id ?? `mastra-obs-${String(i)}-${String(now)}`
      const createdMs = obs.createdAt ? safeParseDate(obs.createdAt, now) : now
      const validMs = safeParseDate(obs.date, now)

      cols.id.push(id)
      cols.namespace.push('observations')
      cols.key.push(id)
      cols.scope_tenant.push(obs.resourceId)
      cols.scope_session.push(obs.threadId)
      cols.scope_agent.push(obs.agentId ?? null)
      cols.scope_project.push(null)
      cols.text.push(obs.content)
      cols.payload_json.push(
        obs.tags && obs.tags.length > 0 ? JSON.stringify({ tags: obs.tags }) : null,
      )
      cols.system_created_at.push(BigInt(createdMs))
      cols.system_expired_at.push(null)
      cols.valid_from.push(BigInt(validMs))
      cols.valid_until.push(null)
      cols.decay_strength.push(null)
      cols.decay_half_life_ms.push(null)
      cols.decay_last_accessed_at.push(null)
      cols.decay_access_count.push(null)
      cols.agent_id.push(obs.agentId ?? null)
      cols.category.push('observation')
      cols.importance.push(Math.max(0, Math.min(1, obs.priority / 5.0)))
      cols.provenance_source.push('imported')
      cols.is_active.push(true)
    }

    return buildTable(cols)
  }

  fromFrame(table: Table): MastraObservation[] {
    const results: MastraObservation[] = []
    const numRows = table.numRows

    for (let i = 0; i < numRows; i++) {
      const content = getString(table, 'text', i)
      if (content === null) continue

      const validFrom = getBigInt(table, 'valid_from', i)
      const importance = getFloat(table, 'importance', i)
      const priority =
        importance !== null ? Math.max(1, Math.min(5, Math.round(importance * 5))) : 3

      const obs: MastraObservation = {
        content,
        date:
          validFrom !== null
            ? new Date(Number(validFrom)).toISOString()
            : new Date().toISOString(),
        priority,
        threadId: getString(table, 'scope_session', i) ?? 'unknown',
        resourceId: getString(table, 'scope_tenant', i) ?? 'unknown',
      }

      const agentId = getString(table, 'scope_agent', i)
      if (agentId !== null) obs.agentId = agentId

      const id = getString(table, 'id', i)
      if (id !== null) obs.id = id

      const created = getBigInt(table, 'system_created_at', i)
      if (created !== null) obs.createdAt = new Date(Number(created)).toISOString()

      const payload = getString(table, 'payload_json', i)
      if (payload !== null) {
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>
          if (Array.isArray(parsed['tags'])) {
            obs.tags = parsed['tags'] as string[]
          }
        } catch {
          // Non-fatal: payload parse failure is ignored
        }
      }

      results.push(obs)
    }

    return results
  }
}
