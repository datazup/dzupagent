/**
 * TeamRuntime — production-grade execution engine for declarative teams.
 *
 * Consumes a declarative `TeamDefinition` + `TeamPolicies` pair and
 * delegates to the right `TeamPattern` strategy based on
 * `coordinatorPattern`.
 *
 * Supported patterns:
 *   - supervisor    — manager delegates to specialists
 *   - contract_net  — participants bid, manager awards contracts
 *   - blackboard    — shared workspace, multi-round iteration
 *   - peer_to_peer  — parallel execution with merge
 *   - council       — deliberation judged by a governance model
 *
 * Each pattern is implemented as a `TeamPattern` strategy under
 * `./patterns/`; `TeamRuntime` is a thin dispatcher that owns:
 *   - lifecycle phase transitions
 *   - lifecycle event emission
 *   - OTel root-span management
 *   - policy validation + memory consolidation
 *   - keyed circuit-breaker bookkeeping (`KeyedCircuitBreaker` from core)
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
import type { TeamPhase, TeamPhaseModel } from './team-phase.js'
import type { TeamCheckpoint, ResumeContract } from './team-checkpoint.js'
import type { SupervisionPolicy } from './supervision-policy.js'
import {
  TEAM_PATTERN_REGISTRY,
  type ResolvedParticipant,
  type TeamPattern,
  type TeamPatternContext,
  type TeamPatternHooks,
} from './patterns/index.js'
import { DEFAULT_GOVERNANCE_MODEL as DEFAULT_GOVERNANCE_MODEL_FROM_PATTERN } from './patterns/council-pattern.js'
import { validateTeamPolicies } from './team-runtime-policy-validator.js'
import type { TeamOTelSpanLike, TeamRuntimeTracer } from './team-otel-types.js'
import type { TeamRuntimeEventEmitter } from './team-runtime-events.js'

// Re-export structural types so existing callers keep working.
export type { TeamOTelSpanLike, TeamRuntimeTracer } from './team-otel-types.js'
export type {
  TeamRuntimeEvent,
  TeamRuntimeEventEmitter,
} from './team-runtime-events.js'

// Recommended model constants — exported for downstream wiring code that needs
// to align participant/router/governance choices with the framework defaults.
/** Cheap, fast model for routing and bid evaluation. */
export const DEFAULT_ROUTER_MODEL = 'claude-haiku-4-5-20251001'
/** Default participant model when a `ParticipantDefinition` omits one. */
export const DEFAULT_PARTICIPANT_MODEL = 'claude-sonnet-4-6'
/** Default governance / evaluation / council judge model. */
export const DEFAULT_GOVERNANCE_MODEL = DEFAULT_GOVERNANCE_MODEL_FROM_PATTERN

/**
 * Adapter contract for resolving a `ParticipantDefinition` into a runnable
 * `SpawnedAgent`. Supplied by the host so the runtime stays free of LLM
 * wiring concerns.
 */
export type ParticipantResolver = (
  participant: ParticipantDefinition,
  team: TeamDefinition,
) => Promise<SpawnedAgent>

/** Memory service port for post-run consolidation. */
export interface TeamRuntimeMemoryService {
  consolidate?(teamId: string, namespace: string): Promise<void>
}

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
  /** Optional memory service for post-run consolidation. */
  memory?: TeamRuntimeMemoryService
  /** Optional OTel tracer for creating a span per `execute()` call. */
  tracer?: TeamRuntimeTracer
  /** Optional per-agent circuit-breaker controls. */
  supervisionPolicy?: SupervisionPolicy
  /**
   * Optional override for the pattern strategy registry, primarily used
   * by tests to inject mock patterns. Defaults to the canonical
   * `TEAM_PATTERN_REGISTRY`.
   */
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
  /** Per-run span; cleared in `finally`. */
  private currentSpan: TeamOTelSpanLike | undefined
  /** Optional breaker tracker — undefined when no supervision policy was set. */
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
    const runId = this.generateRunId()
    const startedAt = Date.now()
    const phaseModel: TeamPhaseModel = {
      current: 'initializing',
      startedAt: new Date(startedAt),
      transitions: [],
    }

    const span = this.tracer?.startPhaseSpan(`team:${this.definition.id}`, {
      runId,
    })
    if (span) {
      span.setAttribute('team.run_id', runId)
      span.setAttribute('team.agent_count', this.definition.participants.length)
      span.setAttribute(
        'team.coordination_pattern',
        this.definition.coordinatorPattern,
      )
    }
    this.currentSpan = span

    try {
      this.transition(phaseModel, 'planning', runId)
      this.transition(phaseModel, 'executing', runId)

      // Short-circuit when every participant's breaker is open.
      const tracker = this.breakerTracker
      if (
        tracker &&
        this.definition.participants.length > 0 &&
        this.definition.participants.every((p) => !tracker.isAvailable(p.id))
      ) {
        this.transition(phaseModel, 'evaluating', runId)
        this.transition(phaseModel, 'completing', runId)
        this.emitEvent({
          type: 'team_completed',
          teamId: this.definition.id,
          runId,
          durationMs: Date.now() - startedAt,
          at: new Date(),
        })
        if (span && this.tracer) this.tracer.endSpanOk(span)
        return {
          content: '',
          agentResults: [],
          durationMs: Date.now() - startedAt,
          pattern: 'breaker-short-circuit',
        }
      }

      const pattern = this.resolvePattern(this.definition.coordinatorPattern)
      const ctx = await this.buildPatternContext(task, runId, startedAt)
      const result = await pattern.execute(ctx)

      this.transition(phaseModel, 'evaluating', runId)
      this.transition(phaseModel, 'completing', runId)

      this.emitEvent({
        type: 'team_completed',
        teamId: this.definition.id,
        runId,
        durationMs: Date.now() - startedAt,
        at: new Date(),
      })

      if (
        this.policies.memory?.consolidateOnComplete === true &&
        this.memory?.consolidate
      ) {
        const namespace = this.definition.id
        await this.memory.consolidate(this.definition.id, namespace)
        this.emitEvent({
          type: 'team_consolidation_completed',
          teamId: this.definition.id,
          runId,
          namespace,
          at: new Date(),
        })
      }

      if (span && this.tracer) this.tracer.endSpanOk(span)
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
      if (span && this.tracer) this.tracer.endSpanWithError(span, err)
      throw err
    } finally {
      this.currentSpan = undefined
    }
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
    if (checkpoint.teamId !== this.definition.id) {
      throw new Error(
        `TeamRuntime.resume: checkpoint belongs to team '${checkpoint.teamId}', not '${this.definition.id}'`,
      )
    }

    const pendingIds = contract.skipCompletedParticipants
      ? new Set(checkpoint.pendingParticipantIds)
      : new Set(this.definition.participants.map((p) => p.id))

    const working = this.definition.participants.filter((p) =>
      pendingIds.has(p.id),
    )
    if (working.length === 0) {
      return {
        content: '',
        agentResults: [],
        durationMs: 0,
        pattern: 'peer-to-peer',
      }
    }

    const sharedContextStr =
      Object.keys(checkpoint.sharedContext).length > 0
        ? `\n\n## Resumed shared context\n${JSON.stringify(
            checkpoint.sharedContext,
            null,
            2,
          )}`
        : ''
    const resumeTask = `${task}${sharedContextStr}`

    const originalParticipants = this.definition.participants
    try {
      ;(this.definition as { participants: ParticipantDefinition[] }).participants =
        working
      return await this.execute(resumeTask)
    } finally {
      ;(this.definition as { participants: ParticipantDefinition[] }).participants =
        originalParticipants
    }
  }

  // ---------------------------------------------------------------------
  // Pattern context construction
  // ---------------------------------------------------------------------

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
      otelSpan: this.currentSpan,
      hooks: this.makeHooks(runId),
    }
  }

  /** Spawn agents for all participants whose breaker is currently closed. */
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

  private makeHooks(runId: string): TeamPatternHooks {
    return {
      emitParticipantStart: (participant) =>
        this.emitParticipantStart(participant, runId),
      emitParticipantComplete: (participant, success, durationMs, error) =>
        this.emitParticipantComplete(
          participant,
          runId,
          success,
          durationMs,
          error,
        ),
      emitPolicyApplied: (group, field) =>
        this.emitPolicyApplied(group, field, runId),
    }
  }

  // ---------------------------------------------------------------------
  // Event helpers + circuit-breaker bookkeeping
  // ---------------------------------------------------------------------

  private emitParticipantStart(
    participant: ParticipantDefinition,
    runId: string,
  ): void {
    this.emitEvent({
      type: 'participant_started',
      teamId: this.definition.id,
      runId,
      participantId: participant.id,
      role: participant.role,
      at: new Date(),
    })
  }

  private emitParticipantComplete(
    participant: ParticipantDefinition,
    runId: string,
    success: boolean,
    durationMs: number,
    error?: string,
  ): void {
    this.emitEvent({
      type: 'participant_completed',
      teamId: this.definition.id,
      runId,
      participantId: participant.id,
      role: participant.role,
      success,
      durationMs,
      at: new Date(),
      ...(error !== undefined ? { error } : {}),
    })
    if (this.currentSpan) {
      this.currentSpan.addEvent('team.participant_completed', {
        'team.participant_id': participant.id,
        'team.participant_status': success ? 'success' : 'failed',
      })
    }
    this.recordParticipantOutcome(participant.id, success)
  }

  /** Forward a participant outcome into the breaker tracker. */
  private recordParticipantOutcome(
    participantId: string,
    success: boolean,
  ): void {
    const tracker = this.breakerTracker
    if (!tracker) return
    if (tracker.record(participantId, success) === 'tripped' && this.currentSpan) {
      this.currentSpan.addEvent('circuit_breaker.opened', {
        agentId: participantId,
      })
    }
  }

  private emitPolicyApplied(
    policyGroup: 'governance',
    policyField: 'judgeModel',
    runId: string,
  ): void {
    this.emitEvent({
      type: 'policy_applied',
      teamId: this.definition.id,
      runId,
      policyGroup,
      policyField,
      coordinatorPattern: this.definition.coordinatorPattern,
      at: new Date(),
    })
    if (this.currentSpan) {
      this.currentSpan.addEvent('team.policy_applied', {
        'team.policy_group': policyGroup,
        'team.policy_field': policyField,
        'team.coordination_pattern': this.definition.coordinatorPattern,
      })
    }
  }

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
    if (this.currentSpan) {
      this.currentSpan.addEvent('team.phase_changed', {
        'team.phase': to,
        'team.phase_from': from,
      })
    }
  }
}
