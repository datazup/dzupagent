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
import type { RunJournalEntry, StepCompletedEntry } from '@dzupagent/core/persistence'

/**
 * Render a completed step's recorded output for the synthetic transcript.
 *
 * `StepCompletedEntry.data.output` is `unknown`, so anything that is not
 * already a string is JSON-encoded rather than interpolated directly — a
 * structured tool result must not degrade to `[object Object]`.
 */
function formatStepOutput(output: unknown): string {
  if (output === undefined || output === null) return '[completed]'
  if (typeof output === 'string') return output
  try {
    // `JSON.stringify` is declared as returning `string`, but genuinely
    // returns `undefined` for values with no JSON representation.
    const encoded: string | undefined = JSON.stringify(output)
    return encoded ?? String(output)
  } catch {
    // A non-serialisable payload (e.g. a circular object held by an
    // in-memory journal) must not break the resume path.
    return String(output)
  }
}

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
    .filter((e): e is StepCompletedEntry => e.type === 'step_completed')
    .sort((a, b) => a.seq - b.seq)

  for (const entry of stepEntries) {
    const { stepId, toolName, output } = entry.data
    const label = toolName ?? stepId ?? 'unknown_step'
    messages.push(
      new AIMessage(
        `[Resumed from checkpoint] Step "${label}" completed: ${formatStepOutput(output)}`,
      ),
    )
  }

  return messages
}
