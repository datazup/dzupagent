/**
 * TeamRuntime — production-grade execution engine for declarative teams.
 *
 * This is the promoted successor to `playground/team-coordinator.ts`. Whereas
 * the playground coordinator is geared toward interactive, in-memory agent
 * wiring, `TeamRuntime` consumes a declarative `TeamDefinition` + `TeamPolicies`
 * pair and delegates to the right coordination primitive based on
 * `coordinatorPattern`.
 *
 * Supported patterns:
 *   - supervisor    — manager delegates to specialists
 *   - contract_net  — participants bid, manager awards contracts
 *   - blackboard    — shared workspace, multi-round iteration
 *   - peer_to_peer  — parallel execution with merge
 *   - council       — deliberation judged by a governance model
 *
 * The runtime emits typed lifecycle events through a caller-supplied callback
 * so that observability, telemetry, and UI streaming can all plug in without
 * the runtime knowing about them.
 *
 * NOTE: This file intentionally ships as a structural skeleton — the
 * pattern-specific private methods contain the delegation scaffolding, phase
 * management, and event plumbing, but do not yet invoke real LLMs. Concrete
 * LLM wiring is layered in by higher-level product code (e.g. codev-app) that
 * supplies agent instances and bid strategies.
 */

import type { SpawnedAgent, TeamRunResult } from '../../playground/types.js'
import type {
  CoordinatorPattern,
  ParticipantDefinition,
  TeamDefinition,
} from './team-definition.js'
import type { TeamPolicies } from './team-policy.js'
import type { TeamPhase, TeamPhaseModel } from './team-phase.js'

// Recommended model constants — exported for downstream wiring code that needs
// to align participant/router/governance choices with the framework defaults.
/** Cheap, fast model for routing and bid evaluation. */
export const DEFAULT_ROUTER_MODEL = 'claude-haiku-4-5-20251001'
/** Default participant model when a `ParticipantDefinition` omits one. */
export const DEFAULT_PARTICIPANT_MODEL = 'claude-sonnet-4-6'
/** Default governance / evaluation / council judge model. */
export const DEFAULT_GOVERNANCE_MODEL = 'claude-opus-4-7'

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Lifecycle events emitted by `TeamRuntime.execute`. */
export type TeamRuntimeEvent =
  | {
      type: 'phase_changed'
      teamId: string
      runId: string
      from: TeamPhase
      to: TeamPhase
      at: Date
    }
  | {
      type: 'participant_started'
      teamId: string
      runId: string
      participantId: string
      role: string
      at: Date
    }
  | {
      type: 'participant_completed'
      teamId: string
      runId: string
      participantId: string
      role: string
      success: boolean
      error?: string
      durationMs: number
      at: Date
    }
  | {
      type: 'team_completed'
      teamId: string
      runId: string
      durationMs: number
      at: Date
    }
  | {
      type: 'team_failed'
      teamId: string
      runId: string
      error: string
      at: Date
    }

/** Callback shape used to stream runtime events to observers. */
export type TeamRuntimeEventEmitter = (event: TeamRuntimeEvent) => void

// ---------------------------------------------------------------------------
// Runtime wiring
// ---------------------------------------------------------------------------

/**
 * Adapter contract for resolving a `ParticipantDefinition` into a runnable
 * `SpawnedAgent`. Supplied by the host (e.g. the app that constructs the
 * runtime) so the runtime stays free of concrete LLM wiring concerns.
 */
export type ParticipantResolver = (
  participant: ParticipantDefinition,
  team: TeamDefinition,
) => Promise<SpawnedAgent>

/** Options accepted by the `TeamRuntime` constructor. */
export interface TeamRuntimeOptions {
  /** Declarative team schema. */
  definition: TeamDefinition
  /** Runtime policies; all fields optional. */
  policies?: TeamPolicies
  /** Resolver used to turn `ParticipantDefinition` into `SpawnedAgent`. */
  resolveParticipant?: ParticipantResolver
  /** Event sink. Defaults to a no-op. */
  onEvent?: TeamRuntimeEventEmitter
  /** Optional run ID generator (defaults to `crypto.randomUUID()`). */
  generateRunId?: () => string
}

/**
 * Executes a team according to its declarative definition and policies.
 *
 * Instantiate once per team (definition + policies), then call `execute(task)`
 * one or more times. Each call produces an independent run with its own
 * `runId`, phase model, and event stream.
 */
export class TeamRuntime {
  private readonly definition: TeamDefinition
  private readonly policies: TeamPolicies
  private readonly resolveParticipant: ParticipantResolver | undefined
  private readonly emitEvent: TeamRuntimeEventEmitter
  private readonly generateRunId: () => string

  constructor(options: TeamRuntimeOptions) {
    this.definition = options.definition
    this.policies = options.policies ?? {}
    this.resolveParticipant = options.resolveParticipant
    this.emitEvent = options.onEvent ?? (() => {})
    this.generateRunId =
      options.generateRunId ?? (() => globalThis.crypto.randomUUID())
  }

  /** The team definition backing this runtime. */
  get team(): TeamDefinition {
    return this.definition
  }

  /** The policies applied to this runtime. */
  get policy(): TeamPolicies {
    return this.policies
  }

  /**
   * Resolve a participant definition into a runnable `SpawnedAgent`.
   * Exposed as `protected` so pattern subclasses (or product code that
   * overrides `runSupervisor` et al.) can hydrate participants on demand.
   */
  protected async spawnParticipant(
    participant: ParticipantDefinition,
  ): Promise<SpawnedAgent> {
    if (!this.resolveParticipant) {
      throw new Error(
        `TeamRuntime: no ParticipantResolver supplied; cannot spawn participant '${participant.id}'`,
      )
    }
    return this.resolveParticipant(participant, this.definition)
  }

  /**
   * Execute the team against a task.
   *
   * Dispatches to a pattern-specific private method based on
   * `definition.coordinatorPattern`, emits phase + participant events, and
   * returns a `TeamRunResult` compatible with the playground coordinator.
   */
  async execute(task: string): Promise<TeamRunResult> {
    const runId = this.generateRunId()
    const startedAt = Date.now()
    const phaseModel: TeamPhaseModel = {
      current: 'initializing',
      startedAt: new Date(startedAt),
      transitions: [],
    }

    try {
      this.transition(phaseModel, 'planning', runId)
      this.transition(phaseModel, 'executing', runId)

      const pattern: CoordinatorPattern = this.definition.coordinatorPattern
      let result: TeamRunResult
      switch (pattern) {
        case 'supervisor':
          result = await this.runSupervisor(task, runId)
          break
        case 'contract_net':
          result = await this.runContractNet(task, runId)
          break
        case 'blackboard':
          result = await this.runBlackboard(task, runId)
          break
        case 'peer_to_peer':
          result = await this.runPeerToPeer(task, runId)
          break
        case 'council':
          result = await this.runCouncil(task, runId)
          break
        default: {
          const exhaustive: never = pattern
          throw new Error(
            `TeamRuntime: unknown coordinator pattern '${exhaustive as string}'`,
          )
        }
      }

      this.transition(phaseModel, 'evaluating', runId)
      this.transition(phaseModel, 'completing', runId)

      this.emitEvent({
        type: 'team_completed',
        teamId: this.definition.id,
        runId,
        durationMs: Date.now() - startedAt,
        at: new Date(),
      })

      return result
    } catch (err: unknown) {
      this.transition(phaseModel, 'failed', runId)
      const message = err instanceof Error ? err.message : String(err)
      this.emitEvent({
        type: 'team_failed',
        teamId: this.definition.id,
        runId,
        error: message,
        at: new Date(),
      })
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Pattern skeletons
  // -------------------------------------------------------------------------

  private async runSupervisor(task: string, runId: string): Promise<TeamRunResult> {
    // Structural skeleton: resolve participants, pick supervisor by role,
    // delegate to `AgentOrchestrator.supervisor` in concrete wiring code.
    return this.notImplemented('supervisor', task, runId)
  }

  private async runContractNet(task: string, runId: string): Promise<TeamRunResult> {
    // Structural skeleton: resolve participants, issue CFP via
    // `ContractNetManager`, evaluate bids with router model.
    return this.notImplemented('contract_net', task, runId)
  }

  private async runBlackboard(task: string, runId: string): Promise<TeamRunResult> {
    // Structural skeleton: construct a `SharedWorkspace`, run `maxRounds`,
    // reuse the playground coordinator's per-round logic shape.
    return this.notImplemented('blackboard', task, runId)
  }

  private async runPeerToPeer(task: string, runId: string): Promise<TeamRunResult> {
    // Structural skeleton: parallel-run all participants subject to
    // `ExecutionPolicy.maxParallelParticipants`, merge via policy strategy.
    return this.notImplemented('peer_to_peer', task, runId)
  }

  private async runCouncil(task: string, runId: string): Promise<TeamRunResult> {
    // Structural skeleton: collect proposals from all participants, invoke
    // `GovernancePolicy.judgeModel` (default: claude-opus-4-7) to pick a
    // winner or confirm unanimity per `requireUnanimous`.
    return this.notImplemented('council', task, runId)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private transition(
    model: TeamPhaseModel,
    to: TeamPhase,
    runId: string,
  ): void {
    const from = model.current
    if (from === to) return
    const at = new Date()
    model.transitions.push({ from, to, at })
    model.current = to
    this.emitEvent({
      type: 'phase_changed',
      teamId: this.definition.id,
      runId,
      from,
      to,
      at,
    })
  }

  /**
   * Placeholder used by pattern skeletons. Product code layered on top of
   * this runtime replaces these methods with real implementations; shipping
   * with a clear error prevents silent "empty result" regressions.
   */
  private notImplemented(
    pattern: CoordinatorPattern,
    _task: string,
    _runId: string,
  ): Promise<TeamRunResult> {
    throw new Error(
      `TeamRuntime: pattern '${pattern}' has no concrete implementation; ` +
        `wire a ParticipantResolver and override the corresponding run*() method in a subclass.`,
    )
  }
}
