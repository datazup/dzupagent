/**
 * Letta/MemGPT archival passage <-> MemoryFrame bidirectional adapter.
 *
 * Converts Letta's archival memory passages to and from Arrow Tables
 * conforming to the MemoryFrame schema. Also provides core memory <->
 * working memory conversion helpers.
 */

import type { Table } from 'apache-arrow'
import type { MemoryFrameAdapter, AdapterValidationResult } from './adapter-interface.js'
import { createEmptyColumns, buildTable, safeParseDate, getString, getBigInt } from './frame-columns.js'

/**
 * Letta archival passage — mirrors letta-client's ArchivalMemory passage type.
 */
export interface LettaArchivalPassage {
  id: string
  text: string
  embedding?: number[]
  agent_id: string
  created_at: string
  metadata?: Record<string, unknown>
}

/**
 * Letta core memory block — self-editing memory blocks.
 */
export interface LettaCoreMemoryBlock {
  label: string
  value: string
  limit: number
}

/**
 * Letta core memory — collection of self-editing blocks.
 */
export interface LettaCoreMemory {
  blocks: LettaCoreMemoryBlock[]
}

export class LettaAdapter implements MemoryFrameAdapter<LettaArchivalPassage> {
  readonly sourceSystem = 'letta'

  readonly fieldMapping: Record<string, string> = {
    id: 'id',
    text: 'text',
    scope_agent: 'agent_id',
    system_created_at: 'Date.parse(created_at)',
    payload_json: 'JSON.stringify({ metadata, embedding })',
  }

  canAdapt(record: unknown): record is LettaArchivalPassage {
    if (record === null || typeof record !== 'object') return false
    const r = record as Record<string, unknown>
    return (
      typeof r['id'] === 'string' &&
      typeof r['text'] === 'string' &&
      typeof r['agent_id'] === 'string' &&
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
          if (typeof obj['text'] !== 'string')
            warnings.push({ index: i, field: 'text', message: 'Missing or non-string text' })
          if (typeof obj['agent_id'] !== 'string')
            warnings.push({ index: i, field: 'agent_id', message: 'Missing or non-string agent_id' })
          if (typeof obj['created_at'] !== 'string')
            warnings.push({ index: i, field: 'created_at', message: 'Missing or non-string created_at' })
        }
      }
    }

    return { valid, invalid, warnings }
  }

  toFrame(records: LettaArchivalPassage[]): Table {
    const now = Date.now()
    const cols = createEmptyColumns()

    for (const passage of records) {
      const createdMs = safeParseDate(passage.created_at, now)

      // Build payload: metadata + embedding (if present)
      const payloadParts: Record<string, unknown> = {}
      if (passage.metadata && Object.keys(passage.metadata).length > 0) {
        payloadParts['metadata'] = passage.metadata
      }
      if (passage.embedding && passage.embedding.length > 0) {
        payloadParts['embedding'] = passage.embedding
      }
      const payloadJson =
        Object.keys(payloadParts).length > 0 ? JSON.stringify(payloadParts) : null

      cols.id.push(passage.id)
      cols.namespace.push('archival')
      cols.key.push(passage.id)
      cols.scope_tenant.push(null)
      cols.scope_project.push(null)
      cols.scope_agent.push(passage.agent_id)
      cols.scope_session.push(null)
      cols.text.push(passage.text)
      cols.payload_json.push(payloadJson)
      cols.system_created_at.push(BigInt(createdMs))
      cols.system_expired_at.push(null)
      cols.valid_from.push(BigInt(createdMs))
      cols.valid_until.push(null)
      cols.decay_strength.push(null)
      cols.decay_half_life_ms.push(null)
      cols.decay_last_accessed_at.push(null)
      cols.decay_access_count.push(null)
      cols.agent_id.push(passage.agent_id)
      cols.category.push('archival')
      cols.importance.push(null)
      cols.provenance_source.push('imported')
      cols.is_active.push(true)
    }

    return buildTable(cols)
  }

  fromFrame(table: Table): LettaArchivalPassage[] {
    const results: LettaArchivalPassage[] = []
    const numRows = table.numRows

    for (let i = 0; i < numRows; i++) {
      const id = getString(table, 'id', i)
      const text = getString(table, 'text', i)
      if (!id || !text) continue

      const agent = getString(table, 'scope_agent', i)
      const created = getBigInt(table, 'system_created_at', i)

      const passage: LettaArchivalPassage = {
        id,
        text,
        agent_id: agent ?? 'unknown',
        created_at:
          created !== null
            ? new Date(Number(created)).toISOString()
            : new Date().toISOString(),
      }

      const payload = getString(table, 'payload_json', i)
      if (payload !== null) {
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>
          if (parsed['metadata'] && typeof parsed['metadata'] === 'object') {
            passage.metadata = parsed['metadata'] as Record<string, unknown>
          }
          if (Array.isArray(parsed['embedding'])) {
            passage.embedding = parsed['embedding'] as number[]
          }
        } catch {
          // Non-fatal: payload parse failure
        }
      }

      results.push(passage)
    }

    return results
  }
}

/**
 * Convert Letta core memory blocks to a WorkingMemory-compatible record.
 *
 * Each block's `label` becomes a key in the output record, with the block's
 * `value` as the string content.
 *
 * @param coreMemory  Letta core memory with self-editing blocks
 * @returns           Record suitable for DzipAgent WorkingMemory
 */
export function lettaCoreToWorkingMemory(
  coreMemory: LettaCoreMemory,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const block of coreMemory.blocks) {
    result[block.label] = block.value
  }
  return result
}

/**
 * Convert a DzipAgent WorkingMemory record to Letta core memory blocks.
 *
 * Each top-level field becomes a block with `label=fieldName`.
 * Non-string values are JSON-serialized. Values exceeding `blockLimit`
 * are truncated.
 *
 * @param workingMemory  DzipAgent WorkingMemory state
 * @param blockLimit     Max characters per block (default: 2000)
 * @returns              Letta core memory with blocks
 */
export function workingMemoryToLettaCore(
  workingMemory: Record<string, unknown>,
  blockLimit = 2000,
): LettaCoreMemory {
  const blocks: LettaCoreMemoryBlock[] = []

  for (const [label, raw] of Object.entries(workingMemory)) {
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw)
    const truncated = value.length > blockLimit ? value.slice(0, blockLimit) : value

    blocks.push({
      label,
      value: truncated,
      limit: blockLimit,
    })
  }

  return { blocks }
}
