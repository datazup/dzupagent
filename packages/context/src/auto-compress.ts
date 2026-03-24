/**
 * Auto-compression pipeline for agent conversations.
 *
 * 4-phase compression integrated into the agent loop:
 * 1. Tool result pruning (cheap, no LLM)
 * 2. Orphaned pair repair
 * 3. Boundary-aware split + LLM summarization
 * 4. Frozen snapshot support for prompt cache optimization
 *
 * This module orchestrates the primitives from @forgeagent/core's
 * message-manager into a single autoCompress() call suitable for
 * agent loop integration.
 */
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  shouldSummarize,
  summarizeAndTrim,
  type MessageManagerConfig,
} from './message-manager.js'

export interface AutoCompressConfig extends MessageManagerConfig {
  /** If true, memory context is frozen at init and not reloaded mid-session */
  frozenSnapshot?: boolean
}

export interface CompressResult {
  messages: BaseMessage[]
  summary: string | null
  compressed: boolean
}

/**
 * Run the full 4-phase compression pipeline on a message array.
 *
 * Returns the compressed messages and updated summary. Only invokes
 * the LLM summarizer when the message count/token threshold is exceeded.
 */
export async function autoCompress(
  messages: BaseMessage[],
  existingSummary: string | null,
  model: BaseChatModel,
  config?: AutoCompressConfig,
): Promise<CompressResult> {
  if (!shouldSummarize(messages, config)) {
    return { messages, summary: existingSummary, compressed: false }
  }

  // summarizeAndTrim internally runs:
  // 1. Tool result pruning (cheap, no LLM)
  // 2. Boundary-aware split that respects tool call/result pairs
  // 3. Orphaned pair repair on the recent section
  // 4. LLM-based structured summarization of old messages
  const { summary, trimmedMessages } = await summarizeAndTrim(
    messages,
    existingSummary,
    model,
    config,
  )

  return { messages: trimmedMessages, summary, compressed: true }
}

/**
 * Frozen snapshot manager — captures memory/context at session start
 * and prevents mid-session reloads to preserve prompt cache prefix.
 *
 * Anthropic prompt caching gives 75% cost reduction when the beginning
 * of the messages array is stable. By freezing the system prompt + memory
 * context at session start, all subsequent calls share the cached prefix.
 */
export class FrozenSnapshot {
  private frozen: string | null = null
  private isFrozen = false

  /** Capture the current context as the frozen snapshot */
  freeze(context: string): void {
    this.frozen = context
    this.isFrozen = true
  }

  /** Get the frozen context, or null if not frozen */
  get(): string | null {
    return this.frozen
  }

  /** Check if a snapshot has been frozen */
  isActive(): boolean {
    return this.isFrozen
  }

  /** Clear the frozen snapshot (for next session) */
  thaw(): void {
    this.frozen = null
    this.isFrozen = false
  }
}
