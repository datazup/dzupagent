/**
 * AgentFileImporter — validates and imports AgentFile documents into memory.
 *
 * Supports three conflict strategies:
 * - skip: do not overwrite existing keys
 * - overwrite: always replace existing keys
 * - merge: deep-merge new values into existing records
 *
 * Usage:
 *   const importer = new AgentFileImporter(memoryService, scope)
 *   const { valid, errors } = importer.validate(rawJson)
 *   if (valid) {
 *     const result = await importer.import(file, { conflictStrategy: 'skip' })
 *   }
 */
import { createHash } from 'node:crypto'
import type { MemoryService } from '../memory-service.js'
import type {
  AgentFile,
  AgentFileMemoryRecord,
  ImportOptions,
  ImportResult,
} from './types.js'
import { AGENT_FILE_SCHEMA, AGENT_FILE_VERSION } from './types.js'

/**
 * Validates and imports AgentFile documents into a MemoryService.
 */
export class AgentFileImporter {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly scope: Record<string, string>,
  ) {}

  /**
   * Validate an AgentFile without importing.
   * Checks required fields, version, and optional signature integrity.
   */
  validate(file: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    if (file === null || file === undefined || typeof file !== 'object') {
      errors.push('AgentFile must be a non-null object')
      return { valid: false, errors }
    }

    const f = file as Record<string, unknown>

    // Required top-level fields
    if (f['$schema'] !== AGENT_FILE_SCHEMA) {
      errors.push(
        `Invalid $schema: expected "${AGENT_FILE_SCHEMA}", got "${String(f['$schema'])}"`,
      )
    }

    if (f['version'] !== AGENT_FILE_VERSION) {
      errors.push(
        `Unsupported version: expected "${AGENT_FILE_VERSION}", got "${String(f['version'])}"`,
      )
    }

    if (typeof f['exportedAt'] !== 'string' || f['exportedAt'].length === 0) {
      errors.push('Missing or invalid exportedAt (must be non-empty string)')
    }

    if (typeof f['exportedBy'] !== 'string' || f['exportedBy'].length === 0) {
      errors.push('Missing or invalid exportedBy (must be non-empty string)')
    }

    // Agent section
    if (f['agent'] === null || f['agent'] === undefined || typeof f['agent'] !== 'object') {
      errors.push('Missing or invalid agent section')
    } else {
      const agent = f['agent'] as Record<string, unknown>
      if (typeof agent['name'] !== 'string' || agent['name'].length === 0) {
        errors.push('agent.name must be a non-empty string')
      }
    }

    // Memory section
    if (f['memory'] === null || f['memory'] === undefined || typeof f['memory'] !== 'object') {
      errors.push('Missing or invalid memory section')
    } else {
      const memory = f['memory'] as Record<string, unknown>
      if (
        memory['namespaces'] === null ||
        memory['namespaces'] === undefined ||
        typeof memory['namespaces'] !== 'object'
      ) {
        errors.push('memory.namespaces must be an object')
      }
    }

    // Signature verification
    if (typeof f['signature'] === 'string') {
      const computed = computeSignatureFromRaw(f)
      if (computed !== f['signature']) {
        errors.push('Signature verification failed: content has been tampered with')
      }
    }

    return { valid: errors.length === 0, errors }
  }

  /**
   * Import an AgentFile into memory.
   *
   * @param file - a validated AgentFile object
   * @param options - import behavior (conflict strategy, namespace filter, etc.)
   */
  async import(
    file: AgentFile,
    options?: ImportOptions,
  ): Promise<ImportResult> {
    const strategy = options?.conflictStrategy ?? 'skip'
    const nsFilter = options?.namespaces
    const verifySignature = options?.verifySignature ?? false

    const result: ImportResult = {
      imported: 0,
      skipped: 0,
      failed: 0,
      warnings: [],
    }

    // Verify signature if requested
    if (verifySignature && file.signature) {
      const computed = computeSignatureFromRaw(
        file as unknown as Record<string, unknown>,
      )
      if (computed !== file.signature) {
        result.warnings.push('Signature verification failed — import aborted')
        return result
      }
    }

    const namespaces = file.memory.namespaces
    const nsKeys = Object.keys(namespaces)

    for (const ns of nsKeys) {
      // Apply namespace filter
      if (nsFilter && !nsFilter.includes(ns)) {
        continue
      }

      const records = namespaces[ns]
      if (!records) continue

      for (const record of records) {
        try {
          await this.importRecord(ns, record, strategy, result)
        } catch {
          result.failed++
          result.warnings.push(
            `Failed to import record "${record.key}" in namespace "${ns}"`,
          )
        }
      }
    }

    return result
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Import a single record according to the conflict strategy.
   */
  private async importRecord(
    namespace: string,
    record: AgentFileMemoryRecord,
    strategy: 'skip' | 'overwrite' | 'merge',
    result: ImportResult,
  ): Promise<void> {
    // Check for existing record
    const existing = await this.memoryService.get(
      namespace,
      this.scope,
      record.key,
    )
    const hasExisting = existing.length > 0

    if (hasExisting && strategy === 'skip') {
      result.skipped++
      return
    }

    // Build value with imported provenance marker
    let value: Record<string, unknown>

    if (hasExisting && strategy === 'merge') {
      // Deep merge: existing + new (new values win on conflict)
      const existingValue = existing[0]!
      value = deepMerge(existingValue, record.value)
    } else {
      // overwrite or no existing record
      value = { ...record.value }
    }

    // Inject import provenance
    value = this.addImportProvenance(value, record)

    await this.memoryService.put(namespace, this.scope, record.key, value)
    result.imported++
  }

  /**
   * Add or update provenance to mark this record as imported.
   */
  private addImportProvenance(
    value: Record<string, unknown>,
    record: AgentFileMemoryRecord,
  ): Record<string, unknown> {
    const existingProv = record.provenance
    if (existingProv) {
      // Preserve original provenance but mark source as 'imported'
      return {
        ...value,
        _provenance: {
          ...existingProv,
          source: 'imported' as const,
        },
      }
    }

    // No original provenance — create minimal import marker
    return {
      ...value,
      _provenance: {
        source: 'imported' as const,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Deep merge two objects. Values from `source` overwrite values in `target`
 * for primitive types. Objects are recursively merged. Arrays are replaced.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target }

  for (const key of Object.keys(source)) {
    const srcVal = source[key]
    const tgtVal = target[key]

    if (
      srcVal !== null &&
      srcVal !== undefined &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      tgtVal !== undefined &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      )
    } else {
      result[key] = srcVal
    }
  }

  return result
}

/**
 * Compute SHA-256 signature from the raw file object's content sections.
 * Matches the exporter's signature computation.
 */
function computeSignatureFromRaw(f: Record<string, unknown>): string {
  const payload = {
    memory: f['memory'],
    prompts: f['prompts'],
    state: f['state'],
  }
  const canonical = JSON.stringify(payload, sortedReplacer)
  return createHash('sha256').update(canonical).digest('hex')
}

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
