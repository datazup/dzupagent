/**
 * A2A (Agent-to-Agent) protocol support.
 *
 * Re-exports the agent card builder, task store interface, in-memory store,
 * and Hono route factory.
 */
export { buildAgentCard } from './agent-card.js'
export type { AgentCard, AgentCapability, AgentCardConfig } from './agent-card.js'

export { InMemoryA2ATaskStore } from './task-handler.js'
export { DrizzleA2ATaskStore } from './drizzle-a2a-task-store.js'
export type {
  A2ATask,
  A2ATaskState,
  A2ATaskStore,
  A2AMessagePart,
  A2ATaskMessage,
  A2ATaskArtifact,
  A2ATaskPushConfig,
} from './task-handler.js'

export { createA2ARoutes } from '../routes/a2a.js'
export type { A2ARoutesConfig } from '../routes/a2a.js'

export { createA2AV1Handler } from './v1/request-handler.js'
export type { A2AV1Config, A2AV1HandlerConfig, A2AV1Handler, AgentExecutor, TaskStore } from './v1/request-handler.js'
export { toAgentCardV1 } from './v1/agent-card-v1.js'
export type { AgentCardV1Options } from './v1/agent-card-v1.js'

export { DrizzleA2AV1TaskStore, createDrizzleA2AV1TaskStore } from './v1/drizzle-task-store.js'
