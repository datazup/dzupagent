/**
 * CostAttributor — per-tenant cost showback (Stage 4-E).
 *
 * Aggregates `cost_cents` from `forge_runs` grouped by `tenant_id`, scoped to a
 * status set and a completion-time window. Powers the `/admin/tenants/cost`
 * REST surface used for tenant billing/showback dashboards.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { forgeRuns } from "../persistence/drizzle-schema.js";

/**
 * Narrow Drizzle select chain used by the cost attributor. Mirrors the shared
 * `DrizzleSelectQuery` but adds `groupBy`, which the aggregate query requires.
 * Resolves to the projected aggregate rows so callers stay driver-agnostic.
 */
export interface CostSelectQuery extends PromiseLike<CostAggregateRow[]> {
  from(table: unknown): CostSelectQuery;
  where(condition: unknown): CostSelectQuery;
  groupBy(...expressions: unknown[]): CostSelectQuery;
}

/** Minimal Drizzle client surface consumed by {@link DrizzleCostAttributor}. */
export interface CostAttributorDatabase {
  select(selection?: unknown): CostSelectQuery;
}

/** Aggregated cost for a single tenant over a query window. */
export interface TenantCostSummary {
  tenantId: string;
  totalCents: number;
  runCount: number;
  /** ISO date string of the oldest run in the window (or undefined if no runs). */
  since?: string;
}

/** Query options bounding the aggregation. */
export interface CostAttributorQuery {
  /** Only count runs completed after this ISO date (default: last 30 days). */
  since?: string;
  /** Only count runs with these statuses (default: ['completed']). */
  statuses?: string[];
}

export interface CostAttributor {
  /** Aggregate cost for a single tenant. */
  getTenantCost(
    tenantId: string,
    query?: CostAttributorQuery
  ): Promise<TenantCostSummary>;
  /** Aggregate cost for all tenants. */
  getAllTenantCosts(query?: CostAttributorQuery): Promise<TenantCostSummary[]>;
}

const DEFAULT_STATUSES = ["completed"] as const;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Shape returned by the grouped aggregate query. */
interface CostAggregateRow {
  tenantId: string;
  totalCents: number | string | null;
  runCount: number | string | null;
  since: string | null;
}

/** Resolve effective statuses + since-date from optional query options. */
function resolveWindow(query?: CostAttributorQuery): {
  statuses: string[];
  sinceDate: Date;
} {
  const statuses =
    query?.statuses && query.statuses.length > 0
      ? query.statuses
      : [...DEFAULT_STATUSES];
  const sinceDate = query?.since
    ? new Date(query.since)
    : new Date(Date.now() - THIRTY_DAYS_MS);
  return { statuses, sinceDate };
}

/** Coerce a possibly-string SQL aggregate (Postgres `numeric`/`bigint`) to a number. */
function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Normalise an aggregate row into the public summary shape. */
function toSummary(row: CostAggregateRow): TenantCostSummary {
  return {
    tenantId: row.tenantId,
    totalCents: toNumber(row.totalCents),
    runCount: toNumber(row.runCount),
    ...(row.since ? { since: row.since } : {}),
  };
}

/**
 * Drizzle-backed cost attributor. Performs the aggregation in Postgres via a
 * grouped `sum(cost_cents)` / `count(*)` query so per-tenant totals never
 * stream every row into the process.
 */
export class DrizzleCostAttributor implements CostAttributor {
  constructor(private readonly db: CostAttributorDatabase) {}

  async getTenantCost(
    tenantId: string,
    query?: CostAttributorQuery
  ): Promise<TenantCostSummary> {
    const { statuses, sinceDate } = resolveWindow(query);

    const rows = await this.db
      .select({
        tenantId: forgeRuns.tenantId,
        totalCents: sql<number>`sum(cost_cents)`,
        runCount: sql<number>`count(*)`,
        since: sql<string>`min(completed_at)::text`,
      })
      .from(forgeRuns)
      .where(
        and(
          eq(forgeRuns.tenantId, tenantId),
          inArray(forgeRuns.status, statuses),
          gte(forgeRuns.completedAt, sinceDate)
        )
      )
      .groupBy(forgeRuns.tenantId);

    const row = rows[0];
    if (!row) {
      return { tenantId, totalCents: 0, runCount: 0 };
    }
    return toSummary(row);
  }

  async getAllTenantCosts(
    query?: CostAttributorQuery
  ): Promise<TenantCostSummary[]> {
    const { statuses, sinceDate } = resolveWindow(query);

    const rows = await this.db
      .select({
        tenantId: forgeRuns.tenantId,
        totalCents: sql<number>`sum(cost_cents)`,
        runCount: sql<number>`count(*)`,
        since: sql<string>`min(completed_at)::text`,
      })
      .from(forgeRuns)
      .where(
        and(
          inArray(forgeRuns.status, statuses),
          gte(forgeRuns.completedAt, sinceDate)
        )
      )
      .groupBy(forgeRuns.tenantId);

    return rows.map(toSummary);
  }
}
