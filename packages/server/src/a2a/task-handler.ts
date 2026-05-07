/**
 * A2A Task lifecycle — submit, poll, cancel, multi-turn conversations.
 *
 * Provides a store interface and an in-memory implementation for development.
 *
 * The shared type surface lives in `./a2a-types.js` so that sibling modules
 * (push-notifications, drizzle store, routes) can reference the contract
 * without introducing import cycles. The types are re-exported here for
 * backward compatibility with existing `from './task-handler.js'` consumers.
 */
import { assertA2APushCallbackUrlAllowed } from './push-notifications.js'
import type {
  A2ATask,
  A2ATaskArtifact,
  A2ATaskListFilter,
  A2ATaskMessage,
  A2ATaskPushConfig,
  A2ATaskStore,
  A2ATaskStoreOptions,
} from './a2a-types.js'

export type {
  A2AMessagePart,
  A2ATask,
  A2ATaskArtifact,
  A2ATaskListFilter,
  A2ATaskMessage,
  A2ATaskPushConfig,
  A2ATaskState,
  A2ATaskStore,
  A2ATaskStoreOptions,
} from './a2a-types.js'

/**
 * In-memory A2A task store for development and testing.
 *
 * Tasks are stored in a `Map` and lost on process restart.
 */
export class InMemoryA2ATaskStore implements A2ATaskStore {
  private readonly tasks = new Map<string, A2ATask>()
  private counter = 0

  constructor(private readonly options: A2ATaskStoreOptions = {}) {}

  async create(
    task: Omit<A2ATask, 'id' | 'createdAt' | 'updatedAt' | 'messages' | 'artifacts'>,
  ): Promise<A2ATask> {
    this.counter += 1
    const now = new Date().toISOString()
    // RF-SEC-05: Persist owner/tenant exactly as supplied so the routes can
    // enforce scope on subsequent reads. Undefined collapses to null so the
    // shape stays predictable across stores.
    const record: A2ATask = {
      ...task,
      id: `a2a-task-${this.counter}`,
      createdAt: now,
      updatedAt: now,
      messages: [],
      artifacts: [],
      ownerId: task.ownerId ?? null,
      tenantId: task.tenantId ?? null,
    }
    this.tasks.set(record.id, record)
    return record
  }

  async get(id: string): Promise<A2ATask | null> {
    return this.tasks.get(id) ?? null
  }

  async update(
    id: string,
    updates: Partial<Pick<A2ATask, 'state' | 'output' | 'error' | 'metadata'>>,
  ): Promise<A2ATask | null> {
    const existing = this.tasks.get(id)
    if (!existing) return null

    const updated: A2ATask = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    return updated
  }

  async list(filter?: A2ATaskListFilter): Promise<A2ATask[]> {
    let results = Array.from(this.tasks.values())

    if (filter?.agentName) {
      results = results.filter((t) => t.agentName === filter.agentName)
    }
    if (filter?.state) {
      results = results.filter((t) => t.state === filter.state)
    }
    // RF-SEC-05: scope filtering. Empty/undefined filter values are treated
    // as "no constraint" so unauthenticated single-tenant deployments keep
    // returning every task as before.
    if (filter?.ownerId !== undefined && filter.ownerId !== null) {
      const wanted = filter.ownerId
      results = results.filter((t) => (t.ownerId ?? null) === wanted)
    }
    if (filter?.tenantId !== undefined && filter.tenantId !== null) {
      const wanted = filter.tenantId
      results = results.filter((t) => (t.tenantId ?? null) === wanted)
    }

    return results.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
  }

  async appendMessage(id: string, message: A2ATaskMessage): Promise<A2ATask | null> {
    const existing = this.tasks.get(id)
    if (!existing) return null

    const updated: A2ATask = {
      ...existing,
      messages: [...existing.messages, message],
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    return updated
  }

  async addArtifact(id: string, artifact: Omit<A2ATaskArtifact, 'index'>): Promise<A2ATask | null> {
    const existing = this.tasks.get(id)
    if (!existing) return null

    const indexed: A2ATaskArtifact = {
      ...artifact,
      index: existing.artifacts.length,
    }
    const updated: A2ATask = {
      ...existing,
      artifacts: [...existing.artifacts, indexed],
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    return updated
  }

  async setPushConfig(id: string, config: A2ATaskPushConfig): Promise<A2ATask | null> {
    const existing = this.tasks.get(id)
    if (!existing) return null
    await assertA2APushCallbackUrlAllowed(config.url, this.options.pushNotificationUrlPolicy)

    const updated: A2ATask = {
      ...existing,
      pushNotificationConfig: config,
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    return updated
  }
}
