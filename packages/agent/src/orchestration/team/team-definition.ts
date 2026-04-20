/**
 * Team definition types — declarative schema for multi-agent teams.
 *
 * A `TeamDefinition` is a pure data structure that describes *what* the team
 * is (participants, coordination pattern, identity). Runtime concerns such as
 * execution policies, governance, and memory live in `team-policy.ts`, while
 * the actual execution engine lives in `team-runtime.ts`.
 *
 * Keeping definition and policy separate lets the same team shape be reused
 * across different environments (sandboxed vs. live, ephemeral vs. persistent)
 * without duplicating the participant list.
 */

/**
 * The coordination pattern the team uses to make progress on a task.
 *
 * - `supervisor`: A manager agent delegates to specialists via tool calls.
 * - `contract_net`: Participants bid on tasks; a manager awards contracts.
 * - `blackboard`: Participants share a workspace and iterate in rounds.
 * - `peer_to_peer`: Participants run in parallel; results are merged.
 * - `council`: Participants deliberate; a judge picks the best answer.
 */
export type CoordinatorPattern =
  | 'supervisor'
  | 'contract_net'
  | 'blackboard'
  | 'peer_to_peer'
  | 'council'

/** Declarative config for a single team participant. */
export interface ParticipantDefinition {
  /** Stable participant ID, unique within the team. */
  id: string
  /** Role this participant plays (e.g. 'planner', 'reviewer', 'specialist'). */
  role: string
  /** Model identifier, e.g. 'claude-sonnet-4-6'. */
  model: string
  /** Optional system prompt override for this participant. */
  systemPrompt?: string
  /** Optional capability tags used by routing / bid evaluation. */
  capabilities?: string[]
}

/** Declarative config for an entire team. */
export interface TeamDefinition {
  /** Stable team ID. */
  id: string
  /** Human-readable team name. */
  name: string
  /** Coordination pattern the runtime will use. */
  coordinatorPattern: CoordinatorPattern
  /** Participants in the team, in declaration order. */
  participants: ParticipantDefinition[]
  /** Optional human-readable description. */
  description?: string
}
