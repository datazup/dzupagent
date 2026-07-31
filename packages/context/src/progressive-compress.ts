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
  type CompressionDegradation,
} from './message-manager.js'
import {
  measureTokenText,
  type TokenCounter,
  type TokenMeasurementResult,
} from './token-lifecycle.js'

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
  /** Optional provenance-aware counter for model-backed measurements. */
  tokenCounter?: TokenCounter
  /** Model identifier forwarded to the token counter. */
  model?: string
  /** Hook called before summarization */
  onBeforeSummarize?: (messages: BaseMessage[]) => Promise<void> | void
}

export interface ProgressiveCompressResult {
  /** Compressed messages */
  messages: BaseMessage[]
  /** Summary text (null if no summarization occurred) */
  summary: string | null
  /** Which compression level was actually applied */
  level: CompressionLevel
  /**
   * Set when a higher level was requested but could not be applied, so
   * `level` reflects a fallback rather than the caller's request.
   *
   * Without this, a summarizer outage that drops level 3 to level 2 is
   * indistinguishable from a caller who asked for level 2 -- and the
   * returned `summary` is then the *stale* existing summary, which a
   * caller persisting it back into session state would store believing
   * compaction had succeeded.
   */
  degradedFrom?: {
    /** The level the caller asked for. */
    requested: CompressionLevel
    /** Why it could not be applied. */
    reason: string
  }
  /** Structured stage failures encountered while producing the fallback. */
  degradations?: CompressionDegradation[]
  /** Estimated token count after compression */
  estimatedTokens: number
  /** Provenance for `estimatedTokens`; heuristic when no detailed counter exists. */
  tokenMeasurement: TokenMeasurementResult
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

const HARD_TRUNCATION_MARKER = '\n\n...[truncated to fit context budget]...'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getContent(m: BaseMessage): string {
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
}

function measureMessages(
  messages: BaseMessage[],
  charsPerToken: number,
  tokenCounter?: TokenCounter,
  model?: string,
): TokenMeasurementResult {
  const text = messages.map(getContent).join('')
  return measureTokenText(text, tokenCounter, model, charsPerToken)
}

function buildResult(
  messages: BaseMessage[],
  summary: string | null,
  level: CompressionLevel,
  originalTokens: number,
  charsPerToken: number,
  tokenCounter?: TokenCounter,
  model?: string,
  degradedFrom?: ProgressiveCompressResult['degradedFrom'],
  degradations?: CompressionDegradation[],
): ProgressiveCompressResult {
  const tokenMeasurement = measureMessages(
    messages,
    charsPerToken,
    tokenCounter,
    model,
  )
  const estimatedTokensAfter = tokenMeasurement.tokens
  const ratio = originalTokens > 0
    ? 1 - estimatedTokensAfter / originalTokens
    : 0
  return {
    messages,
    summary,
    level,
    ...(degradedFrom ? { degradedFrom } : {}),
    ...(degradations && degradations.length > 0 ? { degradations } : {}),
    estimatedTokens: estimatedTokensAfter,
    tokenMeasurement,
    ratio: Math.max(0, Math.min(1, ratio)),
  }
}

function truncateTextToChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  if (maxChars <= HARD_TRUNCATION_MARKER.length) {
    return HARD_TRUNCATION_MARKER.slice(0, maxChars)
  }
  return text.slice(0, maxChars - HARD_TRUNCATION_MARKER.length) + HARD_TRUNCATION_MARKER
}

function cloneWithContent(message: BaseMessage, content: string): BaseMessage {
  const cloned = Object.create(Object.getPrototypeOf(message) as object) as BaseMessage
  Object.assign(cloned, message)
  cloned.content = content
  cloned.additional_kwargs = { ...message.additional_kwargs }
  cloned.response_metadata = { ...message.response_metadata }
  return cloned
}

function hardTrimToBudget(
  messages: BaseMessage[],
  tokenBudget: number,
  charsPerToken: number,
  tokenCounter?: TokenCounter,
  model?: string,
): BaseMessage[] {
  if (tokenBudget <= 0) return []

  let result = [...messages]
  while (
    result.length > 0 &&
    measureMessages(result, charsPerToken, tokenCounter, model).tokens > tokenBudget
  ) {
    if (result.length === 1) {
      const only = result[0]
      if (!only) return []
      const original = getContent(only)
      let low = 0
      let high = original.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        const candidate = truncateTextToChars(original, mid)
        const measured = measureTokenText(
          candidate,
          tokenCounter,
          model,
          charsPerToken,
        ).tokens
        if (measured <= tokenBudget) low = mid
        else high = mid - 1
      }
      const content = truncateTextToChars(original, low)
      return content.length > 0 ? [cloneWithContent(only, content)] : []
    }

    result = repairOrphanedToolPairs(result.slice(1))
  }

  return result
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
  const originalTokens = measureMessages(
    messages,
    charsPerToken,
    cfg.tokenCounter,
    cfg.model,
  ).tokens

  // --- Level 0: no compression ---
  if (level === 0) {
    return buildResult(messages, existingSummary, 0, originalTokens, charsPerToken, cfg.tokenCounter, cfg.model)
  }

  // --- Level 1: tool result pruning ---
  let result = applyLevel1(messages, cfg)

  if (level === 1) {
    return buildResult(result, existingSummary, 1, originalTokens, charsPerToken, cfg.tokenCounter, cfg.model)
  }

  // --- Level 2: trim verbose AI responses ---
  result = applyLevel2(result, cfg.aiResponseMaxChars)

  if (level === 2) {
    return buildResult(result, existingSummary, 2, originalTokens, charsPerToken, cfg.tokenCounter, cfg.model)
  }

  // --- Level 3: structured summarization via summarizeAndTrim ---
  if (level === 3) {
    try {
      const {
        summary,
        trimmedMessages,
        degradation,
      } = await summarizeAndTrim(
        result,
        existingSummary,
        model,
        {
          keepRecentMessages: cfg.keepRecentLevel3,
          ...(cfg.onBeforeSummarize
            ? { onBeforeSummarize: cfg.onBeforeSummarize }
            : {}),
        },
      )
      if (degradation?.adoptionSafe === false) {
        return buildResult(
          result,
          existingSummary,
          2,
          originalTokens,
          charsPerToken,
          cfg.tokenCounter,
          cfg.model,
          {
            requested: 3,
            reason: degradation.reason,
          },
          [degradation],
        )
      }
      return buildResult(trimmedMessages, summary, 3, originalTokens, charsPerToken, cfg.tokenCounter, cfg.model)
    } catch (error) {
      // Defensive: summarizeAndTrim swallows model failures internally (it
      // reports them via the returned `summarizeFailed`), so reaching here
      // means something outside the model call threw.
      const reason = error instanceof Error ? error.message : String(error)
      return buildResult(
        result,
        existingSummary,
        2,
        originalTokens,
        charsPerToken,
        cfg.tokenCounter,
        cfg.model,
        { requested: 3, reason },
        [{ stage: 'summary-invocation', reason, adoptionSafe: false }],
      )
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

  return buildResult(repairedKept, ultraSummary, 4, originalTokens, charsPerToken, cfg.tokenCounter, cfg.model)
}

/**
 * Automatically select the appropriate compression level based on
 * estimated token count and budget.
 */
export function selectCompressionLevel(
  messages: BaseMessage[],
  tokenBudget: number,
  charsPerToken: number = DEFAULTS.charsPerToken,
  tokenCounter?: TokenCounter,
  model?: string,
): CompressionLevel {
  const estimated = measureMessages(messages, charsPerToken, tokenCounter, model).tokens

  if (estimated <= tokenBudget) return 0
  if (estimated * 0.70 <= tokenBudget) return 1
  if (estimated * 0.50 <= tokenBudget) return 2
  if (estimated * 0.30 <= tokenBudget) return 3
  return 4
}

/**
 * Compress messages toward a token budget and select the minimum level needed.
 * `tokenMeasurement` identifies whether the final fit is tokenizer-backed or
 * remains a visible chars-per-token estimate.
 */
export async function compressToBudget(
  messages: BaseMessage[],
  tokenBudget: number,
  existingSummary: string | null,
  model: BaseChatModel,
  config?: ProgressiveCompressConfig,
): Promise<ProgressiveCompressResult> {
  const charsPerToken = config?.charsPerToken ?? DEFAULTS.charsPerToken
  const originalTokens = measureMessages(
    messages,
    charsPerToken,
    config?.tokenCounter,
    config?.model,
  ).tokens
  if (tokenBudget <= 0) {
    return buildResult([], existingSummary, 4, originalTokens, charsPerToken, config?.tokenCounter, config?.model)
  }

  const level = selectCompressionLevel(
    messages,
    tokenBudget,
    charsPerToken,
    config?.tokenCounter,
    config?.model,
  )
  let result = await compressToLevel(messages, level, existingSummary, model, config)
  if (result.estimatedTokens <= tokenBudget) return result

  for (let nextLevel = level + 1; nextLevel <= 4; nextLevel++) {
    result = await compressToLevel(
      messages,
      nextLevel as CompressionLevel,
      existingSummary,
      model,
      config,
    )
    if (result.estimatedTokens <= tokenBudget) return result
  }

  const messagesWithinBudget = hardTrimToBudget(
    result.messages,
    tokenBudget,
    charsPerToken,
    config?.tokenCounter,
    config?.model,
  )
  return buildResult(
    messagesWithinBudget,
    result.summary,
    4,
    originalTokens,
    charsPerToken,
    config?.tokenCounter,
    config?.model,
  )
}
