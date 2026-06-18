/**
 * Per-tenant concurrent-run quota (Stage 4-D).
 *
 * Distinct from {@link ResourceQuotaManager}, which is a per-API-key sliding
 * token-count budget. This quota answers a different question entirely: "how
 * many runs are currently active for this tenant, and is that at or over the
 * tenant's concurrent-run cap?" It enforces fair sharing of the run fleet so a
 * single tenant cannot monopolise worker capacity.
 *
 * Two implementations ship:
 *
 * - {@link InMemoryTenantRunQuota} — a `Map<tenantId, activeCount>` suitable
 *   for single-node deployments and tests. `increment` is called when a run is
 *   admitted; `decrement` when it reaches any terminal state. The count never
 *   goes below 0.
 * - {@link DrizzleTenantRunQuota} — counts live `forge_runs` rows
 *   (status IN running/queued/claimed) for a tenant, so the cap is enforced
 *   accurately across a fleet of workers sharing one database. Its check is
 *   async (`checkAsync`); the sync `check` returns a safe permissive fallback
 *   so it still satisfies the {@link TenantRunQuota} interface for callers that
 *   do not await.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { forgeRuns } from "../persistence/drizzle-schema.js";

/**
 * Result of a {@link TenantRunQuota.check}. `reason` is populated only when
 * `allowed === false` so callers can surface a useful structured error.
 */
export interface TenantRunQuotaResult {
  allowed: boolean;
  active: number;
  limit: number;
  reason?: string;
}

/**
 * Per-tenant concurrent-run quota. The in-memory implementation tracks active
 * counts directly; the Drizzle implementation derives them from the live run
 * table. The interface is factored so alternate backends (Redis) slot in
 * without touching callers.
 */
export interface TenantRunQuota {
  /** Check if a new run is allowed for `tenantId` given a per-tenant limit. */
  check(tenantId: string, limit: number): TenantRunQuotaResult;
  /** Increment the active count for `tenantId`. Call when a run starts. */
  increment(tenantId: string): void;
  /** Decrement the active count for `tenantId`. Call on any terminal state. */
  decrement(tenantId: string): void;
  /** Snapshot of active counts (for metrics / diagnostics). */
  snapshot(): Record<string, number>;
}

/**
 * In-memory, `Map`-backed {@link TenantRunQuota}. `check` allows a new run when
 * `active < limit`; a `limit <= 0` means unlimited. `decrement` never drops a
 * tenant below 0.
 */
export class InMemoryTenantRunQuota implements TenantRunQuota {
  private readonly active = new Map<string, number>();

  check(tenantId: string, limit: number): TenantRunQuotaResult {
    const active = this.active.get(tenantId) ?? 0;
    if (limit <= 0) {
      // A non-positive limit means "unlimited".
      return { allowed: true, active, limit };
    }
    if (active < limit) {
      return { allowed: true, active, limit };
    }
    return {
      allowed: false,
      active,
      limit,
      reason: `Tenant "${tenantId}" has reached its concurrent-run limit (${active}/${limit}).`,
    };
  }

  increment(tenantId: string): void {
    this.active.set(tenantId, (this.active.get(tenantId) ?? 0) + 1);
  }

  decrement(tenantId: string): void {
    const next = (this.active.get(tenantId) ?? 0) - 1;
    this.active.set(tenantId, next < 0 ? 0 : next);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.active);
  }
}

type DB = PostgresJsDatabase<Record<string, never>>;

/** Run statuses that count toward a tenant's active concurrency. */
const ACTIVE_RUN_STATUSES = ["running", "queued", "claimed"] as const;

/**
 * Drizzle-backed {@link TenantRunQuota}. The authoritative active count is
 * derived from the `forge_runs` table by counting rows whose status is one of
 * {@link ACTIVE_RUN_STATUSES} for the given tenant — so a fleet of workers
 * sharing one database enforces the cap consistently.
 *
 * The interface's `check` is synchronous, but an accurate count requires a DB
 * round-trip; {@link checkAsync} performs that query. The sync `check` returns
 * a permissive fallback (`allowed: true, active: 0`) so this class still
 * satisfies {@link TenantRunQuota} for callers that cannot await — those
 * callers should prefer `checkAsync`. `increment`/`decrement` are no-ops here
 * because the count is read directly from the run table on each check.
 */
export class DrizzleTenantRunQuota implements TenantRunQuota {
  constructor(private readonly db: DB) {}

  /**
   * Permissive synchronous fallback so this implementation satisfies the
   * {@link TenantRunQuota} interface. Callers that can await should use
   * {@link checkAsync} for the real, DB-backed answer.
   */
  check(_tenantId: string, limit: number): TenantRunQuotaResult {
    return { allowed: true, active: 0, limit };
  }

  /**
   * Count live runs for `tenantId` and decide admission against `limit`. A
   * `limit <= 0` means unlimited.
   */
  async checkAsync(
    tenantId: string,
    limit: number
  ): Promise<TenantRunQuotaResult> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(forgeRuns)
      .where(
        and(
          eq(forgeRuns.tenantId, tenantId),
          inArray(forgeRuns.status, [...ACTIVE_RUN_STATUSES])
        )
      );
    const active = rows[0]?.count ?? 0;
    if (limit <= 0 || active < limit) {
      return { allowed: true, active, limit };
    }
    return {
      allowed: false,
      active,
      limit,
      reason: `Tenant "${tenantId}" has reached its concurrent-run limit (${active}/${limit}).`,
    };
  }

  /** No-op: active counts are derived from the run table, not tracked here. */
  increment(_tenantId: string): void {}

  /** No-op: active counts are derived from the run table, not tracked here. */
  decrement(_tenantId: string): void {}

  /**
   * Returns an empty snapshot. Active counts are not tracked in-process; query
   * the run table directly for diagnostics.
   */
  snapshot(): Record<string, number> {
    return {};
  }
}
