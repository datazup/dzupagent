/**
 * InMemoryReflectionStore -- simple in-memory implementation of RunReflectionStore.
 *
 * Suitable for testing, dev, and short-lived processes. Data is lost when the
 * process exits. For production use, implement RunReflectionStore against a
 * persistent backend (database, file system, etc.).
 *
 * @module reflection/in-memory-reflection-store
 */

import type {
  ReflectionListOptions,
  ReflectionPattern,
  ReflectionPatternOptions,
  ReflectionSummary,
  RunReflectionStore,
} from './reflection-types.js'

function normalizeListOptions(
  opts: number | ReflectionListOptions | undefined,
): { limit?: number; tenantId?: string; ownerId?: string } {
  if (opts === undefined) return {}
  if (typeof opts === 'number') return { limit: opts }
  return {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
    ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
  }
}

/**
 * Predicate matching a stored {@link ReflectionSummary} against tenant/owner
 * filters. Mirrors routing-stats semantics:
 *   - `tenantId` is exact-match; rows missing tenantId are treated as
 *     'default' so legacy ownerless single-tenant data still matches the
 *     default tenant.
 *   - `ownerId` filter is exact-match WITH legacy-ownerless visibility: rows
 *     whose ownerId is null/undefined remain visible.
 */
function summaryMatches(
  summary: ReflectionSummary,
  filter: { tenantId?: string | undefined; ownerId?: string | undefined },
): boolean {
  if (filter.tenantId !== undefined) {
    const rowTenant = summary.tenantId ?? 'default'
    if (rowTenant !== filter.tenantId) return false
  }
  if (filter.ownerId !== undefined) {
    if (summary.ownerId !== undefined && summary.ownerId !== null) {
      if (summary.ownerId !== filter.ownerId) return false
    }
    // ownerId undefined/null on the row → legacy ownerless, stays visible.
  }
  return true
}

export class InMemoryReflectionStore implements RunReflectionStore {
  private readonly summaries = new Map<string, ReflectionSummary>()

  async save(summary: ReflectionSummary): Promise<void> {
    this.summaries.set(summary.runId, summary)
  }

  async get(runId: string): Promise<ReflectionSummary | undefined> {
    return this.summaries.get(runId)
  }

  async list(
    opts?: number | ReflectionListOptions,
  ): Promise<ReflectionSummary[]> {
    const { limit, tenantId, ownerId } = normalizeListOptions(opts)
    const all = [...this.summaries.values()].sort(
      (a, b) => b.completedAt.getTime() - a.completedAt.getTime(),
    )
    const filtered = tenantId === undefined && ownerId === undefined
      ? all
      : all.filter((s) => summaryMatches(s, { tenantId, ownerId }))
    return limit !== undefined ? filtered.slice(0, limit) : filtered
  }

  async getPatterns(
    type: ReflectionPattern['type'],
    opts?: ReflectionPatternOptions,
  ): Promise<ReflectionPattern[]> {
    const tenantId = opts?.tenantId
    const ownerId = opts?.ownerId
    const filterActive = tenantId !== undefined || ownerId !== undefined

    const result: ReflectionPattern[] = []
    for (const summary of this.summaries.values()) {
      if (filterActive && !summaryMatches(summary, { tenantId, ownerId })) continue
      for (const pattern of summary.patterns) {
        if (pattern.type === type) {
          result.push(pattern)
        }
      }
    }
    return result
  }

  /** Number of stored summaries (useful for tests). */
  get size(): number {
    return this.summaries.size
  }

  /** Remove all stored summaries. */
  clear(): void {
    this.summaries.clear()
  }
}
