/** @deprecated Use TeamRuntime for production multi-agent orchestration. AgentPlayground remains available for interactive exploration. */
export { AgentPlayground } from './playground.js'
export type { PlaygroundConfig } from './playground.js'
export { TeamCoordinator } from './team-coordinator.js'
export type {
  AgentRole,
  AgentSpawnConfig,
  CoordinationPattern,
  TeamConfig,
  AgentStatus,
  SpawnedAgent,
  PlaygroundEvent,
  TeamRunResult,
} from './types.js'
