/**
 * Contract-net coordination pattern.
 *
 * Specialists bid on a CFP, the configured award strategy selects a winner,
 * and the winner executes. Delegates to `ContractNetManager.execute`.
 */

import { ContractNetManager } from '../../contract-net/contract-net-manager.js'
import { omitUndefined } from '../../../utils/exact-optional.js'
import type {
  TeamPattern,
  TeamPatternContext,
  TeamPatternResult,
} from './team-pattern.js'
import { runSingleParticipant } from './pattern-utils.js'

export const contractNetPattern: TeamPattern = {
  id: 'contract_net',

  async execute(ctx: TeamPatternContext): Promise<TeamPatternResult> {
    const startTime = ctx.startedAt
    const spawned = ctx.participants
    const managerEntry =
      spawned.find((s) => s.participant.role === 'supervisor') ?? spawned[0]
    if (!managerEntry) {
      throw new Error('TeamRuntime[contract_net]: team has no participants')
    }
    const specialists = spawned.filter((s) => s !== managerEntry)
    if (specialists.length === 0) {
      return runSingleParticipant(managerEntry, ctx.task, startTime)
    }

    for (const s of spawned) ctx.hooks.emitParticipantStart(s.participant)

    const contractResult = await ContractNetManager.execute({
      specialists: specialists.map((s) => s.spawned.agent),
      task: ctx.task,
    })

    const durationMs = Date.now() - startTime
    for (const s of spawned) {
      const success =
        s.spawned.agent.id === contractResult.agentId
          ? contractResult.success
          : true
      ctx.hooks.emitParticipantComplete(
        s.participant,
        success,
        durationMs,
        contractResult.error,
      )
    }

    return {
      content: contractResult.result ?? '',
      agentResults: spawned.map((s) =>
        omitUndefined({
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
        }),
      ),
      durationMs,
      pattern: 'contract-net',
    }
  },
}
