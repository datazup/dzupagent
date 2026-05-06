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
  tenantId?: string | null
  createdAt: string
  updatedAt: string
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
      updatedAt: new Date().toISOString(),
    }
    this.schedules.set(id, updated)
    return updated
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    if (tenantId && !(await this.get(id, tenantId))) return false
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
  tenantId: string
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
      .set({ ...patch, updatedAt: new Date() })
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

  private rowToRecord(row: ScheduleRow): ScheduleRecord {
    return {
      id: row.id,
      name: row.name,
      cronExpression: row.cronExpression,
      workflowText: row.workflowText,
      enabled: row.enabled,
      metadata: row.metadata as Record<string, unknown> | null,
      tenantId: row.tenantId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }
}
