/**
 * A2A (Agent-to-Agent) shared type definitions.
 *
 * Leaf module: must not import from any other a2a/* file. Hosts the type
 * surface shared by the task handler, push notifications, drizzle store, and
 * route helpers so that no two siblings need to import from each other.
 */
import type { OutboundUrlSecurityPolicy } from '@dzupagent/core/security'

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** A2A message part (text, data, or file). */
export interface A2AMessagePart {
  type: string
  text?: string
  data?: Record<string, unknown>
}

/** A2A message within a task conversation. */
export interface A2ATaskMessage {
  role: 'user' | 'agent'
  parts: A2AMessagePart[]
}

/** A2A task artifact. */
export interface A2ATaskArtifact {
  parts: A2AMessagePart[]
  name?: string
  index?: number
}

/** Push notification config stored with a task. */
export interface A2ATaskPushConfig {
  url: string
  token?: string
  events?: string[]
}

export interface A2ATask {
  id: string
  state: A2ATaskState
  input: unknown
  output?: unknown
  agentName: string
  createdAt: string
  updatedAt: string
  error?: string
  metadata?: Record<string, unknown>
  /** Multi-turn conversation history. */
  messages: A2ATaskMessage[]
  /** Task artifacts (code, files, structured data). */
  artifacts: A2ATaskArtifact[]
  /** Push notification configuration for this task. */
  pushNotificationConfig?: A2ATaskPushConfig
  /**
   * RF-SEC-05: Owner scope. Identifier of the API key that created the task.
   * `null` when auth is disabled (single-caller default). Cross-owner access
   * is filtered to a NOT_FOUND response so existence cannot be enumerated.
   */
  ownerId?: string | null
  /**
   * RF-SEC-05: Tenant scope. Tenant id carried by the authenticated key at
   * creation time. Defaults to `'default'` when auth is disabled.
   */
  tenantId?: string | null
}

export interface A2ATaskListFilter {
  agentName?: string
  state?: A2ATaskState
  /** Restrict listing to tasks owned by this API key id. */
  ownerId?: string | null
  /** Restrict listing to tasks within this tenant. */
  tenantId?: string | null
}

export interface A2ATaskStore {
  create(task: Omit<A2ATask, 'id' | 'createdAt' | 'updatedAt' | 'messages' | 'artifacts'>): Promise<A2ATask>
  get(id: string): Promise<A2ATask | null>
  update(id: string, updates: Partial<Pick<A2ATask, 'state' | 'output' | 'error' | 'metadata'>>): Promise<A2ATask | null>
  list(filter?: A2ATaskListFilter): Promise<A2ATask[]>
  /** Append a message to a task's conversation. */
  appendMessage(id: string, message: A2ATaskMessage): Promise<A2ATask | null>
  /** Add an artifact to a task. */
  addArtifact(id: string, artifact: Omit<A2ATaskArtifact, 'index'>): Promise<A2ATask | null>
  /** Set push notification config for a task. */
  setPushConfig(id: string, config: A2ATaskPushConfig): Promise<A2ATask | null>
}

export interface A2ATaskStoreOptions {
  pushNotificationUrlPolicy?: OutboundUrlSecurityPolicy | undefined
}
