/**
 * ProvenanceWriter — wraps MemoryService writes to auto-inject provenance metadata.
 *
 * Usage:
 *   const writer = new ProvenanceWriter(memoryService)
 *   await writer.put('decisions', { projectId: 'p1' }, 'feat-1', value, {
 *     agentUri: 'forge://acme/planner',
 *   })
 */
import { createHash } from 'node:crypto'
import type { MemoryService } from '../memory-service.js'
import type {
  MemoryProvenance,
  ProvenanceWriteOptions,
  ProvenanceQuery,
} from './types.js'

const PROVENANCE_KEY = '_provenance' as const

/**
 * ProvenanceWriter wraps memory writes to auto-inject provenance metadata.
 */
export class ProvenanceWriter {
  constructor(private readonly memoryService: MemoryService) {}

  /**
   * Write a record with auto-injected provenance.
   */
  async put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
    options: ProvenanceWriteOptions,
  ): Promise<void> {
    const provenance = createProvenance(options, value)
    const enriched: Record<string, unknown> = {
      ...value,
      [PROVENANCE_KEY]: provenance,
    }
    await this.memoryService.put(namespace, scope, key, enriched)
  }

  /**
   * Extend provenance lineage when an agent modifies an existing record.
   * Appends the agent URI to the lineage chain and updates the content hash.
   */
  async extendProvenance(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    agentUri: string,
  ): Promise<void> {
    const records = await this.memoryService.get(namespace, scope, key)
    if (records.length === 0) return

    const record = records[0]
    if (!record) return

    const existing = extractProvenance(record)
    if (!existing) return

    // Avoid duplicate consecutive entries
    const lastAgent = existing.lineage[existing.lineage.length - 1]
    const updatedLineage = lastAgent === agentUri
      ? existing.lineage
      : [...existing.lineage, agentUri]

    // Recompute content hash for the record without provenance
    const { [PROVENANCE_KEY]: _prov, ...contentOnly } = record
    const updatedProvenance: MemoryProvenance = {
      ...existing,
      lineage: updatedLineage,
      contentHash: createContentHash(contentOnly),
    }

    const enriched: Record<string, unknown> = {
      ...record,
      [PROVENANCE_KEY]: updatedProvenance,
    }
    await this.memoryService.put(namespace, scope, key, enriched)
  }

  /**
   * Query records by provenance metadata.
   * Retrieves all records in a namespace and filters by provenance fields.
   */
  async getByProvenance(
    namespace: string,
    scope: Record<string, string>,
    query: ProvenanceQuery,
  ): Promise<Array<{ key: string; value: Record<string, unknown> }>> {
    // Retrieve all records in the namespace
    const records = await this.memoryService.get(namespace, scope)
    const results: Array<{ key: string; value: Record<string, unknown> }> = []

    for (const record of records) {
      const provenance = extractProvenance(record)
      if (!provenance) continue

      if (!matchesProvenanceQuery(provenance, query)) continue

      // Derive key from the record — use _key if available, else generate index-based
      const key = typeof record['_key'] === 'string'
        ? record['_key']
        : `record-${results.length}`

      results.push({ key, value: record })
    }

    return results
  }

  /**
   * Get the full lineage chain for a record.
   * Returns an empty array if the record has no provenance.
   */
  async getLineage(
    namespace: string,
    scope: Record<string, string>,
    key: string,
  ): Promise<string[]> {
    const records = await this.memoryService.get(namespace, scope, key)
    if (records.length === 0) return []

    const record = records[0]
    if (!record) return []

    const provenance = extractProvenance(record)
    return provenance?.lineage ?? []
  }
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Create a SHA-256 content hash for integrity verification.
 * Uses JSON.stringify with sorted keys for deterministic hashing.
 */
export function createContentHash(content: unknown): string {
  const canonical = JSON.stringify(content, sortedReplacer)
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Create initial provenance metadata.
 */
export function createProvenance(
  options: ProvenanceWriteOptions,
  content: unknown,
): MemoryProvenance {
  const source = options.source ?? 'direct'
  const confidence = options.confidence ?? 1.0

  const provenance: MemoryProvenance = {
    createdBy: options.agentUri,
    createdAt: new Date().toISOString(),
    source,
    confidence: Math.max(0, Math.min(1, confidence)),
    contentHash: createContentHash(content),
    lineage: [options.agentUri],
  }

  if (options.derivedFrom && options.derivedFrom.length > 0) {
    provenance.derivedFrom = options.derivedFrom
  }

  return provenance
}

/**
 * Extract provenance from a record's value, if present.
 * Returns undefined when the record does not carry _provenance metadata.
 */
export function extractProvenance(
  value: Record<string, unknown>,
): MemoryProvenance | undefined {
  const raw = value[PROVENANCE_KEY]
  if (raw == null || typeof raw !== 'object') return undefined

  const p = raw as Record<string, unknown>

  // Validate required fields
  if (
    typeof p['createdBy'] !== 'string' ||
    typeof p['createdAt'] !== 'string' ||
    typeof p['source'] !== 'string' ||
    typeof p['confidence'] !== 'number' ||
    typeof p['contentHash'] !== 'string' ||
    !Array.isArray(p['lineage'])
  ) {
    return undefined
  }

  return raw as unknown as MemoryProvenance
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * JSON replacer that sorts object keys for deterministic serialization.
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k]
    }
    return sorted
  }
  return value
}

/**
 * Check if a provenance record matches the given query filters.
 */
function matchesProvenanceQuery(
  provenance: MemoryProvenance,
  query: ProvenanceQuery,
): boolean {
  if (query.createdBy !== undefined && provenance.createdBy !== query.createdBy) {
    return false
  }
  if (query.source !== undefined && provenance.source !== query.source) {
    return false
  }
  if (query.minConfidence !== undefined && provenance.confidence < query.minConfidence) {
    return false
  }
  if (query.touchedBy !== undefined && !provenance.lineage.includes(query.touchedBy)) {
    return false
  }
  return true
}
