/**
 * Peer-to-peer coordination pattern.
 *
 * Parallel fan-out across all resolved participants, then merge the
 * successful contributions. Concurrency is bounded by
 * `policies.execution.maxParallelParticipants` (default 5). Failures
 * are non-fatal and surface as `success=false` agent results.
 */

import { HumanMessage } from '@langchain/core/messages'
import { concatMerge, type MergeStrategyFn } from '../../merge-strategies.js'
import type { TeamRunResult } from '../team-workspace.js'
import type {
  TeamPattern,
  TeamPatternContext,
  TeamPatternResult,
} from './team-pattern.js'
import {
  DEFAULT_MAX_PARALLEL_PARTICIPANTS,
  mapSettledWithConcurrency,
} from './pattern-utils.js'

export const peerToPeerPattern: TeamPattern = {
  id: 'peer_to_peer',

  async execute(ctx: TeamPatternContext): Promise<TeamPatternResult> {
    const startTime = ctx.startedAt
    const spawned = ctx.participants
    if (spawned.length === 0) {
      throw new Error('TeamRuntime[peer_to_peer]: team has no participants')
    }

    for (const s of spawned) ctx.hooks.emitParticipantStart(s.participant)

    const merge: MergeStrategyFn = concatMerge
    const results: TeamRunResult['agentResults'] = []
    const concurrency =
      ctx.policies.execution?.maxParallelParticipants ??
      DEFAULT_MAX_PARALLEL_PARTICIPANTS

    const settled = await mapSettledWithConcurrency(
      spawned,
      concurrency,
      async (entry) => {
        const t0 = Date.now()
        const res = await entry.spawned.agent.generate([new HumanMessage(ctx.task)])
        return {
          agentId: entry.spawned.agent.id,
          role: entry.spawned.role,
          content: res.content,
          durationMs: Date.now() - t0,
        }
      },
    )

    const successContents: string[] = []
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!
      const entry = spawned[i]!
      if (outcome.status === 'fulfilled') {
        results.push({ ...outcome.value, success: true })
        successContents.push(outcome.value.content)
        ctx.hooks.emitParticipantComplete(
          entry.participant,
          true,
          outcome.value.durationMs,
        )
      } else {
        const msg =
          outcome.reason instanceof Error
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
        ctx.hooks.emitParticipantComplete(entry.participant, false, 0, msg)
      }
    }

    const merged = successContents.length > 0 ? await merge(successContents) : ''

    return {
      content: merged,
      agentResults: results,
      durationMs: Date.now() - startTime,
      pattern: 'peer-to-peer',
    }
  },
}
