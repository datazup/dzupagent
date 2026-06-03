/**
 * DeploymentHistoryStore — Drizzle-backed persistence for deployment records.
 *
 * Provides CRUD and analytics queries over the `deployment_history` table.
 * Falls back to an in-memory implementation when no database is available.
 */

import { eq, desc, and, gte, sql } from "drizzle-orm";
import { deploymentHistory } from "../persistence/drizzle-schema.js";
import type { DrizzleReturningStoreDatabase } from "../persistence/drizzle-store-types.js";
import type { GateDecision } from "./confidence-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a deployment record as stored / returned by the store. */
export interface DeploymentHistoryRecord {
  id: string;
  confidenceScore: number;
  gateDecision: GateDecision;
  signalsSnapshot: Record<string, unknown>[] | null;
  deployedAt: Date;
  deployedBy: string | null;
  environment: string;
  rollbackAvailable: boolean;
  outcome: string | null;
  completedAt: Date | null;
  notes: string | null;
  /** SEC-M-06: Tenant that owns this deployment record. */
  tenantId: string | null;
}

/** Input to `record()` — `id` is required, timestamps default to now. */
export interface DeploymentHistoryInput {
  id: string;
  confidenceScore: number;
  gateDecision: GateDecision;
  signalsSnapshot?: Record<string, unknown>[];
  deployedBy?: string;
  environment: string;
  rollbackAvailable?: boolean;
  notes?: string;
  /**
   * SEC-M-06: Tenant that owns this deployment record. Stamped from the
   * requesting API key context at the route layer.
   */
  tenantId?: string;
}

/** Success rate result. */
export interface SuccessRateResult {
  successRate: number;
  totalDeployments: number;
  successCount: number;
}

/** Deployment outcome values. */
export type DeploymentOutcome = "success" | "failure" | "rolled_back";

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface DeploymentHistoryStoreInterface {
  record(deployment: DeploymentHistoryInput): Promise<DeploymentHistoryRecord>;
  /**
   * SEC-M-06: when `tenantId` is supplied, results are restricted to records
   * owned by that tenant (default-deny — records with a different or null
   * tenant are excluded).
   */
  getRecent(
    limit: number,
    environment?: string,
    tenantId?: string
  ): Promise<DeploymentHistoryRecord[]>;
  getSuccessRate(
    environment?: string,
    windowDays?: number,
    tenantId?: string
  ): Promise<SuccessRateResult>;
  /**
   * SEC-M-06: when `tenantId` is supplied, the update only applies if the
   * record is owned by that tenant; a cross-tenant id returns `null` (no
   * mutation).
   */
  markOutcome(
    id: string,
    outcome: DeploymentOutcome,
    tenantId?: string
  ): Promise<DeploymentHistoryRecord | null>;
  /**
   * SEC-M-06: when `tenantId` is supplied, a record owned by a different
   * tenant is treated as not found and returns `null`.
   */
  getById(
    id: string,
    tenantId?: string
  ): Promise<DeploymentHistoryRecord | null>;
}

// ---------------------------------------------------------------------------
// Drizzle (Postgres) implementation
// ---------------------------------------------------------------------------

/** Inferred row type for the {@link deploymentHistory} table. */
type DeploymentHistoryRow = typeof deploymentHistory.$inferSelect;

export class PostgresDeploymentHistoryStore
  implements DeploymentHistoryStoreInterface
{
  constructor(private readonly db: DrizzleReturningStoreDatabase) {}

  async record(
    input: DeploymentHistoryInput
  ): Promise<DeploymentHistoryRecord> {
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
        tenantId: input.tenantId ?? null,
      })
      .returning();

    return this.toRecord(rows[0] as DeploymentHistoryRow);
  }

  async getRecent(
    limit: number,
    environment?: string,
    tenantId?: string
  ): Promise<DeploymentHistoryRecord[]> {
    const filters: ReturnType<typeof eq>[] = [];
    if (environment) {
      filters.push(eq(deploymentHistory.environment, environment));
    }
    if (tenantId !== undefined) {
      filters.push(eq(deploymentHistory.tenantId, tenantId));
    }
    const conditions = filters.length > 0 ? and(...filters) : undefined;

    const query = this.db.select().from(deploymentHistory);

    const withWhere = conditions ? query.where(conditions) : query;
    const rows = (await withWhere
      .orderBy(desc(deploymentHistory.deployedAt))
      .limit(limit)) as DeploymentHistoryRow[];

    return rows.map((r) => this.toRecord(r));
  }

  async getSuccessRate(
    environment?: string,
    windowDays = 30,
    tenantId?: string
  ): Promise<SuccessRateResult> {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const filters = [gte(deploymentHistory.deployedAt, cutoff)];
    if (environment) {
      filters.push(eq(deploymentHistory.environment, environment));
    }
    if (tenantId !== undefined) {
      filters.push(eq(deploymentHistory.tenantId, tenantId));
    }
    const conditions = and(...filters);

    const rows = (await this.db
      .select({
        total: sql<number>`count(*)::int`,
        successes: sql<number>`count(*) filter (where ${deploymentHistory.outcome} = 'success')::int`,
      })
      .from(deploymentHistory)
      .where(
        and(conditions, sql`${deploymentHistory.outcome} is not null`)
      )) as Array<{
      total: number;
      successes: number;
    }>;

    const total = rows[0]?.total ?? 0;
    const successes = rows[0]?.successes ?? 0;

    return {
      successRate: total > 0 ? successes / total : 0,
      totalDeployments: total,
      successCount: successes,
    };
  }

  async markOutcome(
    id: string,
    outcome: DeploymentOutcome,
    tenantId?: string
  ): Promise<DeploymentHistoryRecord | null> {
    const where =
      tenantId !== undefined
        ? and(
            eq(deploymentHistory.id, id),
            eq(deploymentHistory.tenantId, tenantId)
          )
        : eq(deploymentHistory.id, id);

    const rows = await this.db
      .update(deploymentHistory)
      .set({
        outcome,
        completedAt: new Date(),
      })
      .where(where)
      .returning();

    if (rows.length === 0) return null;
    return this.toRecord(rows[0] as DeploymentHistoryRow);
  }

  async getById(
    id: string,
    tenantId?: string
  ): Promise<DeploymentHistoryRecord | null> {
    const where =
      tenantId !== undefined
        ? and(
            eq(deploymentHistory.id, id),
            eq(deploymentHistory.tenantId, tenantId)
          )
        : eq(deploymentHistory.id, id);

    const rows = await this.db
      .select()
      .from(deploymentHistory)
      .where(where)
      .limit(1);

    if (rows.length === 0) return null;
    return this.toRecord(rows[0] as DeploymentHistoryRow);
  }

  private toRecord(row: DeploymentHistoryRow): DeploymentHistoryRecord {
    return {
      id: row.id,
      confidenceScore: row.confidenceScore,
      gateDecision: row.gateDecision as GateDecision,
      signalsSnapshot: row.signalsSnapshot,
      deployedAt: row.deployedAt,
      deployedBy: row.deployedBy,
      environment: row.environment,
      rollbackAvailable: row.rollbackAvailable,
      outcome: row.outcome,
      completedAt: row.completedAt,
      notes: row.notes,
      tenantId: row.tenantId,
    };
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (for testing / non-Postgres deployments)
// ---------------------------------------------------------------------------

export class InMemoryDeploymentHistoryStore
  implements DeploymentHistoryStoreInterface
{
  private records: DeploymentHistoryRecord[] = [];

  async record(
    input: DeploymentHistoryInput
  ): Promise<DeploymentHistoryRecord> {
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
      tenantId: input.tenantId ?? null,
    };
    this.records.push(record);
    return record;
  }

  async getRecent(
    limit: number,
    environment?: string,
    tenantId?: string
  ): Promise<DeploymentHistoryRecord[]> {
    const filtered = this.records.filter((r) => {
      if (environment && r.environment !== environment) return false;
      // SEC-M-06: default-deny — when a tenant filter is active, only records
      // owned by that tenant match (null/other-tenant records are excluded).
      if (tenantId !== undefined && r.tenantId !== tenantId) return false;
      return true;
    });

    return filtered
      .sort((a, b) => b.deployedAt.getTime() - a.deployedAt.getTime())
      .slice(0, limit);
  }

  async getSuccessRate(
    environment?: string,
    windowDays = 30,
    tenantId?: string
  ): Promise<SuccessRateResult> {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const relevant = this.records.filter((r) => {
      if (r.outcome === null) return false;
      if (r.deployedAt < cutoff) return false;
      if (environment && r.environment !== environment) return false;
      if (tenantId !== undefined && r.tenantId !== tenantId) return false;
      return true;
    });

    const successCount = relevant.filter((r) => r.outcome === "success").length;

    return {
      successRate: relevant.length > 0 ? successCount / relevant.length : 0,
      totalDeployments: relevant.length,
      successCount,
    };
  }

  async markOutcome(
    id: string,
    outcome: DeploymentOutcome,
    tenantId?: string
  ): Promise<DeploymentHistoryRecord | null> {
    const record = this.records.find((r) => r.id === id);
    if (!record) return null;
    // SEC-M-06: cross-tenant mutation is denied; the record stays untouched.
    if (tenantId !== undefined && record.tenantId !== tenantId) return null;

    record.outcome = outcome;
    record.completedAt = new Date();
    return record;
  }

  async getById(
    id: string,
    tenantId?: string
  ): Promise<DeploymentHistoryRecord | null> {
    const record = this.records.find((r) => r.id === id) ?? null;
    if (!record) return null;
    // SEC-M-06: a record owned by a different tenant is treated as not found.
    if (tenantId !== undefined && record.tenantId !== tenantId) return null;
    return record;
  }

  /** Clear all records (for testing). */
  clear(): void {
    this.records = [];
  }
}
