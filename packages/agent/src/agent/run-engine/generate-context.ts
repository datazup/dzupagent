import { SystemMessage, type BaseMessage } from '@langchain/core/messages'

function isGenerateContextMessage(
  message: BaseMessage | undefined,
  context: string,
): boolean {
  if (message?._getType() !== 'system') return false
  if (message.content === context) return true
  if (!Array.isArray(message.content) || message.content.length !== 1) {
    return false
  }

  const block = message.content[0]
  return (
    typeof block === 'object'
    && block !== null
    && 'text' in block
    && block.text === context
  )
}

/**
 * A trailing AI message with tool calls is a pending exchange: its tool
 * results are appended next, so nothing may be placed after it (DZC-P1c).
 */
function hasPendingToolCallTail(messages: readonly BaseMessage[]): boolean {
  const last = messages.at(-1)
  if (last?._getType() !== 'ai') return false
  const toolCalls = (last as { tool_calls?: unknown[] }).tool_calls
  return Array.isArray(toolCalls) && toolCalls.length > 0
}

/** Whether a non-empty caller context is present exactly once as the suffix. */
export function hasExactGenerateContextSuffix(
  messages: readonly BaseMessage[],
  context: string | undefined,
): boolean {
  if (context === undefined || context === '') return true

  let contextCount = 0
  for (const message of messages) {
    if (isGenerateContextMessage(message, context)) contextCount += 1
  }
  const suffixSlot = hasPendingToolCallTail(messages) ? -2 : -1
  return (
    contextCount === 1
    && isGenerateContextMessage(messages.at(suffixSlot), context)
  )
}

/**
 * Place caller context exactly once at the system-message suffix boundary.
 * When the transcript ends with a pending tool-call exchange, the boundary is
 * just before that AI message, so its tool results still follow it directly.
 *
 * The returned array is new only when placement must change. Message objects
 * and the caller-owned input array are never mutated. Re-applying the helper
 * after hooks or transcript compression is idempotent, so later model turns
 * cannot lose or accumulate the option-owned suffix.
 */
export function appendGenerateContext(
  messages: BaseMessage[],
  context: string | undefined,
): BaseMessage[] {
  if (context === undefined || context === '') return messages

  if (hasExactGenerateContextSuffix(messages, context)) {
    return messages
  }

  const rest = messages.filter(
    message => !isGenerateContextMessage(message, context),
  )
  if (hasPendingToolCallTail(rest)) {
    return [...rest.slice(0, -1), new SystemMessage(context), rest.at(-1)!]
  }
  return [...rest, new SystemMessage(context)]
}
