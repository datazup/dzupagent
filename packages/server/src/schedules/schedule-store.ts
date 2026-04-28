/**
 * Schedule persistence — in-memory and Drizzle-backed stores for cron-based schedule configs.
 *
 * Schedules define cron-based triggers that execute workflow text on a
 * recurring basis. Each schedule has a name, cron expression, workflow text,
 * and an enabled flag.
 */
import { eq, and } from 'drizzle-orm'
import { scheduleConfigs } from '../persistence/drizzle-schema.js'
import type { DrizzleStoreDatabase } from '../persistence/drizzle-store-types.js'

export interface ScheduleRecord {
  id: string
  name: string
  cronExpression: string
  workflowText: string
  enabled: boolean
  metadata?: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface ScheduleStore {
  save(schedule: Omit<ScheduleRecord, 'createdAt' | 'updatedAt'>): Promise<ScheduleRecord>
  list(filter?: { enabled?: boolean }): Promise<ScheduleRecord[]>
  get(id: string): Promise<ScheduleRecord | null>
  update(id: string, patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ScheduleRecord | null>
  delete(id: string): Promise<boolean>
}

/**
 * In-memory schedule store for development and testing.
 */
export class InMemoryScheduleStore implements ScheduleStore {
  private readonly schedules = new Map<string, ScheduleRecord>()

  async save(
    schedule: Omit<ScheduleRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<ScheduleRecord> {
    const now = new Date().toISOString()
    const existing = this.schedules.get(schedule.id)
    const record: ScheduleRecord = {
      ...schedule,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.schedules.set(record.id, record)
    return record
  }

  async list(filter?: { enabled?: boolean }): Promise<ScheduleRecord[]> {
    let results = Array.from(this.schedules.values())

    if (filter?.enabled !== undefined) {
      results = results.filter((s) => s.enabled === filter.enabled)
    }

    return results
  }

  async get(id: string): Promise<ScheduleRecord | null> {
    return this.schedules.get(id) ?? null
  }

  async update(
    id: string,
    patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<ScheduleRecord | null> {
    const existing = this.schedules.get(id)
    if (!existing) return null
    const updated: ScheduleRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }
    this.schedules.set(id, updated)
    return updated
  }

  async delete(id: string): Promise<boolean> {
    return this.schedules.delete(id)
  }
}

interface ScheduleRow {
  id: string
  name: string
  cronExpression: string
  workflowText: string
  enabled: boolean
  metadata: unknown
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
    const existing = await this.get(schedule.id)

    if (existing) {
      const rows = await this.db
        .update(scheduleConfigs)
        .set({
          name: schedule.name,
          cronExpression: schedule.cronExpression,
          workflowText: schedule.workflowText,
          enabled: schedule.enabled,
          metadata: schedule.metadata ?? null,
          updatedAt: now,
        })
        .where(eq(scheduleConfigs.id, schedule.id))
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
        createdAt: now,
        updatedAt: now,
      })
      .returning() as ScheduleRow[]
    const row = rows[0]
    if (!row) throw new Error(`Failed to insert schedule ${schedule.id}`)

    return this.rowToRecord(row)
  }

  async list(filter?: { enabled?: boolean }): Promise<ScheduleRecord[]> {
    const conditions = []
    if (filter?.enabled !== undefined) {
      conditions.push(eq(scheduleConfigs.enabled, filter.enabled))
    }

    const query = this.db.select().from(scheduleConfigs)
    const rows = (conditions.length > 0
      ? await query.where(and(...conditions))
      : await query) as ScheduleRow[]

    return rows.map((r) => this.rowToRecord(r))
  }

  async get(id: string): Promise<ScheduleRecord | null> {
    const rows = await this.db
      .select()
      .from(scheduleConfigs)
      .where(eq(scheduleConfigs.id, id))
      .limit(1)

    const row = rows[0] as ScheduleRow | undefined
    return row ? this.rowToRecord(row) : null
  }

  async update(
    id: string,
    patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<ScheduleRecord | null> {
    const rows = await this.db
      .update(scheduleConfigs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(scheduleConfigs.id, id))
      .returning()

    const row = rows[0] as ScheduleRow | undefined
    return row ? this.rowToRecord(row) : null
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(scheduleConfigs)
      .where(eq(scheduleConfigs.id, id))
      .returning()
    return rows.length > 0
  }

  private rowToRecord(row: ScheduleRow): ScheduleRecord {
    return {
      id: row.id,
      name: row.name,
      cronExpression: row.cronExpression,
      workflowText: row.workflowText,
      enabled: row.enabled,
      metadata: row.metadata as Record<string, unknown> | null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }
}
