/**
 * Team coordination pattern — strategy contract for `TeamRuntime`.
 *
 * `TeamRuntime` owns the lifecycle (phase transitions, OTel span, event
 * emission, policy validation, circuit-breaker bookkeeping) and delegates
 * the actual participant scheduling + merge logic to a `TeamPattern`.
 *
 * Each of the five coordinator patterns
 * (`supervisor` | `contract_net` | `blackboard` | `peer_to_peer` | `council`)
 * is implemented as a focused strategy module under `./patterns/` that
 * specialises the `BaseTeamCoordinationContract` from
 * `@dzupagent/agent-types` with the concrete agent-side context and result
 * types.
 */

import type { BaseTeamCoordinationContract } from '@dzupagent/agent-types'
import type { KeyedCircuitBreaker } from '@dzupagent/core'
import type { CoordinatorPattern, ParticipantDefinition, TeamDefinition } from '../team-definition.js'
import type { TeamCheckpoint } from '../team-checkpoint.js'
import type { TeamPolicies } from '../team-policy.js'
import type {
  SharedWorkspace,
  TeamRunResult,
  TeamSpawnedAgent,
} from '../team-workspace.js'
import type { TeamOTelSpanLike } from '../team-otel-types.js'

/**
 * Resolved participant + spawned agent pair, surfaced to patterns by the
 * runtime so they don't have to re-resolve participants themselves.
 */
export interface ResolvedParticipant {
  participant: ParticipantDefinition
  spawned: TeamSpawnedAgent
}

/**
 * Hook surface a pattern uses to ask the runtime to emit lifecycle events
 * and update circuit-breaker state. Centralising these hooks keeps
 * patterns free of direct event-bus / breaker plumbing.
 */
export interface TeamPatternHooks {
  /** Emit a `participant_started` lifecycle event. */
  emitParticipantStart(participant: ParticipantDefinition): void
  /**
   * Emit a `participant_completed` lifecycle event AND update the
   * circuit-breaker state on the runtime (success → record success,
   * failure → record failure + maybe trip).
   */
  emitParticipantComplete(
    participant: ParticipantDefinition,
    success: boolean,
    durationMs: number,
    error?: string,
  ): void
  /** Emit a `policy_applied` event for the governance/judgeModel knob. */
  emitPolicyApplied(
    policyGroup: 'governance',
    policyField: 'judgeModel',
  ): void
}

/**
 * Execution context handed to a `TeamPattern` for one `execute` /
 * `resume` call. The runtime constructs this on every invocation.
 */
export interface TeamPatternContext {
  /** The user-supplied task prompt. */
  task: string
  /** ID of the team definition this run is targeting. */
  teamId: string
  /** Stable run ID for this invocation. */
  runId: string
  /** Wall-clock ms when the run started (for duration math). */
  startedAt: number
  /** Original team definition (read-only — patterns must not mutate). */
  definition: TeamDefinition
  /** Effective policies for this run. */
  policies: TeamPolicies
  /** Resolved participants whose circuit is currently closed. */
  participants: ResolvedParticipant[]
  /** Shared, in-memory blackboard — created per-run. */
  workspace: SharedWorkspace
  /** Per-run keyed circuit breaker shared with the runtime. */
  circuitBreaker: KeyedCircuitBreaker
  /** Optional OTel span; patterns may add events to it. */
  otelSpan: TeamOTelSpanLike | undefined
  /** Lifecycle hooks the pattern uses to fan events back to the runtime. */
  hooks: TeamPatternHooks
}

/** Result returned by a pattern's `execute` / `resume`. */
export type TeamPatternResult = TeamRunResult

/**
 * Concrete agent-side specialisation of `BaseTeamCoordinationContract`.
 *
 * Every pattern under `./patterns/` exports an instance of this interface;
 * the runtime keeps a registry mapping `CoordinatorPattern → TeamPattern`.
 */
export type TeamPattern = BaseTeamCoordinationContract<
  CoordinatorPattern,
  TeamPatternContext,
  TeamPatternResult,
  TeamCheckpoint
>
