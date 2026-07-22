/**
 * Drizzle-backed schedule store for persistent schedule storage.
 */
import { and, eq, lte } from "drizzle-orm";
import { scheduleConfigs } from "../../persistence/drizzle-schema.js";
import type { DrizzleStoreDatabase } from "../../persistence/drizzle-store-types.js";
import { computeNextRunAt, resolveOccurrences } from "./cron.js";
import { normalizePatch, rowToRecord } from "./row-mapping.js";
import type {
  ClaimDueOptions,
  ClaimedSchedule,
  ScheduleRecord,
  ScheduleRow,
  ScheduleStore,
} from "./types.js";

/**
 * Drizzle-backed schedule store for persistent schedule storage.
 */
export class DrizzleScheduleStore implements ScheduleStore {
  constructor(private readonly db: DrizzleStoreDatabase) {}

  async save(
    schedule: Omit<ScheduleRecord, "createdAt" | "updatedAt">
  ): Promise<ScheduleRecord> {
    const now = new Date();

    // Try to get existing
    const tenantId = schedule.tenantId ?? "default";
    const existing = await this.get(schedule.id, tenantId);

    // Derive nextRunAt from the cron expression when not supplied.
    let nextRunAt: Date | null;
    if (schedule.nextRunAt !== undefined) {
      nextRunAt = schedule.nextRunAt ? new Date(schedule.nextRunAt) : null;
    } else {
      nextRunAt = computeNextRunAt(schedule.cronExpression, now);
    }

    if (existing) {
      const rows = (await this.db
        .update(scheduleConfigs)
        .set({
          name: schedule.name,
          cronExpression: schedule.cronExpression,
          workflowText: schedule.workflowText,
          enabled: schedule.enabled,
          metadata: schedule.metadata ?? null,
          tenantId,
          nextRunAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(scheduleConfigs.id, schedule.id),
            eq(scheduleConfigs.tenantId, tenantId)
          )
        )
        .returning()) as ScheduleRow[];
      const row = rows[0];
      if (!row) throw new Error(`Failed to update schedule ${schedule.id}`);
      return rowToRecord(row);
    }

    const rows = (await this.db
      .insert(scheduleConfigs)
      .values({
        id: schedule.id,
        name: schedule.name,
        cronExpression: schedule.cronExpression,
        workflowText: schedule.workflowText,
        enabled: schedule.enabled,
        metadata: schedule.metadata ?? null,
        tenantId,
        nextRunAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning()) as ScheduleRow[];
    const row = rows[0];
    if (!row) throw new Error(`Failed to insert schedule ${schedule.id}`);

    return rowToRecord(row);
  }

  async list(filter?: {
    enabled?: boolean;
    tenantId?: string;
  }): Promise<ScheduleRecord[]> {
    const conditions = [];
    if (filter?.enabled !== undefined) {
      conditions.push(eq(scheduleConfigs.enabled, filter.enabled));
    }
    if (filter?.tenantId !== undefined) {
      conditions.push(eq(scheduleConfigs.tenantId, filter.tenantId));
    }

    const query = this.db.select().from(scheduleConfigs);
    const rows = (
      conditions.length > 0
        ? await query.where(and(...conditions))
        : await query
    ) as ScheduleRow[];

    return rows.map((r) => rowToRecord(r));
  }

  async get(id: string, tenantId?: string): Promise<ScheduleRecord | null> {
    const conditions = [eq(scheduleConfigs.id, id)];
    if (tenantId !== undefined)
      conditions.push(eq(scheduleConfigs.tenantId, tenantId));

    const rows = await this.db
      .select()
      .from(scheduleConfigs)
      .where(and(...conditions))
      .limit(1);

    const row = rows[0] as ScheduleRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async update(
    id: string,
    patch: Partial<Omit<ScheduleRecord, "id" | "createdAt" | "updatedAt">>,
    tenantId?: string
  ): Promise<ScheduleRecord | null> {
    const conditions = [eq(scheduleConfigs.id, id)];
    if (tenantId !== undefined)
      conditions.push(eq(scheduleConfigs.tenantId, tenantId));

    const rows = await this.db
      .update(scheduleConfigs)
      .set({ ...normalizePatch(patch), updatedAt: new Date() })
      .where(and(...conditions))
      .returning();

    const row = rows[0] as ScheduleRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    const conditions = [eq(scheduleConfigs.id, id)];
    if (tenantId !== undefined)
      conditions.push(eq(scheduleConfigs.tenantId, tenantId));

    const rows = await this.db
      .delete(scheduleConfigs)
      .where(and(...conditions))
      .returning();
    return rows.length > 0;
  }

  async claimDue(now: Date, opts: ClaimDueOptions): Promise<ClaimedSchedule[]> {
    // Read the due candidates first so we can compute each schedule's own next
    // occurrence (cron math cannot run inside a single SET). The disjoint-winner
    // guarantee comes from the per-row atomic UPDATE below, whose WHERE clause
    // (still due + still not running) only one racing caller can satisfy.
    const dueConditions = [
      eq(scheduleConfigs.enabled, true),
      lte(scheduleConfigs.nextRunAt, now),
    ];
    if (opts.skipIfRunning) {
      dueConditions.push(eq(scheduleConfigs.running, false));
    }

    const candidates = (await this.db
      .select()
      .from(scheduleConfigs)
      .where(and(...dueConditions))
      .limit(opts.limit)) as ScheduleRow[];

    const stamp = new Date();
    const claimed: ClaimedSchedule[] = [];

    for (const candidate of candidates) {
      if (claimed.length >= opts.limit) break;
      const dueAt = candidate.nextRunAt;
      if (!dueAt) continue;

      const advanced = computeNextRunAt(candidate.cronExpression, now);

      // Atomic compare-and-set: claim only while still due AND (when
      // skipIfRunning) still not running, with nextRunAt unchanged since the
      // read. Two nodes racing this UPDATE yield disjoint winners.
      const claimConditions = [
        eq(scheduleConfigs.id, candidate.id),
        eq(scheduleConfigs.enabled, true),
        lte(scheduleConfigs.nextRunAt, now),
        eq(scheduleConfigs.nextRunAt, dueAt),
      ];
      // skipIfRunning adds the running=false guard: this is the compare-and-set
      // arm that makes two nodes racing the SAME occurrence disjoint winners.
      // Without it, the still-due + unchanged-nextRunAt guards alone enforce
      // single-fire.
      if (opts.skipIfRunning) {
        claimConditions.push(eq(scheduleConfigs.running, false));
      }

      const rows = (await this.db
        .update(scheduleConfigs)
        .set({
          nextRunAt: advanced,
          claimedBy: opts.claimerId,
          lastClaimedAt: stamp,
          running: opts.skipIfRunning ? true : candidate.running,
          updatedAt: stamp,
        })
        .where(and(...claimConditions))
        .returning()) as ScheduleRow[];

      const won = rows[0];
      if (!won) continue;

      const record = rowToRecord(won);
      const occurrences = resolveOccurrences(
        candidate.cronExpression,
        dueAt,
        now,
        opts.maxCatchUp
      );
      for (const occurrence of occurrences) {
        if (claimed.length >= opts.limit) break;
        claimed.push({ ...record, occurrence });
      }
    }

    return claimed;
  }

  async markFired(id: string, _occurrence: Date, runId: string): Promise<void> {
    const existing = await this.get(id);
    await this.db
      .update(scheduleConfigs)
      .set({
        running: false,
        lastFiredAt: new Date(),
        metadata: { ...(existing?.metadata ?? {}), lastFiredRunId: runId },
        updatedAt: new Date(),
      })
      .where(eq(scheduleConfigs.id, id))
      .returning();
  }
}
