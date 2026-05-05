/**
 * Council coordination pattern.
 *
 * Proposers contribute candidate answers; a designated judge picks the
 * best one. Delegates to `AgentOrchestrator.debate`. The judge is selected
 * by matching `policies.governance.judgeModel` against participant
 * `model` fields (falling back to the first participant when no match).
 */

import { AgentOrchestrator } from '../../orchestrator.js'
import type {
  TeamPattern,
  TeamPatternContext,
  TeamPatternResult,
} from './team-pattern.js'
import { runSingleParticipant } from './pattern-utils.js'

/** Default model used when no `governance.judgeModel` policy is set. */
export const DEFAULT_GOVERNANCE_MODEL = 'claude-opus-4-7'

export const councilPattern: TeamPattern = {
  id: 'council',

  async execute(ctx: TeamPatternContext): Promise<TeamPatternResult> {
    const startTime = ctx.startedAt
    const spawned = ctx.participants
    if (spawned.length === 0) {
      throw new Error('TeamRuntime[council]: team has no participants')
    }

    // Pick a judge: prefer a participant whose model matches governance.judgeModel,
    // fall back to the first participant. Proposers are the remaining participants.
    const judgeModel =
      ctx.policies.governance?.judgeModel ?? DEFAULT_GOVERNANCE_MODEL
    if (ctx.policies.governance?.judgeModel !== undefined) {
      ctx.hooks.emitPolicyApplied('governance', 'judgeModel')
    }
    const judgeEntry =
      spawned.find((s) => s.participant.model === judgeModel) ?? spawned[0]!
    const proposers = spawned.filter((s) => s !== judgeEntry)

    if (proposers.length === 0) {
      return runSingleParticipant(judgeEntry, ctx.task, startTime)
    }

    for (const s of spawned) ctx.hooks.emitParticipantStart(s.participant)

    try {
      const content = await AgentOrchestrator.debate(
        proposers.map((p) => p.spawned.agent),
        judgeEntry.spawned.agent,
        ctx.task,
      )

      const durationMs = Date.now() - startTime
      for (const s of spawned) {
        ctx.hooks.emitParticipantComplete(s.participant, true, durationMs)
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
        pattern: 'council',
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const durationMs = Date.now() - startTime
      for (const s of spawned) {
        ctx.hooks.emitParticipantComplete(s.participant, false, durationMs, message)
      }
      throw err
    }
  },
}
