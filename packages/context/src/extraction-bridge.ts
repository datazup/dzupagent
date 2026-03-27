/**
 * Bridge between context compression and memory extraction.
 *
 * Creates an onBeforeSummarize hook from a generic extraction function.
 * This allows @dzipagent/context to support pre-compression extraction
 * without depending on @dzipagent/memory.
 */
import type { BaseMessage } from '@langchain/core/messages'

/**
 * Generic extraction function signature.
 * Accepts messages and returns a promise (result is ignored — side effect only).
 */
export type MessageExtractionFn = (messages: BaseMessage[]) => Promise<void>

/**
 * Create an onBeforeSummarize hook that:
 * 1. Filters to only human and AI messages (skips tool results)
 * 2. Takes only the last N messages from the old batch (to avoid extracting from very old context)
 * 3. Calls the extraction function
 */
export function createExtractionHook(
  extractFn: MessageExtractionFn,
  options?: {
    /** Max messages to extract from (default: 20) */
    maxMessages?: number
    /** Only extract from these message types (default: ['human', 'ai']) */
    messageTypes?: string[]
  },
): (messages: BaseMessage[]) => Promise<void> {
  const maxMessages = options?.maxMessages ?? 20
  const types = new Set(options?.messageTypes ?? ['human', 'ai'])

  return async (messages: BaseMessage[]) => {
    const filtered = messages.filter(m => types.has(m._getType()))
    const toExtract = filtered.slice(-maxMessages)
    if (toExtract.length > 0) {
      await extractFn(toExtract)
    }
  }
}
