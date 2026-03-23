/**
 * Conversation history manager for LangGraph agents.
 *
 * Prevents unbounded token growth by summarizing older messages when the
 * conversation exceeds a configurable threshold, while keeping the most
 * recent messages intact for immediate context.
 *
 * Generic — accepts the summarization model as a parameter rather than
 * importing a concrete model factory.
 */
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

export interface MessageManagerConfig {
  /** Maximum message count before triggering summarization (default 30) */
  maxMessages?: number
  /** Number of recent messages to keep verbatim after summarization (default 10) */
  keepRecentMessages?: number
  /** Maximum estimated token budget for the messages array (default 12 000) */
  maxMessageTokens?: number
  /** Rough characters-per-token for budget estimation (default 4) */
  charsPerToken?: number
}

const DEFAULTS: Required<MessageManagerConfig> = {
  maxMessages: 30,
  keepRecentMessages: 10,
  maxMessageTokens: 12_000,
  charsPerToken: 4,
}

// ---------- Public API -------------------------------------------------------

/**
 * Check whether conversation history needs summarization.
 *
 * Triggers when either:
 * - Message count exceeds `maxMessages`
 * - Estimated token count exceeds `maxMessageTokens`
 */
export function shouldSummarize(
  messages: BaseMessage[],
  config?: MessageManagerConfig,
): boolean {
  const cfg = { ...DEFAULTS, ...config }

  if (messages.length > cfg.maxMessages) return true

  const totalChars = messages.reduce((sum, m) => {
    const content =
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    return sum + content.length
  }, 0)

  return Math.ceil(totalChars / cfg.charsPerToken) > cfg.maxMessageTokens
}

/**
 * Summarize older messages and return the trimmed array plus summary text.
 *
 * Keeps the `keepRecentMessages` most recent messages intact and summarizes
 * everything before them. If there is an existing summary it is extended
 * rather than replaced.
 *
 * @param messages        Full conversation history
 * @param existingSummary Previous summary to extend (null if none)
 * @param model           Chat model used for summarization
 * @param config          Optional overrides
 */
export async function summarizeAndTrim(
  messages: BaseMessage[],
  existingSummary: string | null,
  model: BaseChatModel,
  config?: MessageManagerConfig,
): Promise<{ summary: string; trimmedMessages: BaseMessage[] }> {
  const cfg = { ...DEFAULTS, ...config }
  const keep = cfg.keepRecentMessages

  if (messages.length <= keep) {
    return { summary: existingSummary ?? '', trimmedMessages: messages }
  }

  const oldMessages = messages.slice(0, -keep)
  const recentMessages = messages.slice(-keep)

  const summaryPrompt = existingSummary
    ? `Existing summary:\n${existingSummary}\n\nNew messages to incorporate:\n`
    : 'Summarize this conversation concisely, preserving key decisions, requirements, and context:\n\n'

  const formattedOld = oldMessages
    .map(m => {
      const role = m._getType()
      const content =
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      return `[${role}]: ${content.slice(0, 500)}`
    })
    .join('\n')

  try {
    const response = await model.invoke([
      new SystemMessage(
        'You are a conversation summarizer. Produce a concise summary preserving all important decisions, requirements, and technical context. Be factual and specific.',
      ),
      new HumanMessage(`${summaryPrompt}${formattedOld}`),
    ])
    const summary =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)

    return { summary, trimmedMessages: recentMessages }
  } catch {
    // If summarization fails, just trim without summarizing
    return { summary: existingSummary ?? '', trimmedMessages: recentMessages }
  }
}

/**
 * Build a system-message prefix that includes a prior conversation summary.
 * Returns '' if there is no summary.
 */
export function formatSummaryContext(summary: string | null): string {
  if (!summary || summary.trim().length === 0) return ''
  return `## Prior Conversation Context\n\n${summary}`
}
