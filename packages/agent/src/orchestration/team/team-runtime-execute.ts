/**
 * Single-run executor for `TeamRuntime`.
 *
 * Drives phase transitions, OTel span lifecycle, breaker short-circuiting,
 * pattern dispatch, and post-run consolidation for one `execute()` call.
 * Extracted from the runtime class so the dispatcher stays a thin shell.
 */

import type {
  CoordinatorPattern,
  ParticipantDefinition,
  TeamDefinition,
} from './team-definition.js'
import type { TeamPolicies } from './team-policy.js'
import type { TeamRunResult } from './team-workspace.js'
import type { TeamOTelSpanLike, TeamRuntimeTracer } from './team-otel-types.js'
import type { TeamRuntimeEventEmitter } from './team-runtime-events.js'
import type { TeamPattern, TeamPatternContext } from './patterns/index.js'
import type { TeamBreakerTracker } from './team-runtime-breaker.js'
import { createPhaseModel, transitionPhase } from './team-runtime-phase.js'
import {
  consolidateIfEnabled,
  type TeamRuntimeMemoryService,
} from './team-runtime-memory.js'

export interface ExecuteContext {
  task: string
  runId: string
  definition: TeamDefinition
  policies: TeamPolicies
  emitEvent: TeamRuntimeEventEmitter
  tracer: TeamRuntimeTracer | undefined
  memory: TeamRuntimeMemoryService | undefined
  breakerTracker: TeamBreakerTracker | undefined
  resolvePattern: (id: CoordinatorPattern) => TeamPattern
  buildPatternContext: (
    task: string,
    runId: string,
    startedAt: number,
    span: TeamOTelSpanLike | undefined,
  ) => Promise<TeamPatternContext>
  /** Setter that lets the runtime expose the active span externally. */
  setCurrentSpan: (span: TeamOTelSpanLike | undefined) => void
}

export async function executeTeamRun(ctx: ExecuteContext): Promise<TeamRunResult> {
  const startedAt = Date.now()
  const phase = createPhaseModel(startedAt)
  let span: TeamOTelSpanLike | undefined
  const phaseOpts = {
    teamId: ctx.definition.id,
    runId: ctx.runId,
    emitEvent: ctx.emitEvent,
    getSpan: () => span,
  }

  span = startSpan(ctx)
  ctx.setCurrentSpan(span)

  try {
    transitionPhase(phase, 'planning', phaseOpts)
    transitionPhase(phase, 'executing', phaseOpts)

    if (allBreakersOpen(ctx.definition.participants, ctx.breakerTracker)) {
      transitionPhase(phase, 'evaluating', phaseOpts)
      transitionPhase(phase, 'completing', phaseOpts)
      emitTeamCompleted(ctx, Date.now() - startedAt)
      if (span && ctx.tracer) ctx.tracer.endSpanOk(span)
      return {
        content: '',
        agentResults: [],
        durationMs: Date.now() - startedAt,
        pattern: 'breaker-short-circuit',
      }
    }

    const pattern = ctx.resolvePattern(ctx.definition.coordinatorPattern)
    const patternCtx = await ctx.buildPatternContext(
      ctx.task,
      ctx.runId,
      startedAt,
      span,
    )
    const result = await pattern.execute(patternCtx)

    transitionPhase(phase, 'evaluating', phaseOpts)
    transitionPhase(phase, 'completing', phaseOpts)
    emitTeamCompleted(ctx, Date.now() - startedAt)

    await consolidateIfEnabled({
      teamId: ctx.definition.id,
      runId: ctx.runId,
      policies: ctx.policies,
      memory: ctx.memory,
      emitEvent: ctx.emitEvent,
    })

    if (span && ctx.tracer) ctx.tracer.endSpanOk(span)
    return result
  } catch (err: unknown) {
    transitionPhase(phase, 'failed', phaseOpts)
    ctx.emitEvent({
      type: 'team_failed',
      teamId: ctx.definition.id,
      runId: ctx.runId,
      error: err instanceof Error ? err.message : String(err),
      at: new Date(),
    })
    if (span && ctx.tracer) ctx.tracer.endSpanWithError(span, err)
    throw err
  } finally {
    ctx.setCurrentSpan(undefined)
  }
}

function startSpan(ctx: ExecuteContext): TeamOTelSpanLike | undefined {
  const span = ctx.tracer?.startPhaseSpan(`team:${ctx.definition.id}`, {
    runId: ctx.runId,
  })
  if (span) {
    span.setAttribute('team.run_id', ctx.runId)
    span.setAttribute('team.agent_count', ctx.definition.participants.length)
    span.setAttribute(
      'team.coordination_pattern',
      ctx.definition.coordinatorPattern,
    )
  }
  return span
}

function allBreakersOpen(
  participants: ParticipantDefinition[],
  tracker: TeamBreakerTracker | undefined,
): boolean {
  if (!tracker || participants.length === 0) return false
  return participants.every((p) => !tracker.isAvailable(p.id))
}

function emitTeamCompleted(ctx: ExecuteContext, durationMs: number): void {
  ctx.emitEvent({
    type: 'team_completed',
    teamId: ctx.definition.id,
    runId: ctx.runId,
    durationMs,
    at: new Date(),
  })
}
