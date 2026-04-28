/**
 * Drizzle-backed A2A task store for persistent task storage across restarts.
 *
 * Implements the same {@link A2ATaskStore} interface as the in-memory store
 * but persists tasks, messages, and artifacts in PostgreSQL via Drizzle ORM.
 */
import { eq, and, desc, inArray } from 'drizzle-orm'
import { a2aTasks, a2aTaskMessages } from '../persistence/drizzle-schema.js'
import type { DrizzleStoreDatabase } from '../persistence/drizzle-store-types.js'
import type {
  A2ATask,
  A2ATaskState,
  A2ATaskStore,
  A2ATaskListFilter,
  A2ATaskMessage,
  A2ATaskArtifact,
  A2ATaskPushConfig,
} from './task-handler.js'

/**
 * Deliver a push notification to the task's configured URL.
 * Best-effort: errors are caught and logged, never thrown.
 */
async function deliverPushNotification(task: A2ATask): Promise<void> {
  const config = task.pushNotificationConfig
  if (!config?.url) return

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.token) {
      headers['Authorization'] = `Bearer ${config.token}`
    }
    await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(task),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // Best-effort — don't fail the update
  }
}

export class DrizzleA2ATaskStore implements A2ATaskStore {
  constructor(private readonly db: DrizzleStoreDatabase) {}

  async create(
    task: Omit<A2ATask, 'id' | 'createdAt' | 'updatedAt' | 'messages' | 'artifacts'>,
  ): Promise<A2ATask> {
    const id = crypto.randomUUID()
    const now = new Date()

    const rows = await this.db
      .insert(a2aTasks)
      .values({
        id,
        agentName: task.agentName,
        state: task.state,
        input: task.input,
        output: task.output ?? null,
        error: task.error ?? null,
        metadata: task.metadata ?? null,
        pushNotificationConfig: task.pushNotificationConfig ?? null,
        artifacts: [],
        // RF-SEC-05: stamp owner + tenant so subsequent reads can be scoped.
        ownerId: task.ownerId ?? null,
        tenantId: task.tenantId ?? 'default',
        createdAt: now,
        updatedAt: now,
      })
      .returning() as TaskRow[]
    const row = rows[0]
    if (!row) throw new Error(`Failed to insert A2A task ${id}`)

    return this.rowToTask(row, [])
  }

  async get(id: string): Promise<A2ATask | null> {
    const rows = await this.db
      .select()
      .from(a2aTasks)
      .where(eq(a2aTasks.id, id))
      .limit(1) as TaskRow[]

    const row = rows[0]
    if (!row) return null

    const messages = await this.db
      .select()
      .from(a2aTaskMessages)
      .where(eq(a2aTaskMessages.taskId, id))
      .orderBy(a2aTaskMessages.id) as MessageRow[]

    return this.rowToTask(row, messages)
  }

  async update(
    id: string,
    updates: Partial<Pick<A2ATask, 'state' | 'output' | 'error' | 'metadata'>>,
  ): Promise<A2ATask | null> {
    const now = new Date()

    const setValues: Record<string, unknown> = { updatedAt: now }
    if (updates.state !== undefined) setValues['state'] = updates.state
    if (updates.output !== undefined) setValues['output'] = updates.output
    if (updates.error !== undefined) setValues['error'] = updates.error
    if (updates.metadata !== undefined) setValues['metadata'] = updates.metadata

    const rows = await this.db
      .update(a2aTasks)
      .set(setValues)
      .where(eq(a2aTasks.id, id))
      .returning() as TaskRow[]

    const row = rows[0]
    if (!row) return null

    const messages = await this.db
      .select()
      .from(a2aTaskMessages)
      .where(eq(a2aTaskMessages.taskId, id))
      .orderBy(a2aTaskMessages.id) as MessageRow[]

    const task = this.rowToTask(row, messages)

    // Push notification on terminal states
    if (updates.state === 'completed' || updates.state === 'failed') {
      void deliverPushNotification(task)
    }

    return task
  }

  async list(filter?: A2ATaskListFilter): Promise<A2ATask[]> {
    const conditions = []
    if (filter?.agentName) {
      conditions.push(eq(a2aTasks.agentName, filter.agentName))
    }
    if (filter?.state) {
      conditions.push(eq(a2aTasks.state, filter.state))
    }
    // RF-SEC-05: enforce owner + tenant filters at the SQL level so other
    // tenants' rows never leave the database. Empty values fall through to
    // the un-scoped behaviour for unauthenticated single-tenant servers.
    if (filter?.ownerId !== undefined && filter.ownerId !== null) {
      conditions.push(eq(a2aTasks.ownerId, filter.ownerId))
    }
    if (filter?.tenantId !== undefined && filter.tenantId !== null) {
      conditions.push(eq(a2aTasks.tenantId, filter.tenantId))
    }

    const query = this.db
      .select()
      .from(a2aTasks)
      .orderBy(desc(a2aTasks.createdAt))

    const rows = (conditions.length > 0
      ? await query.where(and(...conditions))
      : await query) as TaskRow[]

    if (rows.length === 0) return []

    const taskIds = rows.map((row) => row.id)
    const messages = await this.db
      .select()
      .from(a2aTaskMessages)
      .where(inArray(a2aTaskMessages.taskId, taskIds))
      .orderBy(a2aTaskMessages.id) as MessageRow[]

    const messagesByTaskId = new Map<string, MessageRow[]>()
    for (const message of messages) {
      const taskMessages = messagesByTaskId.get(message.taskId)
      if (taskMessages) {
        taskMessages.push(message)
      } else {
        messagesByTaskId.set(message.taskId, [message])
      }
    }

    return rows.map((row) => this.rowToTask(row, messagesByTaskId.get(row.id) ?? []))
  }

  async appendMessage(id: string, message: A2ATaskMessage): Promise<A2ATask | null> {
    // Verify task exists
    const existing = await this.get(id)
    if (!existing) return null

    await this.db
      .insert(a2aTaskMessages)
      .values({
        taskId: id,
        role: message.role,
        parts: message.parts,
      })
      .returning()

    await this.db
      .update(a2aTasks)
      .set({ updatedAt: new Date() })
      .where(eq(a2aTasks.id, id))

    return this.get(id)
  }

  async addArtifact(
    id: string,
    artifact: Omit<A2ATaskArtifact, 'index'>,
  ): Promise<A2ATask | null> {
    const existing = await this.get(id)
    if (!existing) return null

    const indexed: A2ATaskArtifact = {
      ...artifact,
      index: existing.artifacts.length,
    }

    const newArtifacts = [...existing.artifacts, indexed]

    await this.db
      .update(a2aTasks)
      .set({
        artifacts: newArtifacts,
        updatedAt: new Date(),
      })
      .where(eq(a2aTasks.id, id))

    return this.get(id)
  }

  async setPushConfig(id: string, config: A2ATaskPushConfig): Promise<A2ATask | null> {
    const rows = await this.db
      .update(a2aTasks)
      .set({
        pushNotificationConfig: config,
        updatedAt: new Date(),
      })
      .where(eq(a2aTasks.id, id))
      .returning() as TaskRow[]

    const row = rows[0]
    if (!row) return null

    const messages = await this.db
      .select()
      .from(a2aTaskMessages)
      .where(eq(a2aTaskMessages.taskId, id))
      .orderBy(a2aTaskMessages.id) as MessageRow[]

    return this.rowToTask(row, messages)
  }

  private rowToTask(row: TaskRow, messages: MessageRow[]): A2ATask {
    const task: A2ATask = {
      id: row.id,
      agentName: row.agentName,
      state: row.state as A2ATaskState,
      input: row.input,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      messages: messages.map((m) => ({
        role: m.role as 'user' | 'agent',
        parts: m.parts,
      })),
      artifacts: (row.artifacts ?? []) as A2ATaskArtifact[],
      // RF-SEC-05: surface scope so route handlers can perform owner checks
      // without re-reading the row.
      ownerId: row.ownerId ?? null,
      tenantId: row.tenantId ?? null,
    }

    if (row.output !== null && row.output !== undefined) task.output = row.output
    if (row.error !== null && row.error !== undefined) task.error = row.error
    if (row.metadata !== null && row.metadata !== undefined) task.metadata = row.metadata as Record<string, unknown>
    if (row.pushNotificationConfig !== null && row.pushNotificationConfig !== undefined) {
      task.pushNotificationConfig = row.pushNotificationConfig as A2ATaskPushConfig
    }

    return task
  }
}

interface TaskRow {
  id: string
  agentName: string
  state: string
  input: unknown
  output: unknown
  error: string | null
  metadata: unknown
  pushNotificationConfig: unknown
  artifacts: unknown
  ownerId: string | null
  tenantId: string | null
  createdAt: Date
  updatedAt: Date
}

interface MessageRow {
  id: number
  taskId: string
  role: string
  parts: Array<{ type: string; text?: string; data?: Record<string, unknown> }>
  createdAt: Date
}
