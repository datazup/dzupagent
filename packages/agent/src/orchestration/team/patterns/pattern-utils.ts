/**
 * Shared utilities for `TeamPattern` implementations.
 *
 * Helpers that more than one pattern needs (degenerate single-participant
 * fallback, bounded concurrency, blackboard context compaction). Each
 * pattern file imports just what it needs to keep dependencies explicit.
 */

import { HumanMessage } from '@langchain/core/messages'
import type { DzupAgent } from '../../../agent/dzip-agent.js'
import type { SharedWorkspace, TeamRunResult } from '../team-workspace.js'
import type { ResolvedParticipant } from './team-pattern.js'
import type { BlackboardContextOverflowBehavior } from '../team-policy.js'

export const DEFAULT_MAX_PARALLEL_PARTICIPANTS = 5
export const DEFAULT_BLACKBOARD_CONTEXT_MAX_SERIALIZED_CHARS = 16_000
export const DEFAULT_BLACKBOARD_CONTEXT_MAX_ENTRY_CHARS = 4_000

/**
 * Run a single resolved participant directly, bypassing coordination.
 * Used as the degenerate case when a coordination pattern collapses to one
 * participant (e.g. a `supervisor` team with no specialists, or a
 * `contract_net` team with no bidders).
 */
export async function runSingleParticipant(
  entry: ResolvedParticipant,
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
    pattern: 'single-participant',
  }
}

/**
 * Bounded-concurrency `Promise.allSettled` over a homogeneous list of
 * items. Keeps result ordering identical to `items` so callers can pair
 * outcomes with their source by index.
 */
export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const settled: Array<PromiseSettledResult<R>> = new Array(items.length)
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return

      try {
        settled[index] = {
          status: 'fulfilled',
          value: await mapper(items[index]!, index),
        }
      } catch (reason: unknown) {
        settled[index] = { status: 'rejected', reason }
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return settled
}

/** Effective blackboard context policy after defaults. */
export interface ResolvedBlackboardContextPolicy {
  maxSerializedChars: number
  maxEntryChars: number
  overflowBehavior: BlackboardContextOverflowBehavior
}

/** Compact a string by keeping a head + tail and inserting an ellipsis marker. */
export function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = '\n\n[compacted: middle omitted to fit blackboard context budget]\n\n'
  if (maxChars <= marker.length + 2) {
    return value.slice(0, maxChars)
  }
  const remaining = maxChars - marker.length
  const headChars = Math.ceil(remaining * 0.6)
  const tailChars = Math.max(0, remaining - headChars)
  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`
}

/** Format a workspace as bounded context, compacting entries to fit the budget. */
export function formatCompactedWorkspaceContext(
  workspace: SharedWorkspace,
  policy: ResolvedBlackboardContextPolicy,
): string {
  const lines: string[] = ['## Shared Workspace']
  let remaining = policy.maxSerializedChars - lines[0]!.length

  for (const [key, rawValue] of workspace.entries()) {
    if (!rawValue || remaining <= 0) continue
    const heading = `### ${key}`
    const sectionOverhead = heading.length + 3
    if (remaining <= sectionOverhead) break

    const maxValueChars = Math.min(
      policy.maxEntryChars,
      remaining - sectionOverhead,
    )
    const value = compactText(rawValue, maxValueChars)
    lines.push(heading)
    lines.push(value)
    lines.push('')
    remaining -= sectionOverhead + value.length
  }

  const formatted = lines.join('\n')
  if (formatted.length <= policy.maxSerializedChars) return formatted
  return formatted.slice(0, policy.maxSerializedChars)
}
