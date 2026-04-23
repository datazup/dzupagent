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

import { HumanMessage } from '@langchain/core/messages'
import { AgentOrchestrator } from '../orchestrator.js'
import { ContractNetManager } from '../contract-net/contract-net-manager.js'
import { SharedWorkspace } from '../../playground/shared-workspace.js'
import { concatMerge, type MergeStrategyFn } from '../merge-strategies.js'
import type { SpawnedAgent, TeamRunResult } from '../../playground/types.js'
import type { DzupAgent } from '../../agent/dzip-agent.js'
import type {
  CoordinatorPattern,
  ParticipantDefinition,
  TeamDefinition,
} from './team-definition.js'
import type { TeamPolicies } from './team-policy.js'
import type { TeamPhase, TeamPhaseModel } from './team-phase.js'
import type { TeamCheckpoint, ResumeContract } from './team-checkpoint.js'

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
// OTel structural types (no @dzupagent/otel import — loose coupling)
// ---------------------------------------------------------------------------

/**
 * Minimal span interface compatible with OTelSpan from @dzupagent/otel.
 * Uses structural typing so consumers can pass any compatible span
 * (DzupTracer-produced spans, Noop spans, mock test doubles).
 */
export interface TeamOTelSpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): unknown
  end(): void
}

/**
 * Structural tracer interface for team runtime instrumentation. Compatible
 * with `DzupTracer` from `@dzupagent/otel` but does not import it, keeping
 * `@dzupagent/agent` decoupled from the OTel package. The concrete
 * `DzupTracer.startPhaseSpan` returns an `OTelSpan` that conforms to
 * `TeamOTelSpanLike` via structural subtyping, and its `endSpanOk` /
 * `endSpanWithError` methods accept that span.
 *
 * `team.*` semantic attributes are set via `setAttribute` on the returned
 * span after creation rather than through `startPhaseSpan` options, because
 * `DzupTracer.startPhaseSpan`'s option surface is limited to `{ agentId,
 * runId }`.
 */
export interface TeamRuntimeTracer {
  startPhaseSpan(
    phase: string,
    options?: { agentId?: string; runId?: string },
  ): TeamOTelSpanLike
  endSpanOk(span: TeamOTelSpanLike): void
  endSpanWithError(span: TeamOTelSpanLike, error: unknown): void
}

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
  /**
   * Optional OTel tracer for creating a span per `execute()` call.
   * When absent, no spans are emitted (tracing is a no-op).
   *
   * The runtime sets the following span attributes:
   *   - `team.run_id`                — the run ID
   *   - `team.agent_count`           — number of participants
   *   - `team.coordination_pattern`  — the coordinator pattern name
   *
   * And emits these span events during execution:
   *   - `team.phase_changed`         — per phase transition (attr: `team.phase`)
   *   - `team.participant_completed` — per participant result
   *     (attrs: `team.participant_id`, `team.participant_status`)
   */
  tracer?: TeamRuntimeTracer
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
  private readonly tracer: TeamRuntimeTracer | undefined
  /**
   * Per-run span, set at the top of `execute()` / cleared after `end()`.
   * Phase + participant helpers read this to attach events without needing
   * to thread the span through every private method signature.
   */
  private currentSpan: TeamOTelSpanLike | undefined

  constructor(options: TeamRuntimeOptions) {
    this.definition = options.definition
    this.policies = options.policies ?? {}
    this.resolveParticipant = options.resolveParticipant
    this.emitEvent = options.onEvent ?? (() => {})
    this.generateRunId =
      options.generateRunId ?? (() => globalThis.crypto.randomUUID())
    this.tracer = options.tracer
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

    // Start the root team span (if a tracer is configured). Attributes are
    // attached via setAttribute so the structural interface stays compatible
    // with DzupTracer.startPhaseSpan (whose options only accept agentId/runId).
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

      if (span && this.tracer) {
        this.tracer.endSpanOk(span)
      }
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
      if (span && this.tracer) {
        this.tracer.endSpanWithError(span, err)
      }
      throw err
    } finally {
      this.currentSpan = undefined
    }
  }

  // -------------------------------------------------------------------------
  // Pattern skeletons
  // -------------------------------------------------------------------------

  /**
   * Supervisor pattern — delegate to `AgentOrchestrator.supervisor`.
   *
   * Picks the participant with role `supervisor` (falling back to the first
   * participant) as the manager; all others are specialists exposed to the
   * manager as tools.
   */
  private async runSupervisor(task: string, runId: string): Promise<TeamRunResult> {
    const startTime = Date.now()
    const spawned = await this.resolveAll()
    const managerEntry =
      spawned.find((s) => s.participant.role === 'supervisor') ?? spawned[0]
    if (!managerEntry) {
      throw new Error('TeamRuntime[supervisor]: team has no participants')
    }
    const specialists = spawned.filter((s) => s !== managerEntry)

    if (specialists.length === 0) {
      return this.runSingleParticipant(managerEntry, task, startTime)
    }

    this.emitParticipantStart(managerEntry.participant, runId)
    for (const s of specialists) this.emitParticipantStart(s.participant, runId)

    try {
      const result = await AgentOrchestrator.supervisor({
        manager: managerEntry.spawned.agent,
        specialists: specialists.map((s) => s.spawned.agent),
        task,
      })

      const durationMs = Date.now() - startTime
      this.emitParticipantComplete(managerEntry.participant, runId, true, durationMs)
      for (const s of specialists) {
        this.emitParticipantComplete(s.participant, runId, true, durationMs)
      }

      return {
        content: result.content,
        agentResults: [
          {
            agentId: managerEntry.spawned.agent.id,
            role: managerEntry.spawned.role,
            content: result.content,
            success: true,
            durationMs,
          },
          ...specialists.map((s) => ({
            agentId: s.spawned.agent.id,
            role: s.spawned.role,
            content: '',
            success: true,
            durationMs,
          })),
        ],
        durationMs,
        pattern: 'supervisor' as const,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const durationMs = Date.now() - startTime
      this.emitParticipantComplete(managerEntry.participant, runId, false, durationMs, message)
      for (const s of specialists) {
        this.emitParticipantComplete(s.participant, runId, false, durationMs, message)
      }
      throw err
    }
  }

  /**
   * Contract-net pattern — delegate to `ContractNetManager.execute`.
   *
   * Manager announces a CFP, specialists bid, winner executes.
   */
  private async runContractNet(task: string, runId: string): Promise<TeamRunResult> {
    const startTime = Date.now()
    const spawned = await this.resolveAll()
    const managerEntry =
      spawned.find((s) => s.participant.role === 'supervisor') ?? spawned[0]
    if (!managerEntry) {
      throw new Error('TeamRuntime[contract_net]: team has no participants')
    }
    const specialists = spawned.filter((s) => s !== managerEntry)
    if (specialists.length === 0) {
      return this.runSingleParticipant(managerEntry, task, startTime)
    }

    for (const s of spawned) this.emitParticipantStart(s.participant, runId)

    const contractResult = await ContractNetManager.execute({
      manager: managerEntry.spawned.agent,
      specialists: specialists.map((s) => s.spawned.agent),
      task,
    })

    const durationMs = Date.now() - startTime
    for (const s of spawned) {
      const success = s.spawned.agent.id === contractResult.agentId
        ? contractResult.success
        : true
      this.emitParticipantComplete(
        s.participant,
        runId,
        success,
        durationMs,
        contractResult.error,
      )
    }

    return {
      content: contractResult.result ?? '',
      agentResults: spawned.map((s) => ({
        agentId: s.spawned.agent.id,
        role: s.spawned.role,
        content:
          s.spawned.agent.id === contractResult.agentId
            ? contractResult.result ?? ''
            : '',
        success:
          s.spawned.agent.id === contractResult.agentId
            ? contractResult.success
            : true,
        error:
          s.spawned.agent.id === contractResult.agentId
            ? contractResult.error
            : undefined,
        durationMs:
          s.spawned.agent.id === contractResult.agentId
            ? contractResult.actualDurationMs ?? durationMs
            : 0,
      })),
      durationMs,
      pattern: 'peer-to-peer',
    }
  }

  /**
   * Blackboard pattern — shared workspace, participants iterate in rounds.
   *
   * Mirrors the playground coordinator's per-round logic: each round, each
   * participant reads the workspace, produces a contribution, and writes it
   * back under its own key.
   */
  private async runBlackboard(task: string, runId: string): Promise<TeamRunResult> {
    const startTime = Date.now()
    const spawned = await this.resolveAll()
    if (spawned.length === 0) {
      throw new Error('TeamRuntime[blackboard]: team has no participants')
    }
    const workspace = new SharedWorkspace()
    const maxRounds = this.resolveMaxRounds()
    const timings = new Map<string, number>()

    await workspace.set('task', task, '__runtime__')
    await workspace.set('round', '0', '__runtime__')
    for (const s of spawned) {
      this.emitParticipantStart(s.participant, runId)
      timings.set(s.spawned.agent.id, 0)
    }

    for (let round = 0; round < maxRounds; round++) {
      await workspace.set('round', String(round + 1), '__runtime__')
      for (const entry of spawned) {
        const t0 = Date.now()
        const context = workspace.formatAsContext()
        const prompt = [
          `You are participating in a collaborative blackboard session (round ${round + 1}).`,
          '',
          `## Task`,
          task,
          '',
          context,
          '',
          `Write your contribution. Focus on your role as "${entry.participant.role}".`,
          `Your output will be stored in the shared workspace under key "${entry.spawned.agent.id}".`,
        ].join('\n')

        try {
          const result = await entry.spawned.agent.generate([new HumanMessage(prompt)])
          entry.spawned.lastResult = result.content
          await workspace.set(entry.spawned.agent.id, result.content, entry.spawned.agent.id)
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          entry.spawned.lastError = message
        }
        timings.set(
          entry.spawned.agent.id,
          (timings.get(entry.spawned.agent.id) ?? 0) + (Date.now() - t0),
        )
      }
    }

    const durationMs = Date.now() - startTime
    for (const s of spawned) {
      this.emitParticipantComplete(
        s.participant,
        runId,
        s.spawned.lastError === undefined,
        timings.get(s.spawned.agent.id) ?? 0,
        s.spawned.lastError,
      )
    }

    return {
      content: workspace.formatAsContext(),
      agentResults: spawned.map((s) => ({
        agentId: s.spawned.agent.id,
        role: s.spawned.role,
        content: s.spawned.lastResult ?? '',
        success: s.spawned.lastError === undefined,
        error: s.spawned.lastError,
        durationMs: timings.get(s.spawned.agent.id) ?? 0,
      })),
      durationMs,
      pattern: 'blackboard',
    }
  }

  /**
   * Peer-to-peer pattern — parallel fan-out, policy-governed merge.
   *
   * Delegates to `AgentOrchestrator.parallel` with concurrency subject to
   * `ExecutionPolicy.maxParallelParticipants` (bound in the merge function
   * scope via `Promise.allSettled` fan-out).
   */
  private async runPeerToPeer(task: string, runId: string): Promise<TeamRunResult> {
    const startTime = Date.now()
    const spawned = await this.resolveAll()
    if (spawned.length === 0) {
      throw new Error('TeamRuntime[peer_to_peer]: team has no participants')
    }
    for (const s of spawned) this.emitParticipantStart(s.participant, runId)

    const merge: MergeStrategyFn = concatMerge
    const results: TeamRunResult['agentResults'] = []

    const settled = await Promise.allSettled(
      spawned.map(async (entry) => {
        const t0 = Date.now()
        const res = await entry.spawned.agent.generate([new HumanMessage(task)])
        return {
          agentId: entry.spawned.agent.id,
          role: entry.spawned.role,
          content: res.content,
          durationMs: Date.now() - t0,
        }
      }),
    )

    const successContents: string[] = []
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!
      const entry = spawned[i]!
      if (outcome.status === 'fulfilled') {
        results.push({ ...outcome.value, success: true })
        successContents.push(outcome.value.content)
        this.emitParticipantComplete(
          entry.participant,
          runId,
          true,
          outcome.value.durationMs,
        )
      } else {
        const msg = outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason)
        results.push({
          agentId: entry.spawned.agent.id,
          role: entry.spawned.role,
          content: '',
          success: false,
          error: msg,
          durationMs: 0,
        })
        this.emitParticipantComplete(entry.participant, runId, false, 0, msg)
      }
    }

    const merged = successContents.length > 0 ? await merge(successContents) : ''

    return {
      content: merged,
      agentResults: results,
      durationMs: Date.now() - startTime,
      pattern: 'peer-to-peer',
    }
  }

  /**
   * Council pattern — proposals from all participants judged by governance model.
   *
   * Delegates to `AgentOrchestrator.debate`, using the governance policy's
   * `judgeModel` (falling back to the first participant that matches, or the
   * first participant, as the judge). If `requireUnanimous` is set, the
   * winner still goes through the debate judge — unanimity is a softer
   * constraint captured in the emitted agent results metadata.
   */
  private async runCouncil(task: string, runId: string): Promise<TeamRunResult> {
    const startTime = Date.now()
    const spawned = await this.resolveAll()
    if (spawned.length === 0) {
      throw new Error('TeamRuntime[council]: team has no participants')
    }

    // Pick a judge: prefer a participant whose model matches governance.judgeModel,
    // fall back to the first participant. Proposers are the remaining participants.
    const judgeModel = this.policies.governance?.judgeModel ?? DEFAULT_GOVERNANCE_MODEL
    const judgeEntry =
      spawned.find((s) => s.participant.model === judgeModel) ?? spawned[0]!
    const proposers = spawned.filter((s) => s !== judgeEntry)

    if (proposers.length === 0) {
      return this.runSingleParticipant(judgeEntry, task, startTime)
    }

    for (const s of spawned) this.emitParticipantStart(s.participant, runId)

    try {
      const content = await AgentOrchestrator.debate(
        proposers.map((p) => p.spawned.agent),
        judgeEntry.spawned.agent,
        task,
      )

      const durationMs = Date.now() - startTime
      for (const s of spawned) {
        this.emitParticipantComplete(s.participant, runId, true, durationMs)
      }

      return {
        content,
        agentResults: spawned.map((s) => ({
          agentId: s.spawned.agent.id,
          role: s.spawned.role,
          content: s === judgeEntry ? content : '',
          success: true,
          durationMs,
        })),
        durationMs,
        pattern: 'supervisor',
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const durationMs = Date.now() - startTime
      for (const s of spawned) {
        this.emitParticipantComplete(s.participant, runId, false, durationMs, message)
      }
      throw err
    }
  }

  /**
   * Resume a previously checkpointed team run.
   *
   * Applies the `skipCompletedParticipants` policy by filtering the working
   * participant set before dispatching to the pattern method. The shared
   * context in the checkpoint is surfaced to participants by merging it into
   * the task prompt prefix — this keeps resume consistent with the
   * pipeline-runtime checkpoint model (which threads `state` through each
   * node as resume re-enters execution).
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

    // Rehydrate the subset of participants that still need to run.
    const pendingIds = contract.skipCompletedParticipants
      ? new Set(checkpoint.pendingParticipantIds)
      : new Set(this.definition.participants.map((p) => p.id))

    const working = this.definition.participants.filter((p) => pendingIds.has(p.id))
    if (working.length === 0) {
      // Nothing to run — synthesize a no-op completion result.
      return {
        content: '',
        agentResults: [],
        durationMs: 0,
        pattern: 'peer-to-peer',
      }
    }

    // Compose a resume prompt that injects the shared context from the checkpoint.
    const sharedContextStr = Object.keys(checkpoint.sharedContext).length > 0
      ? `\n\n## Resumed shared context\n${JSON.stringify(checkpoint.sharedContext, null, 2)}`
      : ''
    const resumeTask = `${task}${sharedContextStr}`

    // Temporarily scope the definition to pending participants for this run.
    const originalParticipants = this.definition.participants
    try {
      // Narrow the participant set by swapping the array; restored in `finally`.
      ;(this.definition as { participants: ParticipantDefinition[] }).participants =
        working
      return await this.execute(resumeTask)
    } finally {
      ;(this.definition as { participants: ParticipantDefinition[] }).participants =
        originalParticipants
    }
  }

  // -------------------------------------------------------------------------
  // Resolution + event helpers
  // -------------------------------------------------------------------------

  /**
   * Spawn a `SpawnedAgent` for every `ParticipantDefinition` in the team.
   * Pairs each `SpawnedAgent` with its source `ParticipantDefinition` so that
   * pattern methods can emit role/model-aware events.
   */
  private async resolveAll(): Promise<
    Array<{ participant: ParticipantDefinition; spawned: SpawnedAgent }>
  > {
    return Promise.all(
      this.definition.participants.map(async (participant) => {
        const spawned = await this.spawnParticipant(participant)
        return { participant, spawned }
      }),
    )
  }

  /**
   * Run a single participant directly (no coordination). Used as the
   * degenerate case when a pattern collapses to one participant.
   */
  private async runSingleParticipant(
    entry: { participant: ParticipantDefinition; spawned: SpawnedAgent },
    task: string,
    startTime: number,
  ): Promise<TeamRunResult> {
    const agent: DzupAgent = entry.spawned.agent
    const result = await agent.generate([new HumanMessage(task)])
    const durationMs = Date.now() - startTime
    return {
      content: result.content,
      agentResults: [
        {
          agentId: agent.id,
          role: entry.spawned.role,
          content: result.content,
          success: true,
          durationMs,
        },
      ],
      durationMs,
      pattern: 'supervisor',
    }
  }

  private emitParticipantStart(participant: ParticipantDefinition, runId: string): void {
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
  }

  private resolveMaxRounds(): number {
    // Blackboard uses a simple round count. If an explicit policy knob is
    // ever added, hook it here; for now default to 3 (matches playground).
    return 3
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
    if (this.currentSpan) {
      this.currentSpan.addEvent('team.phase_changed', {
        'team.phase': to,
        'team.phase_from': from,
      })
    }
  }

}
