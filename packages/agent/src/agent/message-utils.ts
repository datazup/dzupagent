import { SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { estimateTokens, formatSummaryContext } from '@dzupagent/core'

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

export function estimateConversationTokensForMessages(messages: BaseMessage[]): number {
  const fullText = messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content),
    )
    .join('')

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
