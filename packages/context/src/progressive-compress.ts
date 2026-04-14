/**
 * Progressive compression with 5 graduated levels.
 *
 * Each level includes all processing from lower levels, providing a
 * smooth tradeoff between token usage and information retention:
 *
 *   Level 0 — Full messages, no compression
 *   Level 1 — Tool result pruning only (no LLM call)
 *   Level 2 — Level 1 + trim verbose AI responses
 *   Level 3 — Level 2 + structured summarization of old messages (LLM call)
 *   Level 4 — Ultra-compressed: summary + last N messages only
 */
import {
  AIMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  pruneToolResults,
  repairOrphanedToolPairs,
  summarizeAndTrim,
} from './message-manager.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompressionLevel = 0 | 1 | 2 | 3 | 4

export interface ProgressiveCompressConfig {
  /** Number of recent messages to keep at level 3 (default: 10) */
  keepRecentLevel3?: number
  /** Number of recent messages to keep at level 4 (default: 3) */
  keepRecentLevel4?: number
  /** Max chars for AI response before trimming at level 2 (default: 500) */
  aiResponseMaxChars?: number
  /** Number of recent tool results to preserve at level 1 (default: 6) */
  preserveRecentToolResults?: number
  /** Chars per token for estimation (default: 4) */
  charsPerToken?: number
  /** Hook called before summarization */
  onBeforeSummarize?: (messages: BaseMessage[]) => Promise<void> | void
}

export interface ProgressiveCompressResult {
  /** Compressed messages */
  messages: BaseMessage[]
  /** Summary text (null if no summarization occurred) */
  summary: string | null
  /** Which compression level was applied */
  level: CompressionLevel
  /** Estimated token count after compression */
  estimatedTokens: number
  /** Compression ratio (0-1, higher = more compressed) */
  ratio: number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  keepRecentLevel3: 10,
  keepRecentLevel4: 3,
  aiResponseMaxChars: 500,
  preserveRecentToolResults: 6,
  charsPerToken: 4,
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getContent(m: BaseMessage): string {
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
}

function estimateTokens(messages: BaseMessage[], charsPerToken: number): number {
  let totalChars = 0
  for (const m of messages) {
    totalChars += getContent(m).length
  }
  return Math.ceil(totalChars / charsPerToken)
}

function buildResult(
  messages: BaseMessage[],
  summary: string | null,
  level: CompressionLevel,
  originalTokens: number,
  charsPerToken: number,
): ProgressiveCompressResult {
  const estimatedTokensAfter = estimateTokens(messages, charsPerToken)
  const ratio = originalTokens > 0
    ? 1 - estimatedTokensAfter / originalTokens
    : 0
  return {
    messages,
    summary,
    level,
    estimatedTokens: estimatedTokensAfter,
    ratio: Math.max(0, Math.min(1, ratio)),
  }
}

// ---------------------------------------------------------------------------
// Level implementations
// ---------------------------------------------------------------------------

/** Level 1: prune old tool results + repair orphaned pairs. */
function applyLevel1(
  messages: BaseMessage[],
  cfg: { preserveRecentToolResults: number },
): BaseMessage[] {
  const pruned = pruneToolResults(messages, {
    preserveRecentToolResults: cfg.preserveRecentToolResults,
  })
  return repairOrphanedToolPairs(pruned)
}

/** Level 2: trim verbose AI responses. */
function applyLevel2(
  messages: BaseMessage[],
  maxChars: number,
): BaseMessage[] {
  const keepHead = Math.min(300, Math.floor(maxChars * 0.75))
  const keepTail = Math.min(100, maxChars - keepHead)

  return messages.map(m => {
    if (m._getType() !== 'ai') return m
    const ai = m as AIMessage

    // Don't trim messages that carry tool_calls — the content is often short
    // or structurally important.
    if (Array.isArray(ai.tool_calls) && ai.tool_calls.length > 0) return m

    const content = getContent(ai)
    if (content.length <= maxChars) return m

    const trimmed =
      content.slice(0, keepHead) +
      '\n\n...[trimmed]...\n\n' +
      content.slice(-keepTail)

    const fields: {
      content: string
      additional_kwargs: typeof ai.additional_kwargs
      response_metadata: typeof ai.response_metadata
      tool_calls?: typeof ai.tool_calls
      id?: string
    } = {
      content: trimmed,
      additional_kwargs: ai.additional_kwargs,
      response_metadata: ai.response_metadata,
    }
    if (ai.tool_calls !== undefined) {
      fields.tool_calls = ai.tool_calls
    }
    if (ai.id !== undefined) {
      fields.id = ai.id
    }
    return new AIMessage(fields)
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compress messages to a specific level.
 * Each level includes all processing from lower levels.
 */
export async function compressToLevel(
  messages: BaseMessage[],
  level: CompressionLevel,
  existingSummary: string | null,
  model: BaseChatModel,
  config?: ProgressiveCompressConfig,
): Promise<ProgressiveCompressResult> {
  const cfg = { ...DEFAULTS, ...config }
  const charsPerToken = cfg.charsPerToken
  const originalTokens = estimateTokens(messages, charsPerToken)

  // --- Level 0: no compression ---
  if (level === 0) {
    return buildResult(messages, existingSummary, 0, originalTokens, charsPerToken)
  }

  // --- Level 1: tool result pruning ---
  let result = applyLevel1(messages, cfg)

  if (level === 1) {
    return buildResult(result, existingSummary, 1, originalTokens, charsPerToken)
  }

  // --- Level 2: trim verbose AI responses ---
  result = applyLevel2(result, cfg.aiResponseMaxChars)

  if (level === 2) {
    return buildResult(result, existingSummary, 2, originalTokens, charsPerToken)
  }

  // --- Level 3: structured summarization via summarizeAndTrim ---
  if (level === 3) {
    // Fire the pre-summarize hook (non-fatal)
    if (cfg.onBeforeSummarize && result.length > cfg.keepRecentLevel3) {
      const oldMessages = result.slice(0, result.length - cfg.keepRecentLevel3)
      try {
        await cfg.onBeforeSummarize(oldMessages)
      } catch {
        // Non-fatal: hook failure must not block compression
      }
    }

    try {
      const { summary, trimmedMessages } = await summarizeAndTrim(
        result,
        existingSummary,
        model,
        { keepRecentMessages: cfg.keepRecentLevel3 },
      )
      return buildResult(trimmedMessages, summary, 3, originalTokens, charsPerToken)
    } catch {
      // Fallback: return level-2 result if LLM summarization fails
      return buildResult(result, existingSummary, 2, originalTokens, charsPerToken)
    }
  }

  // --- Level 4: ultra-compressed ---
  // Fire the pre-summarize hook (non-fatal)
  if (cfg.onBeforeSummarize && result.length > cfg.keepRecentLevel4) {
    const oldMessages = result.slice(0, result.length - cfg.keepRecentLevel4)
    try {
      await cfg.onBeforeSummarize(oldMessages)
    } catch {
      // Non-fatal
    }
  }

  // Keep only the last N messages
  const kept = result.slice(-cfg.keepRecentLevel4)
  const repairedKept = repairOrphanedToolPairs(kept)

  // Build ultra-compressed summary from existing summary
  let ultraSummary: string | null = existingSummary
  if (ultraSummary && ultraSummary.length > 500) {
    ultraSummary = ultraSummary.slice(0, 500) + '...[truncated]'
  }

  return buildResult(repairedKept, ultraSummary, 4, originalTokens, charsPerToken)
}

/**
 * Automatically select the appropriate compression level based on
 * estimated token count and budget.
 */
export function selectCompressionLevel(
  messages: BaseMessage[],
  tokenBudget: number,
  charsPerToken: number = DEFAULTS.charsPerToken,
): CompressionLevel {
  const estimated = estimateTokens(messages, charsPerToken)

  if (estimated <= tokenBudget) return 0
  if (estimated * 0.70 <= tokenBudget) return 1
  if (estimated * 0.50 <= tokenBudget) return 2
  if (estimated * 0.30 <= tokenBudget) return 3
  return 4
}

/**
 * Compress messages to fit within a token budget.
 * Automatically selects the minimum compression level needed.
 */
export async function compressToBudget(
  messages: BaseMessage[],
  tokenBudget: number,
  existingSummary: string | null,
  model: BaseChatModel,
  config?: ProgressiveCompressConfig,
): Promise<ProgressiveCompressResult> {
  const charsPerToken = config?.charsPerToken ?? DEFAULTS.charsPerToken
  const level = selectCompressionLevel(messages, tokenBudget, charsPerToken)
  return compressToLevel(messages, level, existingSummary, model, config)
}
