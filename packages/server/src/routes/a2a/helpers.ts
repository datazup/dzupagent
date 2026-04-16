/**
 * Shared types, constants, and imports for A2A route modules.
 */
import type { AgentCard } from '../../a2a/agent-card.js'
import type { A2ATaskStore } from '../../a2a/task-handler.js'
import type { A2ATask } from '../../a2a/task-handler.js'

export interface A2ARoutesConfig {
  agentCard: AgentCard
  taskStore: A2ATaskStore
  /** Called after a task is created so the host can start execution. */
  onTaskSubmitted?: (task: A2ATask) => Promise<void>
  /** Called when a multi-turn task receives additional input. */
  onTaskContinued?: (task: A2ATask) => Promise<void>
}

/** Known A2A JSON-RPC methods. */
export const A2A_METHODS = new Set([
  'tasks/send',
  'tasks/get',
  'tasks/cancel',
  'tasks/sendSubscribe',
  'tasks/pushNotification/set',
  'tasks/pushNotification/get',
  'tasks/resubscribe',
])
