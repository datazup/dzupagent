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
  return (
    contextCount === 1
    && isGenerateContextMessage(messages.at(-1), context)
  )
}

/**
 * Place caller context exactly once at the system-message suffix boundary.
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

  return [
    ...messages.filter(message => !isGenerateContextMessage(message, context)),
    new SystemMessage(context),
  ]
}
