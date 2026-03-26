/**
 * PostgreSQL implementations of RunStore and AgentStore.
 *
 * Uses Drizzle ORM for type-safe queries against the forge_* tables.
 */
import { eq, desc, and, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { forgeAgents, forgeRuns, forgeRunLogs } from './drizzle-schema.js'
import type {
  RunStore,
  Run,
  CreateRunInput,
  RunFilter,
  RunStatus,
  LogEntry,
  AgentStore,
  AgentDefinition,
  AgentFilter,
} from '@forgeagent/core'

type DB = PostgresJsDatabase<Record<string, never>>

// ---------------------------------------------------------------------------
// PostgresRunStore
// ---------------------------------------------------------------------------

export class PostgresRunStore implements RunStore {
  constructor(private db: DB) {}

  async create(input: CreateRunInput): Promise<Run> {
    const rows = await this.db
      .insert(forgeRuns)
      .values({
        agentId: input.agentId,
        status: 'queued',
        input: input.input as Record<string, unknown>,
        metadata: input.metadata ?? {},
        startedAt: new Date(),
      })
      .returning()
    const row = rows[0]!
    return this.toRun(row)
  }

  async update(id: string, update: Partial<Run>): Promise<void> {
    const values: Record<string, unknown> = {}
    if (update.status !== undefined) values['status'] = update.status
    if (update.output !== undefined) values['output'] = update.output
    if (update.plan !== undefined) values['plan'] = update.plan
    if (update.error !== undefined) values['error'] = update.error
    if (update.completedAt !== undefined) values['completedAt'] = update.completedAt
    if (update.tokenUsage) {
      values['tokenUsageInput'] = update.tokenUsage.input
      values['tokenUsageOutput'] = update.tokenUsage.output
    }
    if (update.costCents !== undefined) values['costCents'] = update.costCents
    if (update.metadata !== undefined) values['metadata'] = update.metadata

    if (Object.keys(values).length > 0) {
      await this.db.update(forgeRuns).set(values).where(eq(forgeRuns.id, id))
    }
  }

  async get(id: string): Promise<Run | null> {
    const rows = await this.db
      .select()
      .from(forgeRuns)
      .where(eq(forgeRuns.id, id))
      .limit(1)
    const row = rows[0]
    return row ? this.toRun(row) : null
  }

  async list(filter?: RunFilter): Promise<Run[]> {
    const conditions: SQL[] = []
    if (filter?.agentId) conditions.push(eq(forgeRuns.agentId, filter.agentId))
    if (filter?.status) conditions.push(eq(forgeRuns.status, filter.status))

    const where = conditions.length > 0 ? and(...conditions) : undefined
    const limit = filter?.limit ?? 50
    const offset = filter?.offset ?? 0

    const rows = await this.db
      .select()
      .from(forgeRuns)
      .where(where)
      .orderBy(desc(forgeRuns.startedAt))
      .limit(limit)
      .offset(offset)

    return rows.map(r => this.toRun(r))
  }

  async addLog(runId: string, entry: LogEntry): Promise<void> {
    await this.db.insert(forgeRunLogs).values({
      runId,
      level: entry.level,
      phase: entry.phase ?? null,
      message: entry.message,
      data: entry.data as Record<string, unknown> | null ?? null,
      timestamp: entry.timestamp ?? new Date(),
    })
  }

  async addLogs(runId: string, entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return
    const now = new Date()
    await this.db.insert(forgeRunLogs).values(
      entries.map(entry => ({
        runId,
        level: entry.level,
        phase: entry.phase ?? null,
        message: entry.message,
        data: entry.data as Record<string, unknown> | null ?? null,
        timestamp: entry.timestamp ?? now,
      })),
    )
  }

  async getLogs(runId: string): Promise<LogEntry[]> {
    const rows = await this.db
      .select()
      .from(forgeRunLogs)
      .where(eq(forgeRunLogs.runId, runId))
      .orderBy(forgeRunLogs.timestamp)

    return rows.map(r => ({
      level: r.level as LogEntry['level'],
      phase: r.phase ?? undefined,
      message: r.message,
      data: r.data ?? undefined,
      timestamp: r.timestamp,
    }))
  }

  private toRun(row: typeof forgeRuns.$inferSelect): Run {
    return {
      id: row.id,
      agentId: row.agentId,
      status: row.status as RunStatus,
      input: row.input,
      output: row.output ?? undefined,
      plan: row.plan ?? undefined,
      tokenUsage: (row.tokenUsageInput || row.tokenUsageOutput)
        ? { input: row.tokenUsageInput ?? 0, output: row.tokenUsageOutput ?? 0 }
        : undefined,
      costCents: row.costCents ?? undefined,
      error: row.error ?? undefined,
      metadata: (row.metadata as Record<string, unknown>) ?? undefined,
      startedAt: row.startedAt,
      completedAt: row.completedAt ?? undefined,
    }
  }
}

// ---------------------------------------------------------------------------
// PostgresAgentStore
// ---------------------------------------------------------------------------

export class PostgresAgentStore implements AgentStore {
  constructor(private db: DB) {}

  async save(agent: AgentDefinition): Promise<void> {
    const existing = await this.get(agent.id)
    if (existing) {
      await this.db
        .update(forgeAgents)
        .set({
          name: agent.name,
          description: agent.description ?? null,
          instructions: agent.instructions,
          modelTier: agent.modelTier,
          tools: agent.tools ?? [],
          guardrails: agent.guardrails ?? null,
          approval: agent.approval ?? 'auto',
          version: (existing.version ?? 0) + 1,
          active: agent.active ?? true,
          metadata: agent.metadata ?? {},
          updatedAt: new Date(),
        })
        .where(eq(forgeAgents.id, agent.id))
    } else {
      await this.db.insert(forgeAgents).values({
        id: agent.id,
        name: agent.name,
        description: agent.description ?? null,
        instructions: agent.instructions,
        modelTier: agent.modelTier,
        tools: agent.tools ?? [],
        guardrails: agent.guardrails ?? null,
        approval: agent.approval ?? 'auto',
        active: agent.active ?? true,
        metadata: agent.metadata ?? {},
      })
    }
  }

  async get(id: string): Promise<AgentDefinition | null> {
    const rows = await this.db
      .select()
      .from(forgeAgents)
      .where(eq(forgeAgents.id, id))
      .limit(1)
    const row = rows[0]
    return row ? this.toAgent(row) : null
  }

  async list(filter?: AgentFilter): Promise<AgentDefinition[]> {
    const conditions: SQL[] = []
    if (filter?.active !== undefined) conditions.push(eq(forgeAgents.active, filter.active))

    const where = conditions.length > 0 ? and(...conditions) : undefined
    const limit = filter?.limit ?? 100

    const rows = await this.db
      .select()
      .from(forgeAgents)
      .where(where)
      .orderBy(desc(forgeAgents.createdAt))
      .limit(limit)

    return rows.map(r => this.toAgent(r))
  }

  async delete(id: string): Promise<void> {
    await this.db
      .update(forgeAgents)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(forgeAgents.id, id))
  }

  private toAgent(row: typeof forgeAgents.$inferSelect): AgentDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      instructions: row.instructions,
      modelTier: row.modelTier,
      tools: (row.tools as string[]) ?? undefined,
      guardrails: (row.guardrails as Record<string, unknown>) ?? undefined,
      approval: row.approval as AgentDefinition['approval'],
      version: row.version,
      active: row.active,
      metadata: (row.metadata as Record<string, unknown>) ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
