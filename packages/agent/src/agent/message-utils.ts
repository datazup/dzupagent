import { SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { estimateTokens, type Tokenizer } from '@dzupagent/core/llm'
import { formatSummaryContext } from '@dzupagent/context'

interface BuildPreparedMessagesParams {
  baseInstructions: string
  memoryContext: string | null
  conversationSummary: string | null
  messages: BaseMessage[]
}

export function buildPreparedMessages({
  baseInstructions,
  memoryContext,
  conversationSummary,
  messages,
}: BuildPreparedMessagesParams): BaseMessage[] {
  const parts: string[] = [baseInstructions]

  if (memoryContext) {
    parts.push(memoryContext)
  }

  const summaryContext = formatSummaryContext(conversationSummary)
  if (summaryContext) {
    parts.push(summaryContext)
  }

  return [new SystemMessage(parts.join('\n\n')), ...messages]
}

/**
 * Estimate conversation token count.
 *
 * When a {@link Tokenizer} is provided (MC-08), it is used for an accurate
 * count via `countTokens()`; otherwise the legacy char/4 heuristic
 * (`estimateTokens`) is used so callers retain backwards-compatible
 * semantics.
 */
export function estimateConversationTokensForMessages(
  messages: BaseMessage[],
  tokenizer?: Tokenizer,
): number {
  const fullText = messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content),
    )
    .join('')

  if (tokenizer) {
    return tokenizer.countTokens(fullText)
  }
  return estimateTokens(fullText)
}

export function extractFinalAiMessageContent(messages: BaseMessage[]): string {
  const lastAi = [...messages].reverse().find((message) => message._getType() === 'ai')
  if (!lastAi) {
    return ''
  }

  return typeof lastAi.content === 'string'
    ? lastAi.content
    : JSON.stringify(lastAi.content)
}
