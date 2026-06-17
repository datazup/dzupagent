/**
 * Schedule persistence — in-memory and Drizzle-backed stores for cron-based schedule configs.
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
import { eq, and, lte } from 'drizzle-orm'
import { parseExpression } from 'cron-parser'
import { scheduleConfigs } from '../persistence/drizzle-schema.js'
import type { DrizzleStoreDatabase } from '../persistence/drizzle-store-types.js'

export interface ScheduleRecord {
  id: string
  name: string
  cronExpression: string
  workflowText: string
  enabled: boolean
  metadata?: Record<string, unknown> | null
  tenantId?: string | null
  /** ISO timestamp of the next occurrence due to fire. Computed on save. */
  nextRunAt?: string | null
  /** True while a fired run is still in flight (skip-if-running guard). */
  running?: boolean
  /** Node id that won the most recent claim. */
  claimedBy?: string | null
  /** ISO timestamp of the most recent successful claim. */
  lastClaimedAt?: string | null
  /** ISO timestamp of the most recent fired occurrence. */
  lastFiredAt?: string | null
  createdAt: string
  updatedAt: string
}

/** A schedule a {@link ScheduleStore.claimDue} call won, plus the occurrence it fires for. */
export interface ClaimedSchedule extends ScheduleRecord {
  /** The due occurrence this claim fires. */
  occurrence: Date
}

/** Options for {@link ScheduleStore.claimDue}. */
export interface ClaimDueOptions {
  /** Maximum number of schedules to claim this call. */
  limit: number
  /** Identifier of the claiming node (stored as claimedBy). */
  claimerId: string
  /**
   * When true, a schedule whose previous run is still in flight (running) is
   * not claimed, and a claimed schedule is marked running until markFired.
   */
  skipIfRunning: boolean
  /**
   * Opt-in bounded catch-up. When set and > 0, a schedule whose nextRunAt is
   * several intervals in the past is replayed for up to this many missed
   * occurrences (each returned as a separate ClaimedSchedule). Default
   * behaviour (unset / 0) is skip-and-realign: fire once for the original
   * occurrence and advance nextRunAt to the next FUTURE slot.
   */
  maxCatchUp?: number
}

/**
 * Compute the first cron occurrence strictly after `after`.
 *
 * Uses cron-parser 4.x `parseExpression(...).next().toDate()`. Returns `null`
 * when the expression cannot be parsed so callers can leave nextRunAt unset
 * rather than throwing during a save.
 */
export function computeNextRunAt(cronExpression: string, after: Date): Date | null {
  try {
    const it = parseExpression(cronExpression, { currentDate: after })
    return it.next().toDate()
  } catch {
    return null
  }
}

export interface ScheduleStore {
  save(schedule: Omit<ScheduleRecord, 'createdAt' | 'updatedAt'>): Promise<ScheduleRecord>
  list(filter?: { enabled?: boolean; tenantId?: string }): Promise<ScheduleRecord[]>
  get(id: string, tenantId?: string): Promise<ScheduleRecord | null>
  update(
    id: string,
    patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt' | 'updatedAt'>>,
    tenantId?: string,
  ): Promise<ScheduleRecord | null>
  delete(id: string, tenantId?: string): Promise<boolean>
  /**
   * Atomically claim due schedules. A schedule is due when enabled and its
   * nextRunAt is <= now (and, when skipIfRunning, not already running). Each
   * claimed schedule is returned to at most one caller: the winner advances
   * nextRunAt so a concurrent call sees nothing.
   */
  claimDue(now: Date, opts: ClaimDueOptions): Promise<ClaimedSchedule[]>
  /**
   * Mark a fired occurrence complete: clears running and records lastFiredAt
   * (and the firing run id in metadata for observability).
   */
  markFired(id: string, occurrence: Date, runId: string): Promise<void>
}

/**
 * In-memory schedule store for development and testing.
 *
 * A clock is injectable so `nextRunAt` derivation and claim stamps are
 * deterministic in tests. JavaScript's single-threaded execution makes the
 * read-check-mutate inside `claimDue` atomic per call, so two sequential calls
 * over the same store yield disjoint claimed sets.
 */
export class InMemoryScheduleStore implements ScheduleStore {
  private readonly schedules = new Map<string, ScheduleRecord>()
  private readonly clock: () => Date

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock
  }

  async save(
    schedule: Omit<ScheduleRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<ScheduleRecord> {
    const now = this.clock().toISOString()
    const existing = this.schedules.get(schedule.id)
    // Derive nextRunAt from the cron expression when the caller did not supply
    // one (keeps existing save() callers working without change).
    let nextRunAt = schedule.nextRunAt
    if (nextRunAt === undefined) {
      const next = computeNextRunAt(schedule.cronExpression, this.clock())
      nextRunAt = next ? next.toISOString() : null
    }
    const record: ScheduleRecord = {
      ...schedule,
      nextRunAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.schedules.set(record.id, record)
    return record
  }

  async list(filter?: { enabled?: boolean; tenantId?: string }): Promise<ScheduleRecord[]> {
    let results = Array.from(this.schedules.values())

    if (filter?.enabled !== undefined) {
      results = results.filter((s) => s.enabled === filter.enabled)
    }
    if (filter?.tenantId !== undefined) {
      results = results.filter((s) => (s.tenantId ?? 'default') === filter.tenantId)
    }

    return results
  }

  async get(id: string, tenantId?: string): Promise<ScheduleRecord | null> {
    const schedule = this.schedules.get(id) ?? null
    if (!schedule) return null
    if (tenantId && (schedule.tenantId ?? 'default') !== tenantId) return null
    return schedule
  }

  async update(
    id: string,
    patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt' | 'updatedAt'>>,
    tenantId?: string,
  ): Promise<ScheduleRecord | null> {
    const existing = await this.get(id, tenantId)
    if (!existing) return null
    const updated: ScheduleRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.clock().toISOString(),
    }
    this.schedules.set(id, updated)
    return updated
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    if (tenantId && !(await this.get(id, tenantId))) return false
    return this.schedules.delete(id)
  }

  async claimDue(now: Date, opts: ClaimDueOptions): Promise<ClaimedSchedule[]> {
    const claimed: ClaimedSchedule[] = []
    const nowMs = now.getTime()
    const stamp = this.clock().toISOString()

    for (const schedule of this.schedules.values()) {
      if (claimed.length >= opts.limit) break
      if (!schedule.enabled) continue
      if (!schedule.nextRunAt) continue
      const dueAt = new Date(schedule.nextRunAt)
      if (dueAt.getTime() > nowMs) continue
      if (opts.skipIfRunning && schedule.running === true) continue

      const occurrences = this.resolveOccurrences(schedule, dueAt, now, opts.maxCatchUp)
      // Advance nextRunAt to the first occurrence strictly after `now`, so a
      // concurrent claim sees nothing (compare-and-set winner).
      const advanced = computeNextRunAt(schedule.cronExpression, now)
      const updated: ScheduleRecord = {
        ...schedule,
        nextRunAt: advanced ? advanced.toISOString() : null,
        claimedBy: opts.claimerId,
        lastClaimedAt: stamp,
        running: opts.skipIfRunning ? true : schedule.running,
        updatedAt: stamp,
      }
      this.schedules.set(schedule.id, updated)

      for (const occurrence of occurrences) {
        if (claimed.length >= opts.limit) break
        claimed.push({ ...updated, occurrence })
      }
    }

    return claimed
  }

  async markFired(id: string, _occurrence: Date, runId: string): Promise<void> {
    const existing = this.schedules.get(id)
    if (!existing) return
    this.schedules.set(id, {
      ...existing,
      running: false,
      lastFiredAt: this.clock().toISOString(),
      metadata: { ...(existing.metadata ?? {}), lastFiredRunId: runId },
      updatedAt: this.clock().toISOString(),
    })
  }

  /**
   * Resolve the occurrences a single claim fires. Default (no maxCatchUp):
   * skip-and-realign — fire once for the original due occurrence. With
   * maxCatchUp > 0: bounded backfill of missed occurrences up to the cap.
   */
  private resolveOccurrences(
    schedule: ScheduleRecord,
    dueAt: Date,
    now: Date,
    maxCatchUp?: number,
  ): Date[] {
    if (!maxCatchUp || maxCatchUp <= 0) return [dueAt]
    const occurrences: Date[] = [dueAt]
    let cursor = dueAt
    while (occurrences.length < maxCatchUp) {
      const next = computeNextRunAt(schedule.cronExpression, cursor)
      if (!next || next.getTime() > now.getTime()) break
      occurrences.push(next)
      cursor = next
    }
    return occurrences
  }
}

interface ScheduleRow {
  id: string
  name: string
  cronExpression: string
  workflowText: string
  enabled: boolean
  metadata: unknown
  tenantId: string
  nextRunAt: Date | null
  running: boolean
  claimedBy: string | null
  lastClaimedAt: Date | null
  lastFiredAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Drizzle-backed schedule store for persistent schedule storage.
 */
export class DrizzleScheduleStore implements ScheduleStore {
  constructor(private readonly db: DrizzleStoreDatabase) {}

  async save(
    schedule: Omit<ScheduleRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<ScheduleRecord> {
    const now = new Date()

    // Try to get existing
    const tenantId = schedule.tenantId ?? 'default'
    const existing = await this.get(schedule.id, tenantId)

    // Derive nextRunAt from the cron expression when not supplied.
    let nextRunAt: Date | null
    if (schedule.nextRunAt !== undefined) {
      nextRunAt = schedule.nextRunAt ? new Date(schedule.nextRunAt) : null
    } else {
      nextRunAt = computeNextRunAt(schedule.cronExpression, now)
    }

    if (existing) {
      const rows = await this.db
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
        .where(and(eq(scheduleConfigs.id, schedule.id), eq(scheduleConfigs.tenantId, tenantId)))
        .returning() as ScheduleRow[]
      const row = rows[0]
      if (!row) throw new Error(`Failed to update schedule ${schedule.id}`)
      return this.rowToRecord(row)
    }

    const rows = await this.db
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
      .returning() as ScheduleRow[]
    const row = rows[0]
    if (!row) throw new Error(`Failed to insert schedule ${schedule.id}`)

    return this.rowToRecord(row)
  }

  async list(filter?: { enabled?: boolean; tenantId?: string }): Promise<ScheduleRecord[]> {
    const conditions = []
    if (filter?.enabled !== undefined) {
      conditions.push(eq(scheduleConfigs.enabled, filter.enabled))
    }
    if (filter?.tenantId !== undefined) {
      conditions.push(eq(scheduleConfigs.tenantId, filter.tenantId))
    }

    const query = this.db.select().from(scheduleConfigs)
    const rows = (conditions.length > 0
      ? await query.where(and(...conditions))
      : await query) as ScheduleRow[]

    return rows.map((r) => this.rowToRecord(r))
  }

  async get(id: string, tenantId?: string): Promise<ScheduleRecord | null> {
    const conditions = [eq(scheduleConfigs.id, id)]
    if (tenantId !== undefined) conditions.push(eq(scheduleConfigs.tenantId, tenantId))

    const rows = await this.db
      .select()
      .from(scheduleConfigs)
      .where(and(...conditions))
      .limit(1)

    const row = rows[0] as ScheduleRow | undefined
    return row ? this.rowToRecord(row) : null
  }

  async update(
    id: string,
    patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt' | 'updatedAt'>>,
    tenantId?: string,
  ): Promise<ScheduleRecord | null> {
    const conditions = [eq(scheduleConfigs.id, id)]
    if (tenantId !== undefined) conditions.push(eq(scheduleConfigs.tenantId, tenantId))

    const rows = await this.db
      .update(scheduleConfigs)
      .set({ ...this.normalizePatch(patch), updatedAt: new Date() })
      .where(and(...conditions))
      .returning()

    const row = rows[0] as ScheduleRow | undefined
    return row ? this.rowToRecord(row) : null
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    const conditions = [eq(scheduleConfigs.id, id)]
    if (tenantId !== undefined) conditions.push(eq(scheduleConfigs.tenantId, tenantId))

    const rows = await this.db
      .delete(scheduleConfigs)
      .where(and(...conditions))
      .returning()
    return rows.length > 0
  }

  async claimDue(now: Date, opts: ClaimDueOptions): Promise<ClaimedSchedule[]> {
    // Read the due candidates first so we can compute each schedule's own next
    // occurrence (cron math cannot run inside a single SET). The disjoint-winner
    // guarantee comes from the per-row atomic UPDATE below, whose WHERE clause
    // (still due + still not running) only one racing caller can satisfy.
    const dueConditions = [
      eq(scheduleConfigs.enabled, true),
      lte(scheduleConfigs.nextRunAt, now),
    ]
    if (opts.skipIfRunning) {
      dueConditions.push(eq(scheduleConfigs.running, false))
    }

    const candidates = (await this.db
      .select()
      .from(scheduleConfigs)
      .where(and(...dueConditions))
      .limit(opts.limit)) as ScheduleRow[]

    const stamp = new Date()
    const claimed: ClaimedSchedule[] = []

    for (const candidate of candidates) {
      if (claimed.length >= opts.limit) break
      const dueAt = candidate.nextRunAt
      if (!dueAt) continue

      const advanced = computeNextRunAt(candidate.cronExpression, now)

      // Atomic compare-and-set: claim only while still due AND (when
      // skipIfRunning) still not running, with nextRunAt unchanged since the
      // read. Two nodes racing this UPDATE yield disjoint winners.
      const claimConditions = [
        eq(scheduleConfigs.id, candidate.id),
        eq(scheduleConfigs.enabled, true),
        lte(scheduleConfigs.nextRunAt, now),
        eq(scheduleConfigs.nextRunAt, dueAt),
      ]
      // skipIfRunning adds the running=false guard: this is the compare-and-set
      // arm that makes two nodes racing the SAME occurrence disjoint winners.
      // Without it, the still-due + unchanged-nextRunAt guards alone enforce
      // single-fire.
      if (opts.skipIfRunning) {
        claimConditions.push(eq(scheduleConfigs.running, false))
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
        .returning()) as ScheduleRow[]

      const won = rows[0]
      if (!won) continue

      const record = this.rowToRecord(won)
      const occurrences = this.resolveOccurrences(candidate, dueAt, now, opts.maxCatchUp)
      for (const occurrence of occurrences) {
        if (claimed.length >= opts.limit) break
        claimed.push({ ...record, occurrence })
      }
    }

    return claimed
  }

  async markFired(id: string, _occurrence: Date, runId: string): Promise<void> {
    const existing = await this.get(id)
    await this.db
      .update(scheduleConfigs)
      .set({
        running: false,
        lastFiredAt: new Date(),
        metadata: { ...(existing?.metadata ?? {}), lastFiredRunId: runId },
        updatedAt: new Date(),
      })
      .where(eq(scheduleConfigs.id, id))
      .returning()
  }

  /** Convert ISO-string date patch fields to Date for the Drizzle columns. */
  private normalizePatch(
    patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...patch }
    if ('nextRunAt' in patch) {
      out.nextRunAt = patch.nextRunAt ? new Date(patch.nextRunAt) : null
    }
    if ('lastClaimedAt' in patch) {
      out.lastClaimedAt = patch.lastClaimedAt ? new Date(patch.lastClaimedAt) : null
    }
    if ('lastFiredAt' in patch) {
      out.lastFiredAt = patch.lastFiredAt ? new Date(patch.lastFiredAt) : null
    }
    return out
  }

  private resolveOccurrences(
    candidate: ScheduleRow,
    dueAt: Date,
    now: Date,
    maxCatchUp?: number,
  ): Date[] {
    if (!maxCatchUp || maxCatchUp <= 0) return [dueAt]
    const occurrences: Date[] = [dueAt]
    let cursor = dueAt
    while (occurrences.length < maxCatchUp) {
      const next = computeNextRunAt(candidate.cronExpression, cursor)
      if (!next || next.getTime() > now.getTime()) break
      occurrences.push(next)
      cursor = next
    }
    return occurrences
  }

  private rowToRecord(row: ScheduleRow): ScheduleRecord {
    return {
      id: row.id,
      name: row.name,
      cronExpression: row.cronExpression,
      workflowText: row.workflowText,
      enabled: row.enabled,
      metadata: row.metadata as Record<string, unknown> | null,
      tenantId: row.tenantId,
      nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
      running: row.running ?? false,
      claimedBy: row.claimedBy ?? null,
      lastClaimedAt: row.lastClaimedAt ? row.lastClaimedAt.toISOString() : null,
      lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }
}
