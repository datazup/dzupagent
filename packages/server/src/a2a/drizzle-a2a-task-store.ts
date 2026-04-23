/**
 * Drizzle-backed A2A task store for persistent task storage across restarts.
 *
 * Implements the same {@link A2ATaskStore} interface as the in-memory store
 * but persists tasks, messages, and artifacts in PostgreSQL via Drizzle ORM.
 */
import { eq, and, desc } from 'drizzle-orm'
import { a2aTasks, a2aTaskMessages } from '../persistence/drizzle-schema.js'
import type {
  A2ATask,
  A2ATaskState,
  A2ATaskStore,
  A2ATaskMessage,
  A2ATaskArtifact,
  A2ATaskPushConfig,
} from './task-handler.js'

/** Minimal Drizzle database interface used by the store. */
export interface DrizzleA2ADatabase {
  select: () => ReturnType<typeof createSelectProxy>
  insert: (table: unknown) => { values: (values: unknown) => { returning: () => Promise<unknown[]> } }
  update: (table: unknown) => { set: (values: unknown) => { where: (condition: unknown) => { returning: () => Promise<unknown[]> } } }
  query?: unknown
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzle = any

 
function createSelectProxy(): never {
  throw new Error('Type-only helper')
}

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
  constructor(private readonly db: AnyDrizzle) {}

  async create(
    task: Omit<A2ATask, 'id' | 'createdAt' | 'updatedAt' | 'messages' | 'artifacts'>,
  ): Promise<A2ATask> {
    const id = crypto.randomUUID()
    const now = new Date()

    const [row] = await this.db
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
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    return this.rowToTask(row as TaskRow, [])
  }

  async get(id: string): Promise<A2ATask | null> {
    const rows = await this.db
      .select()
      .from(a2aTasks)
      .where(eq(a2aTasks.id, id))
      .limit(1)

    const row = rows[0] as TaskRow | undefined
    if (!row) return null

    const messages = await this.db
      .select()
      .from(a2aTaskMessages)
      .where(eq(a2aTaskMessages.taskId, id))
      .orderBy(a2aTaskMessages.id)

    return this.rowToTask(row, messages as MessageRow[])
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
      .returning()

    const row = rows[0] as TaskRow | undefined
    if (!row) return null

    const messages = await this.db
      .select()
      .from(a2aTaskMessages)
      .where(eq(a2aTaskMessages.taskId, id))
      .orderBy(a2aTaskMessages.id)

    const task = this.rowToTask(row, messages as MessageRow[])

    // Push notification on terminal states
    if (updates.state === 'completed' || updates.state === 'failed') {
      void deliverPushNotification(task)
    }

    return task
  }

  async list(filter?: { agentName?: string; state?: A2ATaskState }): Promise<A2ATask[]> {
    const conditions = []
    if (filter?.agentName) {
      conditions.push(eq(a2aTasks.agentName, filter.agentName))
    }
    if (filter?.state) {
      conditions.push(eq(a2aTasks.state, filter.state))
    }

    const query = this.db
      .select()
      .from(a2aTasks)
      .orderBy(desc(a2aTasks.createdAt))

    const rows: TaskRow[] = conditions.length > 0
      ? await query.where(and(...conditions))
      : await query

    // Batch-load messages for all tasks
    const tasks: A2ATask[] = []
    for (const row of rows) {
      const messages = await this.db
        .select()
        .from(a2aTaskMessages)
        .where(eq(a2aTaskMessages.taskId, row.id))
        .orderBy(a2aTaskMessages.id)

      tasks.push(this.rowToTask(row, messages as MessageRow[]))
    }

    return tasks
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
      .returning()

    const row = rows[0] as TaskRow | undefined
    if (!row) return null

    const messages = await this.db
      .select()
      .from(a2aTaskMessages)
      .where(eq(a2aTaskMessages.taskId, id))
      .orderBy(a2aTaskMessages.id)

    return this.rowToTask(row, messages as MessageRow[])
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
