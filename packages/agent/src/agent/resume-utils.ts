/**
 * resume-utils — rebuild a minimal message history from a run's journal so the
 * agent can continue a previously-paused run without re-executing steps that
 * already completed.
 *
 * The rehydrated transcript is intentionally lossy: we reconstruct the user's
 * original prompt plus a synthetic AI message per `step_completed` entry. This
 * gives the model enough context to continue from the last committed step
 * without re-playing tool calls that already mutated external state.
 */
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import type { RunJournalEntry } from '@dzupagent/core'

/**
 * Rebuild a conversation transcript from journal entries and the original
 * human input. Entries are filtered to `step_completed` and sorted by `seq`
 * so the caller may pass unsorted slices.
 */
export function rehydrateMessagesFromJournal(
  entries: RunJournalEntry[],
  originalInput: string,
): BaseMessage[] {
  const messages: BaseMessage[] = []
  messages.push(new HumanMessage(originalInput))

  const stepEntries = entries
    .filter((e) => e.type === 'step_completed')
    .sort((a, b) => a.seq - b.seq)

  for (const entry of stepEntries) {
    const data = entry.data as { stepId?: string; toolName?: string; result?: string }
    const toolName = data.toolName ?? data.stepId ?? 'unknown_step'
    const result = data.result ?? '[completed]'
    messages.push(
      new AIMessage(`[Resumed from checkpoint] Step "${toolName}" completed: ${result}`),
    )
  }

  return messages
}
