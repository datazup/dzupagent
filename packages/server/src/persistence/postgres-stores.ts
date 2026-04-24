/**
 * PostgreSQL implementations of RunStore and the execution-spec store.
 *
 * Uses Drizzle ORM for type-safe queries against the forge_* tables.
 */
import { eq, desc, and, sql, asc, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { dzipAgents, forgeRuns, forgeRunLogs, forgeVectors } from './drizzle-schema.js'
import { cosineDistance, l2Distance, innerProduct } from './vector-ops.js'
import type {
  RunStore,
  Run,
  CreateRunInput,
  RunFilter,
  RunStatus,
  LogEntry,
  AgentExecutionSpecStore,
  AgentExecutionSpec,
  AgentExecutionSpecFilter,
} from '@dzupagent/core'

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
        ownerId: input.ownerId ?? null,
        tenantId: input.tenantId ?? 'default',
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
    if (filter?.tenantId) conditions.push(eq(forgeRuns.tenantId, filter.tenantId))

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

  async count(filter?: RunFilter): Promise<number> {
    const conditions: SQL[] = []
    if (filter?.agentId) conditions.push(eq(forgeRuns.agentId, filter.agentId))
    if (filter?.status) conditions.push(eq(forgeRuns.status, filter.status))
    if (filter?.tenantId) conditions.push(eq(forgeRuns.tenantId, filter.tenantId))

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(forgeRuns)
      .where(where)

    return rows[0]?.count ?? 0
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
      ownerId: row.ownerId ?? null,
      tenantId: row.tenantId ?? 'default',
      startedAt: row.startedAt,
      completedAt: row.completedAt ?? undefined,
    }
  }
}

// ---------------------------------------------------------------------------
// PostgresAgentStore
// ---------------------------------------------------------------------------

export class PostgresAgentStore implements AgentExecutionSpecStore {
  constructor(private db: DB) {}

  async save(agent: AgentExecutionSpec): Promise<void> {
    const existing = await this.get(agent.id)
    if (existing) {
      await this.db
        .update(dzipAgents)
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
          ...(agent.tenantId != null ? { tenantId: agent.tenantId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(dzipAgents.id, agent.id))
    } else {
      await this.db.insert(dzipAgents).values({
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
        tenantId: agent.tenantId ?? 'default',
      })
    }
  }

  async get(id: string): Promise<AgentExecutionSpec | null> {
    const rows = await this.db
      .select()
      .from(dzipAgents)
      .where(eq(dzipAgents.id, id))
      .limit(1)
    const row = rows[0]
    return row ? this.toAgent(row) : null
  }

  async list(filter?: AgentExecutionSpecFilter): Promise<AgentExecutionSpec[]> {
    const conditions: SQL[] = []
    if (filter?.active !== undefined) conditions.push(eq(dzipAgents.active, filter.active))
    if (filter?.tenantId) conditions.push(eq(dzipAgents.tenantId, filter.tenantId))

    const where = conditions.length > 0 ? and(...conditions) : undefined
    const limit = filter?.limit ?? 100

    const rows = await this.db
      .select()
      .from(dzipAgents)
      .where(where)
      .orderBy(desc(dzipAgents.createdAt))
      .limit(limit)

    return rows.map(r => this.toAgent(r))
  }

  async delete(id: string): Promise<void> {
    await this.db
      .update(dzipAgents)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(dzipAgents.id, id))
  }

  private toAgent(row: typeof dzipAgents.$inferSelect): AgentExecutionSpec {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      instructions: row.instructions,
      modelTier: row.modelTier,
      tools: (row.tools as string[]) ?? undefined,
      guardrails: (row.guardrails as Record<string, unknown>) ?? undefined,
      approval: row.approval as AgentExecutionSpec['approval'],
      version: row.version,
      active: row.active,
      metadata: (row.metadata as Record<string, unknown>) ?? undefined,
      tenantId: row.tenantId ?? 'default',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}

// ---------------------------------------------------------------------------
// DrizzleVectorStore — General-purpose vector storage via forge_vectors
// ---------------------------------------------------------------------------

/** Distance metric used for vector similarity search. */
export type VectorDistanceMetric = 'cosine' | 'l2' | 'inner_product'

/** A single vector entry for upsert. */
export interface VectorEntry {
  /** Unique key within the collection. */
  key: string
  /** The embedding vector (must match table dimensionality). */
  embedding: number[]
  /** Optional JSON metadata for filtering. */
  metadata?: Record<string, unknown>
  /** Original text that was embedded. */
  text?: string
}

/** A search result from the vector store. */
export interface VectorSearchResult {
  key: string
  distance: number
  embedding: number[]
  metadata: Record<string, unknown>
  text: string | null
}

/** Options for vector similarity search. */
export interface VectorSearchOptions {
  /** Query vector to compare against. */
  queryVector: number[]
  /** Maximum number of results to return (default: 10). */
  limit?: number
  /** Distance metric to use (default: 'cosine'). */
  metric?: VectorDistanceMetric
}

/**
 * Drizzle-native vector store backed by the `forge_vectors` table.
 *
 * Provides upsert, search, and delete operations using pgvector distance
 * functions through Drizzle's SQL template system.
 *
 * @example
 * ```ts
 * const store = new DrizzleVectorStore(db)
 * await store.upsert('my-collection', [
 *   { key: 'doc-1', embedding: [0.1, 0.2, ...], text: 'Hello world' },
 * ])
 * const results = await store.search('my-collection', {
 *   queryVector: [0.1, 0.2, ...],
 *   limit: 5,
 * })
 * ```
 */
export class DrizzleVectorStore {
  constructor(private db: DB) {}

  /**
   * Insert or update vector entries in a collection.
   * Uses ON CONFLICT (collection, key) DO UPDATE for upsert semantics.
   */
  async upsert(collection: string, entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return

    const now = new Date()
    for (const entry of entries) {
      await this.db
        .insert(forgeVectors)
        .values({
          collection,
          key: entry.key,
          embedding: entry.embedding,
          metadata: entry.metadata ?? {},
          text: entry.text ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [forgeVectors.collection, forgeVectors.key],
          set: {
            embedding: entry.embedding,
            metadata: entry.metadata ?? {},
            text: entry.text ?? null,
            updatedAt: now,
          },
        })
    }
  }

  /**
   * Search for the nearest vectors in a collection.
   *
   * @param collection - The collection to search within.
   * @param options - Query vector, limit, and distance metric.
   * @returns Sorted results (nearest first) with distance scores.
   */
  async search(
    collection: string,
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    const { queryVector, limit = 10, metric = 'cosine' } = options

    const distanceFn = this.getDistanceFn(metric)
    const distanceExpr = distanceFn(forgeVectors.embedding, queryVector)

    const rows = await this.db
      .select({
        key: forgeVectors.key,
        distance: distanceExpr,
        embedding: forgeVectors.embedding,
        metadata: forgeVectors.metadata,
        text: forgeVectors.text,
      })
      .from(forgeVectors)
      .where(eq(forgeVectors.collection, collection))
      .orderBy(asc(distanceExpr))
      .limit(limit)

    return rows.map((row) => ({
      key: row.key,
      distance: Number(row.distance),
      embedding: row.embedding ?? [],
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      text: row.text,
    }))
  }

  /**
   * Delete a specific entry from a collection by key.
   */
  async delete(collection: string, key: string): Promise<void> {
    await this.db
      .delete(forgeVectors)
      .where(
        and(
          eq(forgeVectors.collection, collection),
          eq(forgeVectors.key, key),
        ),
      )
  }

  /**
   * Delete all entries in a collection.
   */
  async deleteCollection(collection: string): Promise<void> {
    await this.db
      .delete(forgeVectors)
      .where(eq(forgeVectors.collection, collection))
  }

  /**
   * List all distinct collection names in the vector store.
   */
  async listCollections(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ collection: forgeVectors.collection })
      .from(forgeVectors)
      .orderBy(asc(forgeVectors.collection))

    return rows.map((r) => r.collection)
  }

  /**
   * Count entries in a collection.
   */
  async count(collection: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(forgeVectors)
      .where(eq(forgeVectors.collection, collection))

    return rows[0]?.count ?? 0
  }

  private getDistanceFn(
    metric: VectorDistanceMetric,
  ): (column: typeof forgeVectors.embedding, vector: number[]) => SQL {
    switch (metric) {
      case 'cosine':
        return cosineDistance
      case 'l2':
        return l2Distance
      case 'inner_product':
        return innerProduct
    }
  }
}
