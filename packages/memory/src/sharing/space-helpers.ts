/**
 * Internal helpers shared across the memory-space modules.
 *
 * Not exported from the package barrel — these are implementation
 * details of the sharing namespace and are not part of the public API.
 */

export function spaceNamespace(spaceId: string): string {
  return `space:${spaceId}`
}

export function spaceScope(spaceId: string): Record<string, string> {
  return { _space: spaceId }
}

export function keyFromValue(value: Record<string, unknown>, fallbackIndex: number): string {
  if (typeof value['_key'] === 'string') return value['_key']
  if (typeof value['key'] === 'string') return value['key']
  return `record-${fallbackIndex}`
}

export function hasFields(obj: unknown): obj is { fields: Record<string, unknown> } {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'fields' in obj &&
    typeof (obj as Record<string, unknown>)['fields'] === 'object'
  )
}

export function extractCreatedAt(record: Record<string, unknown>): number {
  // Try provenance timestamp first
  const prov = record['_provenance']
  if (prov != null && typeof prov === 'object') {
    const createdAt = (prov as Record<string, unknown>)['createdAt']
    if (typeof createdAt === 'string') {
      const ts = Date.parse(createdAt)
      if (!Number.isNaN(ts)) return ts
    }
  }
  // Fallback: check top-level createdAt
  if (typeof record['createdAt'] === 'string') {
    const ts = Date.parse(record['createdAt'])
    if (!Number.isNaN(ts)) return ts
  }
  return 0
}

export function isTombstoneRecord(record: Record<string, unknown>): boolean {
  return record['_tombstone'] === true
}

export function extractDeletedAt(record: Record<string, unknown>): number {
  const deletedAt = record['_deletedAt']
  if (typeof deletedAt === 'string') {
    const ts = Date.parse(deletedAt)
    if (!Number.isNaN(ts)) return ts
  }
  return 0
}
