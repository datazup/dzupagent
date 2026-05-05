/**
 * Blackboard coordination pattern.
 *
 * Participants share a workspace and iterate in rounds. On each round every
 * participant reads the workspace, produces a contribution, and writes it
 * back under its own key. The runtime supplies the workspace via
 * `TeamPatternContext.workspace`.
 */

import { HumanMessage } from '@langchain/core/messages'
import { omitUndefined } from '../../../utils/exact-optional.js'
import type {
  TeamPattern,
  TeamPatternContext,
  TeamPatternResult,
} from './team-pattern.js'
import {
  DEFAULT_BLACKBOARD_CONTEXT_MAX_ENTRY_CHARS,
  DEFAULT_BLACKBOARD_CONTEXT_MAX_SERIALIZED_CHARS,
  compactText,
  formatCompactedWorkspaceContext,
  type ResolvedBlackboardContextPolicy,
} from './pattern-utils.js'
import type { TeamPolicies } from '../team-policy.js'
import type { SharedWorkspace } from '../team-workspace.js'

const DEFAULT_MAX_ROUNDS = 3

function resolveBlackboardContextPolicy(
  policies: TeamPolicies,
): ResolvedBlackboardContextPolicy {
  const configured = policies.memory?.blackboardContext
  const maxSerializedChars =
    configured?.maxSerializedChars ??
    DEFAULT_BLACKBOARD_CONTEXT_MAX_SERIALIZED_CHARS
  const maxEntryChars =
    configured?.maxEntryChars ??
    Math.min(DEFAULT_BLACKBOARD_CONTEXT_MAX_ENTRY_CHARS, maxSerializedChars)
  return {
    maxSerializedChars,
    maxEntryChars,
    overflowBehavior: configured?.overflowBehavior ?? 'compact',
  }
}

function prepareBlackboardContribution(
  value: string,
  policy: ResolvedBlackboardContextPolicy,
): string {
  if (value.length <= policy.maxEntryChars) return value
  if (policy.overflowBehavior === 'reject') {
    throw new Error(
      `TeamRuntime[blackboard]: contribution exceeds maxEntryChars (${value.length}/${policy.maxEntryChars})`,
    )
  }
  return compactText(value, policy.maxEntryChars)
}

function formatBoundedBlackboardContext(
  workspace: SharedWorkspace,
  policy: ResolvedBlackboardContextPolicy,
): string {
  const fullContext = workspace.formatAsContext()
  if (fullContext.length <= policy.maxSerializedChars) return fullContext
  if (policy.overflowBehavior === 'reject') {
    throw new Error(
      `TeamRuntime[blackboard]: shared context exceeds maxSerializedChars (${fullContext.length}/${policy.maxSerializedChars})`,
    )
  }
  return formatCompactedWorkspaceContext(workspace, policy)
}

export const blackboardPattern: TeamPattern = {
  id: 'blackboard',

  async execute(ctx: TeamPatternContext): Promise<TeamPatternResult> {
    const startTime = ctx.startedAt
    const spawned = ctx.participants
    if (spawned.length === 0) {
      throw new Error('TeamRuntime[blackboard]: team has no participants')
    }
    const workspace = ctx.workspace
    const maxRounds = DEFAULT_MAX_ROUNDS
    const timings = new Map<string, number>()
    const contextPolicy = resolveBlackboardContextPolicy(ctx.policies)

    await workspace.set('task', ctx.task, '__runtime__')
    await workspace.set('round', '0', '__runtime__')
    for (const s of spawned) {
      ctx.hooks.emitParticipantStart(s.participant)
      timings.set(s.spawned.agent.id, 0)
    }

    for (let round = 0; round < maxRounds; round++) {
      await workspace.set('round', String(round + 1), '__runtime__')
      for (const entry of spawned) {
        const t0 = Date.now()
        const context = formatBoundedBlackboardContext(workspace, contextPolicy)
        const prompt = [
          `You are participating in a collaborative blackboard session (round ${round + 1}).`,
          '',
          `## Task`,
          ctx.task,
          '',
          context,
          '',
          `Write your contribution. Focus on your role as "${entry.participant.role}".`,
          `Your output will be stored in the shared workspace under key "${entry.spawned.agent.id}".`,
        ].join('\n')

        try {
          const result = await entry.spawned.agent.generate([new HumanMessage(prompt)])
          const contribution = prepareBlackboardContribution(result.content, contextPolicy)
          entry.spawned.lastResult = contribution
          await workspace.set(
            entry.spawned.agent.id,
            contribution,
            entry.spawned.agent.id,
          )
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
      ctx.hooks.emitParticipantComplete(
        s.participant,
        s.spawned.lastError === undefined,
        timings.get(s.spawned.agent.id) ?? 0,
        s.spawned.lastError,
      )
    }

    return {
      content: formatBoundedBlackboardContext(workspace, contextPolicy),
      agentResults: spawned.map((s) =>
        omitUndefined({
          agentId: s.spawned.agent.id,
          role: s.spawned.role,
          content: s.spawned.lastResult ?? '',
          success: s.spawned.lastError === undefined,
          error: s.spawned.lastError,
          durationMs: timings.get(s.spawned.agent.id) ?? 0,
        }),
      ),
      durationMs,
      pattern: 'blackboard',
    }
  },
}
