/**
 * Drizzle-backed RunReflectionStore for persistent reflection storage.
 *
 * Reflections are write-once: a completed run produces exactly one
 * ReflectionSummary. The `save()` method uses ON CONFLICT DO NOTHING
 * for idempotency.
 *
 * RUN-REFLECTION-STORE-WIDEN
 * --------------------------
 * The store accepts tenant/owner filters via {@link ReflectionListOptions}
 * and pushes them into the SELECT. `ownerId` filtering keeps legacy
 * ownerless rows visible (`isNull(owner_id) OR owner_id = ?`), matching
 * routing-stats semantics so reflections persisted before this widening
 * remain readable by their tenant.
 */
import type {
  ReflectionListOptions,
  ReflectionPattern,
  ReflectionPatternOptions,
  ReflectionSummary,
  RunReflectionStore,
} from '@dzupagent/agent'
import { eq, desc, and, isNull, or, type SQL } from 'drizzle-orm'
import { runReflections } from './drizzle-schema.js'
import type { DrizzleConflictInsertDatabase } from './drizzle-store-types.js'

interface ReflectionRow {
  runId: string
  completedAt: Date
  durationMs: number
  totalSteps: number
  toolCallCount: number
  errorCount: number
  patterns: ReflectionPattern[]
  qualityScore: number
  tenantId: string | null
  ownerId: string | null
  createdAt: Date
}

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
 * Build a Drizzle WHERE clause for the tenant/owner filter. Returns
 * `undefined` when neither filter is set so the caller can skip `.where()`
 * entirely.
 */
function buildScopeWhere(filter: { tenantId?: string; ownerId?: string }): SQL | undefined {
  const clauses: SQL[] = []
  if (filter.tenantId !== undefined) {
    clauses.push(eq(runReflections.tenantId, filter.tenantId))
  }
  if (filter.ownerId !== undefined) {
    // Legacy ownerless rows (owner_id IS NULL) remain visible.
    const ownerClause = or(
      eq(runReflections.ownerId, filter.ownerId),
      isNull(runReflections.ownerId),
    )
    if (ownerClause) clauses.push(ownerClause)
  }
  if (clauses.length === 0) return undefined
  if (clauses.length === 1) return clauses[0]
  return and(...clauses)
}

export class DrizzleReflectionStore implements RunReflectionStore {
  constructor(private readonly db: DrizzleConflictInsertDatabase) {}

  async save(summary: ReflectionSummary): Promise<void> {
    await this.db
      .insert(runReflections)
      .values({
        runId: summary.runId,
        completedAt: summary.completedAt,
        durationMs: summary.durationMs,
        totalSteps: summary.totalSteps,
        toolCallCount: summary.toolCallCount,
        errorCount: summary.errorCount,
        patterns: summary.patterns,
        qualityScore: summary.qualityScore,
        ...(summary.tenantId !== undefined ? { tenantId: summary.tenantId } : {}),
        ...(summary.ownerId !== undefined ? { ownerId: summary.ownerId } : {}),
      })
      .onConflictDoNothing()
  }

  async get(runId: string): Promise<ReflectionSummary | undefined> {
    const rows = await this.db
      .select()
      .from(runReflections)
      .where(eq(runReflections.runId, runId))
      .limit(1)

    const row = rows[0] as ReflectionRow | undefined
    return row ? this.rowToSummary(row) : undefined
  }

  async list(
    opts?: number | ReflectionListOptions,
  ): Promise<ReflectionSummary[]> {
    const { limit, tenantId, ownerId } = normalizeListOptions(opts)
    const where = buildScopeWhere({ tenantId, ownerId })

    const base = this.db.select().from(runReflections)
    const scoped = where !== undefined ? base.where(where) : base
    const ordered = scoped.orderBy(desc(runReflections.completedAt))

    const rows = (limit !== undefined
      ? await ordered.limit(limit)
      : await ordered) as ReflectionRow[]

    return rows.map((r) => this.rowToSummary(r))
  }

  async getPatterns(
    type: ReflectionPattern['type'],
    opts?: ReflectionPatternOptions,
  ): Promise<ReflectionPattern[]> {
    const where = buildScopeWhere({
      ...(opts?.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
      ...(opts?.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
    })
    const base = this.db.select().from(runReflections)
    const rows = (where !== undefined
      ? await base.where(where)
      : await base) as ReflectionRow[]

    return rows
      .flatMap((r) => (r.patterns ?? []) as ReflectionPattern[])
      .filter((p) => p.type === type)
  }

  private rowToSummary(row: ReflectionRow): ReflectionSummary {
    const summary: ReflectionSummary = {
      runId: row.runId,
      completedAt: row.completedAt instanceof Date ? row.completedAt : new Date(row.completedAt),
      durationMs: row.durationMs,
      totalSteps: row.totalSteps,
      toolCallCount: row.toolCallCount,
      errorCount: row.errorCount,
      patterns: (row.patterns ?? []) as ReflectionPattern[],
      qualityScore: row.qualityScore,
    }
    if (row.tenantId !== null && row.tenantId !== undefined) {
      summary.tenantId = row.tenantId
    }
    if (row.ownerId !== null && row.ownerId !== undefined) {
      summary.ownerId = row.ownerId
    }
    return summary
  }
}
