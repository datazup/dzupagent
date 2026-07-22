/**
 * Public contract surface for schedule persistence stores.
 *
 * Schedules define cron-based triggers that execute workflow text on a
 * recurring basis. Each schedule has a name, cron expression, workflow text,
 * and an enabled flag.
 *
 * P4 HA scheduling: schedules carry a durable `nextRunAt` plus claim metadata
 * (`running`, `claimedBy`, `lastClaimedAt`, `lastFiredAt`) so a fleet of nodes
 * sharing one store fires each due occurrence exactly once via `claimDue`. The
 * atomic claim mirrors the P2 ledger `acquire` compare-and-set discipline
 * (UPDATE ... WHERE still-due RETURNING → disjoint winners).
 */

export interface ScheduleRecord {
  id: string;
  name: string;
  cronExpression: string;
  workflowText: string;
  enabled: boolean;
  metadata?: Record<string, unknown> | null;
  tenantId?: string | null;
  /** ISO timestamp of the next occurrence due to fire. Computed on save. */
  nextRunAt?: string | null;
  /** True while a fired run is still in flight (skip-if-running guard). */
  running?: boolean;
  /** Node id that won the most recent claim. */
  claimedBy?: string | null;
  /** ISO timestamp of the most recent successful claim. */
  lastClaimedAt?: string | null;
  /** ISO timestamp of the most recent fired occurrence. */
  lastFiredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A schedule a {@link ScheduleStore.claimDue} call won, plus the occurrence it fires for. */
export interface ClaimedSchedule extends ScheduleRecord {
  /** The due occurrence this claim fires. */
  occurrence: Date;
}

/** Options for {@link ScheduleStore.claimDue}. */
export interface ClaimDueOptions {
  /** Maximum number of schedules to claim this call. */
  limit: number;
  /** Identifier of the claiming node (stored as claimedBy). */
  claimerId: string;
  /**
   * When true, a schedule whose previous run is still in flight (running) is
   * not claimed, and a claimed schedule is marked running until markFired.
   */
  skipIfRunning: boolean;
  /**
   * Opt-in bounded catch-up. When set and > 0, a schedule whose nextRunAt is
   * several intervals in the past is replayed for up to this many missed
   * occurrences (each returned as a separate ClaimedSchedule). Default
   * behaviour (unset / 0) is skip-and-realign: fire once for the original
   * occurrence and advance nextRunAt to the next FUTURE slot.
   */
  maxCatchUp?: number;
}

export interface ScheduleStore {
  save(
    schedule: Omit<ScheduleRecord, "createdAt" | "updatedAt">
  ): Promise<ScheduleRecord>;
  list(filter?: {
    enabled?: boolean;
    tenantId?: string;
  }): Promise<ScheduleRecord[]>;
  get(id: string, tenantId?: string): Promise<ScheduleRecord | null>;
  update(
    id: string,
    patch: Partial<Omit<ScheduleRecord, "id" | "createdAt" | "updatedAt">>,
    tenantId?: string
  ): Promise<ScheduleRecord | null>;
  delete(id: string, tenantId?: string): Promise<boolean>;
  /**
   * Atomically claim due schedules. A schedule is due when enabled and its
   * nextRunAt is <= now (and, when skipIfRunning, not already running). Each
   * claimed schedule is returned to at most one caller: the winner advances
   * nextRunAt so a concurrent call sees nothing.
   */
  claimDue(now: Date, opts: ClaimDueOptions): Promise<ClaimedSchedule[]>;
  /**
   * Mark a fired occurrence complete: clears running and records lastFiredAt
   * (and the firing run id in metadata for observability).
   */
  markFired(id: string, occurrence: Date, runId: string): Promise<void>;
}

/** Row shape returned by Drizzle for the scheduleConfigs table. */
export interface ScheduleRow {
  id: string;
  name: string;
  cronExpression: string;
  workflowText: string;
  enabled: boolean;
  metadata: unknown;
  tenantId: string;
  nextRunAt: Date | null;
  running: boolean;
  claimedBy: string | null;
  lastClaimedAt: Date | null;
  lastFiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
