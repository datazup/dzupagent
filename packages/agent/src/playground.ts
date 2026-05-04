/**
 * @dzupagent/agent/playground — deprecated multi-agent playground surface.
 *
 * @deprecated The playground experiments are superseded by the team runtime
 * (`@dzupagent/agent/orchestration#TeamRuntime`). Imports remain available for
 * existing consumers but should migrate to `TeamRuntime` and the orchestration
 * subpath.
 */

export { AgentPlayground } from './playground/playground.js'
export type { PlaygroundConfig } from './playground/playground.js'
export { TeamCoordinator } from './playground/team-coordinator.js'
export type {
  AgentRole,
  AgentSpawnConfig,
  CoordinationPattern,
  TeamConfig,
  AgentStatus,
  SpawnedAgent,
  PlaygroundEvent,
  TeamRunResult,
} from './playground/types.js'
