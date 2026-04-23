/**
 * Auto-compression pipeline for agent conversations.
 *
 * 4-phase compression integrated into the agent loop:
 * 1. Tool result pruning (cheap, no LLM)
 * 2. Orphaned pair repair
 * 3. Boundary-aware split + LLM summarization
 * 4. Frozen snapshot support for prompt cache optimization
 *
 * This module orchestrates the primitives from @dzupagent/core's
 * message-manager into a single autoCompress() call suitable for
 * agent loop integration.
 */
import type { Table } from 'apache-arrow'
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { batchOverlapAnalysis, computeFrameDelta } from '@dzupagent/memory-ipc'
import {
  shouldSummarize,
  summarizeAndTrim,
  type MessageManagerConfig,
} from './message-manager.js'

export interface AutoCompressConfig extends MessageManagerConfig {
  /** If true, memory context is frozen at init and not reloaded mid-session */
  frozenSnapshot?: boolean

  /**
   * Hook called with the old messages that are about to be summarized away.
   * Use this to extract observations or other data before compression.
   * The hook receives the messages that will be lost after summarization.
   * Non-blocking: errors in the hook don't prevent compression.
   */
  onBeforeSummarize?: (messages: BaseMessage[]) => Promise<void> | void

  /**
   * Hard token ceiling for the compressed output. If set and the post-
   * compression message array still exceeds this budget, we truncate from
   * the start, keeping only the most recent messages that fit.
   */
  budget?: number

  /**
   * Telemetry callback invoked when a hard-budget truncation fallback
   * occurs. Receives a reason identifier plus before/after token counts.
   */
  onFallback?: (reason: string, before: number, after: number) => void

  /**
   * Optional Arrow MemoryFrame. When set, batchOverlapAnalysis is called
   * before summarizeAndTrim to drop messages that duplicate memory content.
   * Zero impact when not set.
   */
  memoryFrame?: unknown
}

export interface CompressResult {
  messages: BaseMessage[]
  summary: string | null
  compressed: boolean
  /** Set when a fallback strategy (e.g. hard truncation) was applied. */
  fallbackReason?: string
}

/** Rough token estimate based on JSON character length (~4 chars/token). */
function estimateMessageTokens(messages: BaseMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
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

  // Call the pre-summarize hook with messages that are about to be compressed away.
  // Uses keepRecentMessages (default 10) to estimate which messages will be lost.
  const keep = config?.keepRecentMessages ?? 10
  if (messages.length > keep && config?.onBeforeSummarize) {
    const oldMessages = messages.slice(0, messages.length - keep)
    try {
      await config.onBeforeSummarize(oldMessages)
    } catch {
      // Non-fatal: extraction failure must not prevent compression
    }
  }

  // Arrow-aware overlap filtering: drop messages that duplicate memory content.
  // Only runs when config.memoryFrame is set — zero-impact otherwise.
  let messagesToCompress = messages
  if (config?.memoryFrame) {
    try {
      const messageTexts = messages.map(m =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      )
      const analysis = batchOverlapAnalysis(
        messageTexts,
        config.memoryFrame as Table,
      )
      // Drop duplicate messages (keep novel ones + recent messages unconditionally)
      const duplicateIndices = new Set(analysis.duplicate.map(d => d.index))
      messagesToCompress = messages.filter(
        (_, i) => !duplicateIndices.has(i) || i >= messages.length - keep,
      )
    } catch {
      // Non-fatal: Arrow analysis failure falls back to full message list
    }
  }

  // summarizeAndTrim internally runs:
  // 1. Tool result pruning (cheap, no LLM)
  // 2. Boundary-aware split that respects tool call/result pairs
  // 3. Orphaned pair repair on the recent section
  // 4. LLM-based structured summarization of old messages
  const { summary, trimmedMessages } = await summarizeAndTrim(
    messagesToCompress,
    existingSummary,
    model,
    config,
  )

  // Enforce the hard token ceiling if one was configured. If summarization
  // still produced a result over budget, drop the oldest trimmed messages
  // until we fit.
  if (config?.budget !== undefined) {
    const before = estimateMessageTokens(trimmedMessages)
    if (before > config.budget) {
      let truncated = trimmedMessages
      while (truncated.length > 0 && estimateMessageTokens(truncated) > config.budget) {
        truncated = truncated.slice(1)
      }
      const after = estimateMessageTokens(truncated)
      config.onFallback?.('truncation', before, after)
      return {
        messages: truncated,
        summary,
        compressed: true,
        fallbackReason: 'truncation',
      }
    }
  }

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
  private frozenFrame: unknown = null

  /** Capture the current context as the frozen snapshot, optionally storing an Arrow frame */
  freeze(context: string, frame?: unknown): void {
    this.frozen = context
    this.isFrozen = true
    this.frozenFrame = frame ?? null
  }

  /** Get the frozen context, or null if not frozen */
  get(): string | null {
    return this.frozen
  }

  /** Check if a snapshot has been frozen */
  isActive(): boolean {
    return this.isFrozen
  }

  /**
   * Check whether the frozen snapshot should be invalidated based on changes
   * to the memory frame since it was frozen.
   *
   * Returns true when:
   * - No frame was stored at freeze time (can't compare → conservative invalidate)
   * - computeFrameDelta reports shouldRefreeze === true
   * Returns false when delta has no significant changes.
   */
  shouldInvalidate(newFrame: unknown): boolean {
    if (!this.isFrozen || this.frozenFrame === null) {
      return true
    }
    try {
      const delta = computeFrameDelta(
        this.frozenFrame as Table,
        newFrame as Table,
      )
      return delta.shouldRefreeze
    } catch {
      // If comparison fails, conservatively return true
      return true
    }
  }

  /** Clear the frozen snapshot (for next session) */
  thaw(): void {
    this.frozen = null
    this.isFrozen = false
    this.frozenFrame = null
  }
}
