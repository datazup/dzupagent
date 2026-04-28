/**
 * Types for AgentPlayground — a multi-agent workspace for spawning,
 * coordinating, and observing teams of DzupAgent instances.
 */
import type { DzupAgentConfig } from '../agent/agent-types.js'
import type { MergeStrategyFn } from '../orchestration/merge-strategies.js'
import type { BidEvaluationStrategy } from '../orchestration/contract-net/contract-net-types.js'
import type {
  TeamAgentRole,
  TeamAgentStatus,
  TeamRunResult as OrchestrationTeamRunResult,
  TeamSpawnedAgent,
} from '../orchestration/team/team-workspace.js'

// ---------------------------------------------------------------------------
// Agent roles & spawn config
// ---------------------------------------------------------------------------

/**
 * Predefined agent roles that influence coordination behavior.
 * `custom` allows any string description in `roleDescription`.
 */
export type AgentRole =
  TeamAgentRole

/** Configuration for spawning a single agent into the playground. */
export interface AgentSpawnConfig extends Omit<DzupAgentConfig, 'id'> {
  /** Optional explicit ID. Auto-generated if omitted. */
  id?: string
  /** Role this agent plays within the team. */
  role: AgentRole
  /** Human-readable description of this agent's purpose. */
  roleDescription?: string
  /** Tags for filtering / grouping. */
  tags?: string[]
}

// ---------------------------------------------------------------------------
// Coordination patterns
// ---------------------------------------------------------------------------

/**
 * The coordination pattern that determines how agents interact.
 *
 * - `supervisor`: One agent (with role 'supervisor') delegates to the others
 *   via tool calling. Uses `AgentOrchestrator.supervisor`.
 * - `peer-to-peer`: Agents run in parallel, each contributes independently.
 *   Results are merged via a pluggable strategy.
 * - `blackboard`: All agents share a `SharedWorkspace` and operate in rounds.
 *   Each round, every agent reads the workspace, does work, and writes back.
 */
export type CoordinationPattern = 'supervisor' | 'peer-to-peer' | 'blackboard'

/** Configuration for a coordinated team. */
export interface TeamConfig {
  /** How agents coordinate. */
  pattern: CoordinationPattern
  /** Maximum rounds for blackboard pattern (default: 3). */
  maxRounds?: number
  /** Merge strategy for peer-to-peer pattern (default: 'concat'). */
  mergeStrategy?: MergeStrategyFn | 'concat' | 'vote' | 'numbered' | 'json'
  /** Bid evaluation strategy for contract-net (used within supervisor). */
  bidStrategy?: BidEvaluationStrategy
  /** Abort signal for the entire team run. */
  signal?: AbortSignal
  /** Maximum concurrency for parallel patterns (default: 5). */
  concurrency?: number
}

// ---------------------------------------------------------------------------
// Agent status
// ---------------------------------------------------------------------------

/** Lifecycle state of a spawned agent. */
export type AgentStatus = TeamAgentStatus

/** Runtime info for a spawned agent inside the playground. */
export type SpawnedAgent = TeamSpawnedAgent

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Events emitted by the playground observable. */
export type PlaygroundEvent =
  | { type: 'agent:spawned'; agentId: string; role: AgentRole }
  | { type: 'agent:status_changed'; agentId: string; previous: AgentStatus; current: AgentStatus }
  | { type: 'agent:result'; agentId: string; content: string }
  | { type: 'agent:error'; agentId: string; error: string }
  | { type: 'team:started'; pattern: CoordinationPattern; agentCount: number }
  | { type: 'team:round_completed'; round: number; totalRounds: number }
  | { type: 'team:completed'; durationMs: number; result: string }
  | { type: 'team:failed'; error: string }
  | { type: 'workspace:updated'; key: string; agentId?: string }
  | { type: 'broadcast:sent'; message: string }
  | { type: 'playground:shutdown' }

// ---------------------------------------------------------------------------
// Team run result
// ---------------------------------------------------------------------------

/** Result of running a coordinated team task. */
export type TeamRunResult = OrchestrationTeamRunResult
