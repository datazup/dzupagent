/**
 * Cross-framework adapter interface for bidirectional conversion between
 * external memory formats and the DzupAgent MemoryFrame Arrow schema.
 *
 * Adapters are stateless — they transform data but do not manage connections
 * or persistence.
 */

import type { Table } from 'apache-arrow'

/**
 * Bidirectional adapter between an external memory format and the
 * DzupAgent MemoryFrame Arrow schema.
 *
 * @typeParam TExternal  The external framework's record type
 */
export interface MemoryFrameAdapter<TExternal> {
  /**
   * Identifier for the source system.
   * Used in provenance tracking (provenance_source = `imported:${sourceSystem}`).
   */
  readonly sourceSystem: string

  /**
   * Field mapping from external format to MemoryFrame columns.
   * Keys are MemoryFrame column names, values are dot-paths into the external record type.
   */
  readonly fieldMapping: Record<string, string>

  /**
   * Convert external records to a MemoryFrame Arrow Table.
   * Invalid records are skipped — this method never throws.
   */
  toFrame(records: TExternal[]): Table

  /**
   * Convert a MemoryFrame Arrow Table back to external format.
   * Rows with missing required columns are skipped — this method never throws.
   */
  fromFrame(table: Table): TExternal[]

  /**
   * Type guard: check if an unknown record matches this adapter's expected format.
   * Pure function — no side effects, no I/O.
   */
  canAdapt(record: unknown): record is TExternal

  /**
   * Validate a batch of records and return warnings for any that cannot be adapted.
   */
  validate(records: unknown[]): AdapterValidationResult
}

export interface AdapterValidationResult {
  /** Number of records that can be adapted */
  valid: number
  /** Number of records that failed validation */
  invalid: number
  /** Per-record warnings (field missing, type mismatch, etc.) */
  warnings: Array<{
    index: number
    field: string
    message: string
  }>
}

/**
 * Registry of all available adapters, keyed by source system name.
 */
export interface AdapterRegistry {
  get(sourceSystem: string): MemoryFrameAdapter<unknown> | undefined
  register<T>(adapter: MemoryFrameAdapter<T>): void
  list(): string[]
}

/**
 * Create a new adapter registry instance.
 */
export function createAdapterRegistry(): AdapterRegistry {
  const adapters = new Map<string, MemoryFrameAdapter<unknown>>()
  return {
    get: (name: string) => adapters.get(name),
    register: <T>(adapter: MemoryFrameAdapter<T>) =>
      adapters.set(adapter.sourceSystem, adapter as MemoryFrameAdapter<unknown>),
    list: () => Array.from(adapters.keys()),
  }
}
