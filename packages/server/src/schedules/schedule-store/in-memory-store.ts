/**
 * In-memory schedule store for development and testing.
 */
import { computeNextRunAt, resolveOccurrences } from "./cron.js";
import type {
  ClaimDueOptions,
  ClaimedSchedule,
  ScheduleRecord,
  ScheduleStore,
} from "./types.js";

/**
 * In-memory schedule store for development and testing.
 *
 * A clock is injectable so `nextRunAt` derivation and claim stamps are
 * deterministic in tests. JavaScript's single-threaded execution makes the
 * read-check-mutate inside `claimDue` atomic per call, so two sequential calls
 * over the same store yield disjoint claimed sets.
 */
export class InMemoryScheduleStore implements ScheduleStore {
  private readonly schedules = new Map<string, ScheduleRecord>();
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  async save(
    schedule: Omit<ScheduleRecord, "createdAt" | "updatedAt">
  ): Promise<ScheduleRecord> {
    const now = this.clock().toISOString();
    const existing = this.schedules.get(schedule.id);
    // Derive nextRunAt from the cron expression when the caller did not supply
    // one (keeps existing save() callers working without change).
    let nextRunAt = schedule.nextRunAt;
    if (nextRunAt === undefined) {
      const next = computeNextRunAt(schedule.cronExpression, this.clock());
      nextRunAt = next ? next.toISOString() : null;
    }
    const record: ScheduleRecord = {
      ...schedule,
      nextRunAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.schedules.set(record.id, record);
    return record;
  }

  async list(filter?: {
    enabled?: boolean;
    tenantId?: string;
  }): Promise<ScheduleRecord[]> {
    let results = Array.from(this.schedules.values());

    if (filter?.enabled !== undefined) {
      results = results.filter((s) => s.enabled === filter.enabled);
    }
    if (filter?.tenantId !== undefined) {
      results = results.filter(
        (s) => (s.tenantId ?? "default") === filter.tenantId
      );
    }

    return results;
  }

  async get(id: string, tenantId?: string): Promise<ScheduleRecord | null> {
    const schedule = this.schedules.get(id) ?? null;
    if (!schedule) return null;
    if (tenantId && (schedule.tenantId ?? "default") !== tenantId) return null;
    return schedule;
  }

  async update(
    id: string,
    patch: Partial<Omit<ScheduleRecord, "id" | "createdAt" | "updatedAt">>,
    tenantId?: string
  ): Promise<ScheduleRecord | null> {
    const existing = await this.get(id, tenantId);
    if (!existing) return null;
    const updated: ScheduleRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.clock().toISOString(),
    };
    this.schedules.set(id, updated);
    return updated;
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    if (tenantId && !(await this.get(id, tenantId))) return false;
    return this.schedules.delete(id);
  }

  async claimDue(now: Date, opts: ClaimDueOptions): Promise<ClaimedSchedule[]> {
    const claimed: ClaimedSchedule[] = [];
    const nowMs = now.getTime();
    const stamp = this.clock().toISOString();

    for (const schedule of this.schedules.values()) {
      if (claimed.length >= opts.limit) break;
      if (!schedule.enabled) continue;
      if (!schedule.nextRunAt) continue;
      const dueAt = new Date(schedule.nextRunAt);
      if (dueAt.getTime() > nowMs) continue;
      if (opts.skipIfRunning && schedule.running === true) continue;

      const occurrences = resolveOccurrences(
        schedule.cronExpression,
        dueAt,
        now,
        opts.maxCatchUp
      );
      // Advance nextRunAt to the first occurrence strictly after `now`, so a
      // concurrent claim sees nothing (compare-and-set winner).
      const advanced = computeNextRunAt(schedule.cronExpression, now);
      const updated: ScheduleRecord = {
        ...schedule,
        nextRunAt: advanced ? advanced.toISOString() : null,
        claimedBy: opts.claimerId,
        lastClaimedAt: stamp,
        running: opts.skipIfRunning ? true : schedule.running,
        updatedAt: stamp,
      };
      this.schedules.set(schedule.id, updated);

      for (const occurrence of occurrences) {
        if (claimed.length >= opts.limit) break;
        claimed.push({ ...updated, occurrence });
      }
    }

    return claimed;
  }

  async markFired(id: string, _occurrence: Date, runId: string): Promise<void> {
    const existing = this.schedules.get(id);
    if (!existing) return;
    this.schedules.set(id, {
      ...existing,
      running: false,
      lastFiredAt: this.clock().toISOString(),
      metadata: { ...(existing.metadata ?? {}), lastFiredRunId: runId },
      updatedAt: this.clock().toISOString(),
    });
  }
}
