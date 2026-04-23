import type { DomainToolDefinition } from '../types.js'
import type { ExecutableDomainTool } from './shared.js'

/**
 * pm.* — lightweight in-memory project/task management tools.
 *
 * These tools are intentionally backend-agnostic. They operate on an injected
 * {@link PmTaskStore} so callers (tests, adapters, or production wiring) can
 * replace the default in-memory map with a Postgres-backed, HTTP-backed, or
 * otherwise persistent store without changing the tool surface.
 */

export type PmTaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled'

export interface PmTask {
  id: string
  title: string
  description?: string
  status: PmTaskStatus
  assignee?: string
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
}

export interface PmTaskStore {
  create(task: PmTask): void
  update(id: string, patch: Partial<Omit<PmTask, 'id' | 'createdAt'>>): PmTask | undefined
  get(id: string): PmTask | undefined
  list(filter?: { status?: PmTaskStatus; assignee?: string }): PmTask[]
}

/** Default in-memory PM task store backed by a Map. */
export class InMemoryPmTaskStore implements PmTaskStore {
  private readonly tasks = new Map<string, PmTask>()

  create(task: PmTask): void {
    this.tasks.set(task.id, task)
  }

  update(id: string, patch: Partial<Omit<PmTask, 'id' | 'createdAt'>>): PmTask | undefined {
    const existing = this.tasks.get(id)
    if (!existing) return undefined
    const updated: PmTask = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    return updated
  }

  get(id: string): PmTask | undefined {
    return this.tasks.get(id)
  }

  list(filter?: { status?: PmTaskStatus; assignee?: string }): PmTask[] {
    const all = Array.from(this.tasks.values())
    if (!filter) return all
    return all.filter((t) => {
      if (filter.status !== undefined && t.status !== filter.status) return false
      if (filter.assignee !== undefined && t.assignee !== filter.assignee) return false
      return true
    })
  }
}

// ---------------------------------------------------------------------------
// pm.create_task
// ---------------------------------------------------------------------------

interface CreateTaskInput {
  title: string
  description?: string
  assignee?: string
  status?: PmTaskStatus
}

interface CreateTaskOutput {
  task: PmTask
}

function buildPmCreateTask(
  store: PmTaskStore,
  idFactory: () => string,
  now: () => Date,
): ExecutableDomainTool<CreateTaskInput, CreateTaskOutput> {
  const definition: DomainToolDefinition = {
    name: 'pm.create_task',
    description: 'Create a new task in the project/task store.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        assignee: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'object' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'modifies_external_resource',
        description: 'Creates a task record in the PM task store.',
      },
    ],
    namespace: 'pm',
  }

  return {
    definition,
    async execute(input: CreateTaskInput): Promise<CreateTaskOutput> {
      if (typeof input.title !== 'string' || input.title.trim() === '') {
        throw new Error('pm.create_task requires a non-empty title')
      }
      const iso = now().toISOString()
      const task: PmTask = {
        id: idFactory(),
        title: input.title,
        status: input.status ?? 'open',
        createdAt: iso,
        updatedAt: iso,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      }
      store.create(task)
      return { task }
    },
  }
}

// ---------------------------------------------------------------------------
// pm.update_task
// ---------------------------------------------------------------------------

interface UpdateTaskInput {
  id: string
  title?: string
  description?: string
  status?: PmTaskStatus
  assignee?: string
}

interface UpdateTaskOutput {
  task: PmTask
}

function buildPmUpdateTask(
  store: PmTaskStore,
): ExecutableDomainTool<UpdateTaskInput, UpdateTaskOutput> {
  const definition: DomainToolDefinition = {
    name: 'pm.update_task',
    description: 'Update an existing task by id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
        assignee: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'object' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'modifies_external_resource',
        description: 'Mutates a task record in the PM task store.',
      },
    ],
    namespace: 'pm',
  }

  return {
    definition,
    async execute(input: UpdateTaskInput): Promise<UpdateTaskOutput> {
      const patch: Partial<Omit<PmTask, 'id' | 'createdAt'>> = {}
      if (input.title !== undefined) patch.title = input.title
      if (input.description !== undefined) patch.description = input.description
      if (input.status !== undefined) patch.status = input.status
      if (input.assignee !== undefined) patch.assignee = input.assignee
      const updated = store.update(input.id, patch)
      if (!updated) {
        throw new Error(`pm.update_task: task not found: ${input.id}`)
      }
      return { task: updated }
    },
  }
}

// ---------------------------------------------------------------------------
// pm.get_task
// ---------------------------------------------------------------------------

interface GetTaskInput {
  id: string
}

interface GetTaskOutput {
  task: PmTask | null
}

function buildPmGetTask(store: PmTaskStore): ExecutableDomainTool<GetTaskInput, GetTaskOutput> {
  const definition: DomainToolDefinition = {
    name: 'pm.get_task',
    description: 'Fetch a single task by id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {},
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'pm',
  }

  return {
    definition,
    async execute(input: GetTaskInput): Promise<GetTaskOutput> {
      return { task: store.get(input.id) ?? null }
    },
  }
}

// ---------------------------------------------------------------------------
// pm.list_tasks
// ---------------------------------------------------------------------------

interface ListTasksInput {
  status?: PmTaskStatus
  assignee?: string
}

interface ListTasksOutput {
  tasks: PmTask[]
}

function buildPmListTasks(
  store: PmTaskStore,
): ExecutableDomainTool<ListTasksInput, ListTasksOutput> {
  const definition: DomainToolDefinition = {
    name: 'pm.list_tasks',
    description: 'List tasks, optionally filtered by status or assignee.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
        assignee: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['tasks'],
      properties: {
        tasks: { type: 'array' },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'pm',
  }

  return {
    definition,
    async execute(input: ListTasksInput): Promise<ListTasksOutput> {
      const filter: { status?: PmTaskStatus; assignee?: string } = {}
      if (input.status !== undefined) filter.status = input.status
      if (input.assignee !== undefined) filter.assignee = input.assignee
      return { tasks: store.list(filter) }
    },
  }
}

export function buildPmTools(
  store: PmTaskStore,
  idFactory: () => string,
  now: () => Date,
): ExecutableDomainTool[] {
  return [
    buildPmCreateTask(store, idFactory, now) as unknown as ExecutableDomainTool,
    buildPmUpdateTask(store) as unknown as ExecutableDomainTool,
    buildPmGetTask(store) as unknown as ExecutableDomainTool,
    buildPmListTasks(store) as unknown as ExecutableDomainTool,
  ]
}
