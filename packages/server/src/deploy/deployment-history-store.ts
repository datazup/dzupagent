/**
 * DeploymentHistoryStore — Drizzle-backed persistence for deployment records.
 *
 * Provides CRUD and analytics queries over the `deployment_history` table.
 * Falls back to an in-memory implementation when no database is available.
 */

import { eq, desc, and, gte, sql } from 'drizzle-orm'
import { deploymentHistory } from '../persistence/drizzle-schema.js'
import type { GateDecision } from './confidence-types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a deployment record as stored / returned by the store. */
export interface DeploymentHistoryRecord {
  id: string
  confidenceScore: number
  gateDecision: GateDecision
  signalsSnapshot: Record<string, unknown>[] | null
  deployedAt: Date
  deployedBy: string | null
  environment: string
  rollbackAvailable: boolean
  outcome: string | null
  completedAt: Date | null
  notes: string | null
}

/** Input to `record()` — `id` is required, timestamps default to now. */
export interface DeploymentHistoryInput {
  id: string
  confidenceScore: number
  gateDecision: GateDecision
  signalsSnapshot?: Record<string, unknown>[]
  deployedBy?: string
  environment: string
  rollbackAvailable?: boolean
  notes?: string
}

/** Success rate result. */
export interface SuccessRateResult {
  successRate: number
  totalDeployments: number
  successCount: number
}

/** Deployment outcome values. */
export type DeploymentOutcome = 'success' | 'failure' | 'rolled_back'

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface DeploymentHistoryStoreInterface {
  record(deployment: DeploymentHistoryInput): Promise<DeploymentHistoryRecord>
  getRecent(limit: number, environment?: string): Promise<DeploymentHistoryRecord[]>
  getSuccessRate(environment?: string, windowDays?: number): Promise<SuccessRateResult>
  markOutcome(id: string, outcome: DeploymentOutcome): Promise<DeploymentHistoryRecord | null>
  getById(id: string): Promise<DeploymentHistoryRecord | null>
}

// ---------------------------------------------------------------------------
// Drizzle (Postgres) implementation
// ---------------------------------------------------------------------------

// Duck-typed Drizzle DB handle to avoid complex generics coupling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzleDB = any

export class PostgresDeploymentHistoryStore implements DeploymentHistoryStoreInterface {
  constructor(private readonly db: AnyDrizzleDB) {}

  async record(input: DeploymentHistoryInput): Promise<DeploymentHistoryRecord> {
    const rows = await this.db
      .insert(deploymentHistory)
      .values({
        id: input.id,
        confidenceScore: input.confidenceScore,
        gateDecision: input.gateDecision,
        signalsSnapshot: input.signalsSnapshot ?? null,
        deployedBy: input.deployedBy ?? null,
        environment: input.environment,
        rollbackAvailable: input.rollbackAvailable ?? false,
        notes: input.notes ?? null,
      })
      .returning()

    return this.toRecord(rows[0])
  }

  async getRecent(limit: number, environment?: string): Promise<DeploymentHistoryRecord[]> {
    const conditions = environment
      ? eq(deploymentHistory.environment, environment)
      : undefined

    const query = this.db
      .select()
      .from(deploymentHistory)

    const withWhere = conditions ? query.where(conditions) : query
    const rows = await withWhere
      .orderBy(desc(deploymentHistory.deployedAt))
      .limit(limit)

    return rows.map((r: Record<string, unknown>) => this.toRecord(r))
  }

  async getSuccessRate(environment?: string, windowDays = 30): Promise<SuccessRateResult> {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

    const conditions = environment
      ? and(
          gte(deploymentHistory.deployedAt, cutoff),
          eq(deploymentHistory.environment, environment),
        )
      : gte(deploymentHistory.deployedAt, cutoff)

    const rows = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        successes: sql<number>`count(*) filter (where ${deploymentHistory.outcome} = 'success')::int`,
      })
      .from(deploymentHistory)
      .where(and(conditions, sql`${deploymentHistory.outcome} is not null`))

    const total = rows[0]?.total ?? 0
    const successes = rows[0]?.successes ?? 0

    return {
      successRate: total > 0 ? successes / total : 0,
      totalDeployments: total,
      successCount: successes,
    }
  }

  async markOutcome(id: string, outcome: DeploymentOutcome): Promise<DeploymentHistoryRecord | null> {
    const rows = await this.db
      .update(deploymentHistory)
      .set({
        outcome,
        completedAt: new Date(),
      })
      .where(eq(deploymentHistory.id, id))
      .returning()

    if (rows.length === 0) return null
    return this.toRecord(rows[0])
  }

  async getById(id: string): Promise<DeploymentHistoryRecord | null> {
    const rows = await this.db
      .select()
      .from(deploymentHistory)
      .where(eq(deploymentHistory.id, id))
      .limit(1)

    if (rows.length === 0) return null
    return this.toRecord(rows[0])
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toRecord(row: any): DeploymentHistoryRecord {
    return {
      id: row.id as string,
      confidenceScore: row.confidenceScore as number,
      gateDecision: row.gateDecision as GateDecision,
      signalsSnapshot: row.signalsSnapshot as Record<string, unknown>[] | null,
      deployedAt: row.deployedAt as Date,
      deployedBy: row.deployedBy as string | null,
      environment: row.environment as string,
      rollbackAvailable: row.rollbackAvailable as boolean,
      outcome: row.outcome as string | null,
      completedAt: row.completedAt as Date | null,
      notes: row.notes as string | null,
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (for testing / non-Postgres deployments)
// ---------------------------------------------------------------------------

export class InMemoryDeploymentHistoryStore implements DeploymentHistoryStoreInterface {
  private records: DeploymentHistoryRecord[] = []

  async record(input: DeploymentHistoryInput): Promise<DeploymentHistoryRecord> {
    const record: DeploymentHistoryRecord = {
      id: input.id,
      confidenceScore: input.confidenceScore,
      gateDecision: input.gateDecision,
      signalsSnapshot: input.signalsSnapshot ?? null,
      deployedAt: new Date(),
      deployedBy: input.deployedBy ?? null,
      environment: input.environment,
      rollbackAvailable: input.rollbackAvailable ?? false,
      outcome: null,
      completedAt: null,
      notes: input.notes ?? null,
    }
    this.records.push(record)
    return record
  }

  async getRecent(limit: number, environment?: string): Promise<DeploymentHistoryRecord[]> {
    const filtered = environment
      ? this.records.filter((r) => r.environment === environment)
      : [...this.records]

    return filtered
      .sort((a, b) => b.deployedAt.getTime() - a.deployedAt.getTime())
      .slice(0, limit)
  }

  async getSuccessRate(environment?: string, windowDays = 30): Promise<SuccessRateResult> {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

    const relevant = this.records.filter((r) => {
      if (r.outcome === null) return false
      if (r.deployedAt < cutoff) return false
      if (environment && r.environment !== environment) return false
      return true
    })

    const successCount = relevant.filter((r) => r.outcome === 'success').length

    return {
      successRate: relevant.length > 0 ? successCount / relevant.length : 0,
      totalDeployments: relevant.length,
      successCount,
    }
  }

  async markOutcome(id: string, outcome: DeploymentOutcome): Promise<DeploymentHistoryRecord | null> {
    const record = this.records.find((r) => r.id === id)
    if (!record) return null

    record.outcome = outcome
    record.completedAt = new Date()
    return record
  }

  async getById(id: string): Promise<DeploymentHistoryRecord | null> {
    return this.records.find((r) => r.id === id) ?? null
  }

  /** Clear all records (for testing). */
  clear(): void {
    this.records = []
  }
}
