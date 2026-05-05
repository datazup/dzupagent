/**
 * TeamRuntime — declarative team execution engine.
 *
 * Thin dispatcher that owns lifecycle (phase transitions, OTel span,
 * event emission, policy validation, circuit-breaker bookkeeping) and
 * delegates participant scheduling + merge logic to a `TeamPattern`
 * strategy under `./patterns/`.
 */

import { KeyedCircuitBreaker } from '@dzupagent/core'
import { TeamBreakerTracker } from './team-runtime-breaker.js'
import {
  SharedWorkspace,
  type TeamRunResult,
  type TeamSpawnedAgent as SpawnedAgent,
} from './team-workspace.js'
import type {
  CoordinatorPattern,
  ParticipantDefinition,
  TeamDefinition,
} from './team-definition.js'
import type { TeamPolicies } from './team-policy.js'
import type { TeamCheckpoint, ResumeContract } from './team-checkpoint.js'
import type { SupervisionPolicy } from './supervision-policy.js'
import {
  TEAM_PATTERN_REGISTRY,
  type ResolvedParticipant,
  type TeamPattern,
  type TeamPatternContext,
} from './patterns/index.js'
import { DEFAULT_GOVERNANCE_MODEL as DEFAULT_GOVERNANCE_MODEL_FROM_PATTERN } from './patterns/council-pattern.js'
import { validateTeamPolicies } from './team-runtime-policy-validator.js'
import type { TeamOTelSpanLike, TeamRuntimeTracer } from './team-otel-types.js'
import type { TeamRuntimeEventEmitter } from './team-runtime-events.js'
import type { TeamRuntimeMemoryService } from './team-runtime-memory.js'
import { EMPTY_RESUME_RESULT, planResume } from './team-runtime-resume.js'
import { buildPatternHooks } from './team-runtime-hooks.js'
import { executeTeamRun } from './team-runtime-execute.js'

// Re-export structural types so existing callers keep working.
export type { TeamOTelSpanLike, TeamRuntimeTracer } from './team-otel-types.js'
export type {
  TeamRuntimeEvent,
  TeamRuntimeEventEmitter,
} from './team-runtime-events.js'
export type { TeamRuntimeMemoryService } from './team-runtime-memory.js'

// Default model constants — exported for downstream wiring.
export const DEFAULT_ROUTER_MODEL = 'claude-haiku-4-5-20251001'
export const DEFAULT_PARTICIPANT_MODEL = 'claude-sonnet-4-6'
export const DEFAULT_GOVERNANCE_MODEL = DEFAULT_GOVERNANCE_MODEL_FROM_PATTERN

/** Resolves a `ParticipantDefinition` into a runnable `SpawnedAgent`. */
export type ParticipantResolver = (
  participant: ParticipantDefinition,
  team: TeamDefinition,
) => Promise<SpawnedAgent>

/** Options accepted by the `TeamRuntime` constructor. */
export interface TeamRuntimeOptions {
  definition: TeamDefinition
  policies?: TeamPolicies
  resolveParticipant?: ParticipantResolver
  onEvent?: TeamRuntimeEventEmitter
  generateRunId?: () => string
  memory?: TeamRuntimeMemoryService
  tracer?: TeamRuntimeTracer
  supervisionPolicy?: SupervisionPolicy
  /** Optional pattern registry override — primarily a test seam. */
  patternRegistry?: Record<CoordinatorPattern, TeamPattern>
}

/**
 * Executes a team according to its declarative definition and policies.
 * Instantiate once per team, then call `execute(task)` one or more times.
 */
export class TeamRuntime {
  private readonly definition: TeamDefinition
  private readonly policies: TeamPolicies
  private readonly resolveParticipant: ParticipantResolver | undefined
  private readonly emitEvent: TeamRuntimeEventEmitter
  private readonly generateRunId: () => string
  private readonly tracer: TeamRuntimeTracer | undefined
  private currentSpan: TeamOTelSpanLike | undefined
  private readonly breakerTracker: TeamBreakerTracker | undefined
  private readonly memory: TeamRuntimeMemoryService | undefined
  private readonly patternRegistry: Record<CoordinatorPattern, TeamPattern>

  constructor(options: TeamRuntimeOptions) {
    this.definition = options.definition
    this.policies = options.policies ?? {}
    validateTeamPolicies(this.definition.coordinatorPattern, this.policies)
    this.resolveParticipant = options.resolveParticipant
    this.emitEvent = options.onEvent ?? (() => {})
    this.generateRunId =
      options.generateRunId ?? (() => globalThis.crypto.randomUUID())
    this.tracer = options.tracer
    this.memory = options.memory
    this.patternRegistry = options.patternRegistry ?? TEAM_PATTERN_REGISTRY
    this.breakerTracker = options.supervisionPolicy
      ? new TeamBreakerTracker(options.supervisionPolicy)
      : undefined
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
   * Exposed as `protected` so subclasses can hydrate participants on demand.
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
   * Execute the team against a task. Dispatches to a `TeamPattern`
   * strategy and emits phase + participant lifecycle events.
   */
  async execute(task: string): Promise<TeamRunResult> {
    return executeTeamRun({
      task,
      runId: this.generateRunId(),
      definition: this.definition,
      policies: this.policies,
      emitEvent: this.emitEvent,
      tracer: this.tracer,
      memory: this.memory,
      breakerTracker: this.breakerTracker,
      resolvePattern: (id) => this.resolvePattern(id),
      buildPatternContext: (t, runId, startedAt, span) =>
        this.buildPatternContext(t, runId, startedAt, span),
      setCurrentSpan: (span) => {
        this.currentSpan = span
      },
    })
  }

  /**
   * Resume a previously checkpointed team run, narrowing the participant
   * set based on the contract's `skipCompletedParticipants` flag.
   */
  async resume(
    checkpoint: TeamCheckpoint,
    contract: ResumeContract,
    task: string,
  ): Promise<TeamRunResult> {
    const { workingParticipants, resumeTask } = planResume(
      this.definition,
      checkpoint,
      contract,
      task,
    )
    if (workingParticipants.length === 0) return EMPTY_RESUME_RESULT

    const original = this.definition.participants
    try {
      ;(this.definition as { participants: ParticipantDefinition[] }).participants =
        workingParticipants
      return await this.execute(resumeTask)
    } finally {
      ;(this.definition as { participants: ParticipantDefinition[] }).participants =
        original
    }
  }

  // --- private helpers ----------------------------------------------------

  private resolvePattern(id: CoordinatorPattern): TeamPattern {
    const pattern = this.patternRegistry[id]
    if (!pattern) {
      throw new Error(
        `TeamRuntime: unknown coordinator pattern '${String(id)}'`,
      )
    }
    return pattern
  }

  private async buildPatternContext(
    task: string,
    runId: string,
    startedAt: number,
    span: TeamOTelSpanLike | undefined,
  ): Promise<TeamPatternContext> {
    const participants = await this.resolveAll()
    const breaker = this.breakerTracker?.registry ?? new KeyedCircuitBreaker()
    return {
      task,
      teamId: this.definition.id,
      runId,
      startedAt,
      definition: this.definition,
      policies: this.policies,
      participants,
      workspace: new SharedWorkspace(),
      circuitBreaker: breaker,
      otelSpan: span,
      hooks: buildPatternHooks({
        teamId: this.definition.id,
        runId,
        coordinatorPattern: this.definition.coordinatorPattern,
        emitEvent: this.emitEvent,
        getSpan: () => this.currentSpan,
        breakerTracker: this.breakerTracker,
      }),
    }
  }

  private async resolveAll(): Promise<ResolvedParticipant[]> {
    const tracker = this.breakerTracker
    const eligible = tracker
      ? this.definition.participants.filter((p) => tracker.isAvailable(p.id))
      : this.definition.participants
    return Promise.all(
      eligible.map(async (participant) => {
        const spawned = await this.spawnParticipant(participant)
        return { participant, spawned }
      }),
    )
  }
}
