/**
 * Trigger persistence — in-memory and Drizzle-backed stores for trigger configs.
 *
 * Triggers define how agent runs are automatically started: via cron schedule,
 * incoming webhook, or chain reaction from another agent's completion.
 */
import { eq, and } from 'drizzle-orm'
import { triggerConfigs } from '../persistence/drizzle-schema.js'

export type TriggerType = 'cron' | 'webhook' | 'chain'

export interface TriggerConfigRecord {
  id: string
  type: TriggerType
  agentId: string
  schedule?: string | null
  webhookSecret?: string | null
  afterAgentId?: string | null
  enabled: boolean
  metadata?: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface TriggerStore {
  save(trigger: Omit<TriggerConfigRecord, 'createdAt' | 'updatedAt'>): Promise<TriggerConfigRecord>
  list(filter?: { agentId?: string; enabled?: boolean }): Promise<TriggerConfigRecord[]>
  get(id: string): Promise<TriggerConfigRecord | null>
  delete(id: string): Promise<boolean>
  setEnabled(id: string, enabled: boolean): Promise<TriggerConfigRecord | null>
}

/**
 * In-memory trigger store for development and testing.
 */
export class InMemoryTriggerStore implements TriggerStore {
  private readonly triggers = new Map<string, TriggerConfigRecord>()

  async save(
    trigger: Omit<TriggerConfigRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<TriggerConfigRecord> {
    const now = new Date().toISOString()
    const existing = this.triggers.get(trigger.id)
    const record: TriggerConfigRecord = {
      ...trigger,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.triggers.set(record.id, record)
    return record
  }

  async list(filter?: { agentId?: string; enabled?: boolean }): Promise<TriggerConfigRecord[]> {
    let results = Array.from(this.triggers.values())

    if (filter?.agentId !== undefined) {
      results = results.filter((t) => t.agentId === filter.agentId)
    }
    if (filter?.enabled !== undefined) {
      results = results.filter((t) => t.enabled === filter.enabled)
    }

    return results
  }

  async get(id: string): Promise<TriggerConfigRecord | null> {
    return this.triggers.get(id) ?? null
  }

  async delete(id: string): Promise<boolean> {
    return this.triggers.delete(id)
  }

  async setEnabled(id: string, enabled: boolean): Promise<TriggerConfigRecord | null> {
    const existing = this.triggers.get(id)
    if (!existing) return null
    const updated: TriggerConfigRecord = {
      ...existing,
      enabled,
      updatedAt: new Date().toISOString(),
    }
    this.triggers.set(id, updated)
    return updated
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzle = any

interface TriggerRow {
  id: string
  type: string
  agentId: string
  schedule: string | null
  webhookSecret: string | null
  afterAgentId: string | null
  enabled: boolean
  metadata: unknown
  createdAt: Date
  updatedAt: Date
}

/**
 * Drizzle-backed trigger store for persistent trigger storage.
 */
export class DrizzleTriggerStore implements TriggerStore {
  constructor(private readonly db: AnyDrizzle) {}

  async save(
    trigger: Omit<TriggerConfigRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<TriggerConfigRecord> {
    const now = new Date()

    // Try to get existing
    const existing = await this.get(trigger.id)

    if (existing) {
      const [row] = await this.db
        .update(triggerConfigs)
        .set({
          type: trigger.type,
          agentId: trigger.agentId,
          schedule: trigger.schedule ?? null,
          webhookSecret: trigger.webhookSecret ?? null,
          afterAgentId: trigger.afterAgentId ?? null,
          enabled: trigger.enabled,
          metadata: trigger.metadata ?? null,
          updatedAt: now,
        })
        .where(eq(triggerConfigs.id, trigger.id))
        .returning()
      return this.rowToRecord(row as TriggerRow)
    }

    const [row] = await this.db
      .insert(triggerConfigs)
      .values({
        id: trigger.id,
        type: trigger.type,
        agentId: trigger.agentId,
        schedule: trigger.schedule ?? null,
        webhookSecret: trigger.webhookSecret ?? null,
        afterAgentId: trigger.afterAgentId ?? null,
        enabled: trigger.enabled,
        metadata: trigger.metadata ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    return this.rowToRecord(row as TriggerRow)
  }

  async list(filter?: { agentId?: string; enabled?: boolean }): Promise<TriggerConfigRecord[]> {
    const conditions = []
    if (filter?.agentId !== undefined) {
      conditions.push(eq(triggerConfigs.agentId, filter.agentId))
    }
    if (filter?.enabled !== undefined) {
      conditions.push(eq(triggerConfigs.enabled, filter.enabled))
    }

    const query = this.db.select().from(triggerConfigs)
    const rows: TriggerRow[] = conditions.length > 0
      ? await query.where(and(...conditions))
      : await query

    return rows.map((r) => this.rowToRecord(r))
  }

  async get(id: string): Promise<TriggerConfigRecord | null> {
    const rows = await this.db
      .select()
      .from(triggerConfigs)
      .where(eq(triggerConfigs.id, id))
      .limit(1)

    const row = rows[0] as TriggerRow | undefined
    return row ? this.rowToRecord(row) : null
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(triggerConfigs)
      .where(eq(triggerConfigs.id, id))
      .returning()
    return rows.length > 0
  }

  async setEnabled(id: string, enabled: boolean): Promise<TriggerConfigRecord | null> {
    const rows = await this.db
      .update(triggerConfigs)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(triggerConfigs.id, id))
      .returning()

    const row = rows[0] as TriggerRow | undefined
    return row ? this.rowToRecord(row) : null
  }

  private rowToRecord(row: TriggerRow): TriggerConfigRecord {
    return {
      id: row.id,
      type: row.type as TriggerType,
      agentId: row.agentId,
      schedule: row.schedule,
      webhookSecret: row.webhookSecret,
      afterAgentId: row.afterAgentId,
      enabled: row.enabled,
      metadata: row.metadata as Record<string, unknown> | null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }
}
