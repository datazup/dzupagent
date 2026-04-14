/**
 * Memory CLI commands — browse and search memory namespaces.
 *
 * Uses MemoryServiceLike to avoid hard dependency on @dzupagent/memory.
 */
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'

export interface MemoryBrowseOptions {
  namespace: string
  scope: Record<string, string>
  limit?: number
  search?: string
}

export interface MemoryBrowseEntry {
  key: string
  value: unknown
}

export interface MemorySearchResult {
  namespace: string
  key: string
  score: number
}

/**
 * Browse entries in a memory namespace.
 * If `search` is provided, performs a search; otherwise lists via get().
 */
export async function memoryBrowse(
  memoryService: MemoryServiceLike,
  options: MemoryBrowseOptions,
): Promise<MemoryBrowseEntry[]> {
  const { namespace, scope, limit = 20, search } = options

  let records: Record<string, unknown>[]

  if (search) {
    records = await memoryService.search(namespace, scope, search, limit)
  } else {
    records = await memoryService.get(namespace, scope)
    if (limit < records.length) {
      records = records.slice(0, limit)
    }
  }

  return records.map((record) => ({
    key: typeof record['key'] === 'string' ? record['key'] : 'unknown',
    value: record,
  }))
}

/**
 * Search across one or more namespaces for a query string.
 * Returns results with a simple scoring based on match position.
 */
export async function memorySearch(
  memoryService: MemoryServiceLike,
  query: string,
  scope: Record<string, string>,
  namespaces: string[] = ['lessons'],
  limit = 10,
): Promise<MemorySearchResult[]> {
  const results: MemorySearchResult[] = []

  for (const namespace of namespaces) {
    const records = await memoryService.search(namespace, scope, query, limit)

    for (let i = 0; i < records.length; i++) {
      const record = records[i]!
      results.push({
        namespace,
        key: typeof record['key'] === 'string' ? record['key'] : `item-${i}`,
        // Score decreases with position (1.0 for first result)
        score: 1.0 / (i + 1),
      })
    }
  }

  // Sort by score descending, then trim to limit
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}
