/**
 * Drizzle-backed RunReflectionStore for persistent reflection storage.
 *
 * Reflections are write-once: a completed run produces exactly one
 * ReflectionSummary. The `save()` method uses ON CONFLICT DO NOTHING
 * for idempotency.
 */
import type { RunReflectionStore, ReflectionSummary, ReflectionPattern } from '@dzupagent/agent'
import { eq, desc } from 'drizzle-orm'
import { runReflections } from './drizzle-schema.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzle = any

interface ReflectionRow {
  runId: string
  completedAt: Date
  durationMs: number
  totalSteps: number
  toolCallCount: number
  errorCount: number
  patterns: ReflectionPattern[]
  qualityScore: number
  createdAt: Date
}

export class DrizzleReflectionStore implements RunReflectionStore {
  constructor(private readonly db: AnyDrizzle) {}

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

  async list(limit?: number): Promise<ReflectionSummary[]> {
    const query = this.db
      .select()
      .from(runReflections)
      .orderBy(desc(runReflections.completedAt))

    const rows: ReflectionRow[] = limit !== undefined
      ? await query.limit(limit)
      : await query

    return rows.map((r) => this.rowToSummary(r))
  }

  async getPatterns(type: ReflectionPattern['type']): Promise<ReflectionPattern[]> {
    const rows: ReflectionRow[] = await this.db
      .select()
      .from(runReflections)

    return rows
      .flatMap((r) => (r.patterns ?? []) as ReflectionPattern[])
      .filter((p) => p.type === type)
  }

  private rowToSummary(row: ReflectionRow): ReflectionSummary {
    return {
      runId: row.runId,
      completedAt: row.completedAt instanceof Date ? row.completedAt : new Date(row.completedAt),
      durationMs: row.durationMs,
      totalSteps: row.totalSteps,
      toolCallCount: row.toolCallCount,
      errorCount: row.errorCount,
      patterns: (row.patterns ?? []) as ReflectionPattern[],
      qualityScore: row.qualityScore,
    }
  }
}
