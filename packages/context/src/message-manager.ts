/**
 * Conversation history manager for LangGraph agents.
 *
 * Prevents unbounded token growth via a multi-phase compression pipeline:
 * 1. Tool result pruning — replace stale tool outputs with placeholders
 * 2. Orphaned pair repair — fix unpaired tool_call / tool_result messages
 * 3. Structured summarization — condense old messages with a goal-oriented template
 * 4. Iterative update — extend existing summaries rather than starting fresh
 *
 * Generic — accepts the summarization model as a parameter rather than
 * importing a concrete model factory.
 */
import {
  HumanMessage,
  SystemMessage,
  type AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { TokenCounter } from './token-lifecycle.js'
import { CharEstimateCounter } from './char-estimate-counter.js'

export interface MessageManagerConfig {
  /** Maximum message count before triggering summarization (default 30) */
  maxMessages?: number
  /** Number of recent messages to keep verbatim after summarization (default 10) */
  keepRecentMessages?: number
  /** Maximum estimated token budget for the messages array (default 12 000) */
  maxMessageTokens?: number
  /**
   * Rough characters-per-token for budget estimation (default 4).
   * Only consulted when `tokenCounter` is not provided.
   */
  charsPerToken?: number
  /**
   * Pluggable token counter. Defaults to {@link CharEstimateCounter}
   * (chars/4 heuristic). Swap in {@link TiktokenCounter} for precise
   * OpenAI-compatible counts.
   */
  tokenCounter?: TokenCounter
  /** Number of recent messages whose tool results are preserved (default 6) */
  preserveRecentToolResults?: number
  /** Max chars for a pruned tool result placeholder (default 120) */
  prunedToolResultMaxChars?: number
  /**
   * Telemetry callback invoked when summarizeAndTrim falls back or truncates.
   * Receives a reason identifier plus before/after token counts.
   */
  onFallback?: (reason: string, before: number, after: number) => void
  /**
   * Optional Arrow memory frame (opaque to this module).
   *
   * Passed through by callers (e.g. DzupAgent) so downstream compression
   * paths like `autoCompress` can consume it without requiring a separate
   * config surface. `summarizeAndTrim` itself ignores this field.
   */
  memoryFrame?: unknown
  /**
   * Structurally-typed event bus handle used to surface non-fatal
   * compression failures. Emits `context:compress_failed` when
   * summarization throws.
   */
  eventBus?: {
    emit(event: { type: string } & Record<string, unknown>): void
  }
}

const DEFAULTS: Omit<Required<MessageManagerConfig>, 'onFallback' | 'memoryFrame' | 'eventBus' | 'tokenCounter'> = {
  maxMessages: 30,
  keepRecentMessages: 10,
  maxMessageTokens: 12_000,
  charsPerToken: 4,
  preserveRecentToolResults: 6,
  prunedToolResultMaxChars: 120,
}

/** Shared default. Constructed once so callers that don't inject a counter
 *  do not pay a per-call allocation cost. */
const DEFAULT_TOKEN_COUNTER: TokenCounter = new CharEstimateCounter()

/**
 * Resolve the effective token counter from a user-supplied config, with a
 * single fallback to the shared default. When the caller leaves
 * `tokenCounter` unset but overrides `charsPerToken`, the default counter
 * is still used and the per-call estimator falls through to the `/
 * charsPerToken` path so the historical behaviour is preserved.
 */
function resolveTokenCounter(config?: MessageManagerConfig): TokenCounter {
  return config?.tokenCounter ?? DEFAULT_TOKEN_COUNTER
}

// ---------- Structured summary template --------------------------------------

const STRUCTURED_SUMMARY_SYSTEM = `You are a conversation summarizer for an AI coding agent.
Produce a structured summary using EXACTLY this template. Be factual, specific, and preserve file paths, error messages, and technical details.

## Goal
<What the user wants to achieve — one sentence>

## Constraints
<Technical constraints, stack requirements, user preferences — bullet list>

## Progress
### Done
<Completed steps — bullet list with file paths where relevant>
### In Progress
<Current work — bullet list>
### Blocked
<Blockers or failed attempts — bullet list, or "None">

## Key Decisions
<Architectural or design decisions made — bullet list>

## Relevant Files
<File paths that were created, modified, or referenced — bullet list>

## Next Steps
<What should happen next — bullet list>`

// ---------- Helpers ----------------------------------------------------------

function getMessageContent(m: BaseMessage): string {
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
}

/**
 * Local token-estimate helper. When the caller has wired a
 * {@link TokenCounter} into `MessageManagerConfig.tokenCounter`, this
 * delegates to it (passing `model` when available). Otherwise it falls back
 * to the legacy `length / charsPerToken` shape so tests and callers that
 * tune only `charsPerToken` keep working unchanged.
 */
function estimateTokens(
  text: string,
  charsPerToken: number,
  counter?: TokenCounter,
  model?: string,
): number {
  if (counter && counter !== DEFAULT_TOKEN_COUNTER) {
    return counter.count(text, model)
  }
  return Math.ceil(text.length / charsPerToken)
}

/**
 * Check if a message is a ToolMessage (tool result).
 */
function isToolMessage(m: BaseMessage): m is ToolMessage {
  return m._getType() === 'tool'
}

/**
 * Check if an AIMessage has tool_calls.
 */
function hasToolCalls(m: BaseMessage): boolean {
  if (m._getType() !== 'ai') return false
  const ai = m as AIMessage
  return Array.isArray(ai.tool_calls) && ai.tool_calls.length > 0
}

// ---------- Phase 1: Tool result pruning ------------------------------------

/**
 * Replace old tool result content with a short placeholder, preserving
 * only the most recent tool results intact. This is a cheap preprocessing
 * pass that doesn't require an LLM call.
 */
export function pruneToolResults(
  messages: BaseMessage[],
  config?: MessageManagerConfig,
): BaseMessage[] {
  const cfg = { ...DEFAULTS, ...config }
  const preserveRecent = cfg.preserveRecentToolResults
  const maxChars = cfg.prunedToolResultMaxChars

  // Find indices of all tool messages
  const toolIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg && isToolMessage(msg)) {
      toolIndices.push(i)
    }
  }

  // Preserve the last N tool results
  const indicesToPrune = new Set(
    toolIndices.slice(0, Math.max(0, toolIndices.length - preserveRecent)),
  )

  if (indicesToPrune.size === 0) return messages

  return messages.map((m, i) => {
    if (!indicesToPrune.has(i) || !isToolMessage(m)) return m

    const content = getMessageContent(m)
    const preview = content.length > maxChars
      ? content.slice(0, maxChars) + '...[pruned]'
      : content

    const fields: { content: string; tool_call_id: string; name?: string } = {
      content: `[Tool result pruned] ${preview}`,
      tool_call_id: m.tool_call_id,
    }
    if (m.name !== undefined) {
      fields.name = m.name
    }
    return new ToolMessage(fields)
  })
}

// ---------- Phase 2: Orphaned pair repair -----------------------------------

/**
 * Fix orphaned tool_call / tool_result pairs that would break API calls.
 *
 * - Removes ToolMessages whose tool_call_id has no matching AIMessage with
 *   that tool call.
 * - For AIMessages with tool_calls that have no matching ToolMessage response,
 *   inserts a stub ToolMessage.
 */
export function repairOrphanedToolPairs(messages: BaseMessage[]): BaseMessage[] {
  // Collect all tool_call IDs from AIMessages
  const emittedCallIds = new Set<string>()
  for (const m of messages) {
    if (m._getType() === 'ai') {
      const ai = m as AIMessage
      if (Array.isArray(ai.tool_calls)) {
        for (const tc of ai.tool_calls) {
          if (tc.id) emittedCallIds.add(tc.id)
        }
      }
    }
  }

  // Collect all tool_call IDs that have ToolMessage responses
  const answeredCallIds = new Set<string>()
  for (const m of messages) {
    if (isToolMessage(m) && m.tool_call_id) {
      answeredCallIds.add(m.tool_call_id)
    }
  }

  const result: BaseMessage[] = []

  for (const m of messages) {
    // Remove ToolMessages with no matching AIMessage tool call
    if (isToolMessage(m) && m.tool_call_id && !emittedCallIds.has(m.tool_call_id)) {
      continue
    }

    result.push(m)

    // After an AIMessage with tool_calls, insert stubs for unanswered calls
    if (m._getType() === 'ai') {
      const ai = m as AIMessage
      if (Array.isArray(ai.tool_calls)) {
        for (const tc of ai.tool_calls) {
          if (tc.id && !answeredCallIds.has(tc.id)) {
            result.push(
              new ToolMessage({
                content: '[Result unavailable — tool call from pruned context]',
                tool_call_id: tc.id,
                name: tc.name ?? 'unknown',
              }),
            )
            answeredCallIds.add(tc.id) // prevent duplicate stubs
          }
        }
      }
    }
  }

  return result
}

// ---------- Phase 3: Boundary alignment -------------------------------------

/**
 * Find a safe split point that doesn't break tool call/result groups.
 * Walks backward from the target index to include the full assistant+results
 * sequence in the "keep" section.
 */
function alignSplitBoundary(
  messages: BaseMessage[],
  targetSplit: number,
): number {
  let split = targetSplit

  // Walk backward past consecutive tool messages to keep them with their AIMessage
  while (split > 0) {
    const msg = messages[split]
    if (!msg || !isToolMessage(msg)) break
    split--
  }
  // Also include the AIMessage that has tool_calls
  const prev = split > 0 ? messages[split - 1] : undefined
  if (prev && hasToolCalls(prev)) {
    split--
  }

  return Math.max(0, split)
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

  // When an explicit tokenCounter is wired, use it (accurate per-message
  // count); otherwise sum chars and divide (legacy behaviour).
  const counter = resolveTokenCounter(config)
  if (config?.tokenCounter && counter !== DEFAULT_TOKEN_COUNTER) {
    const totalTokens = messages.reduce(
      (sum, m) => sum + counter.count(getMessageContent(m)),
      0,
    )
    return totalTokens > cfg.maxMessageTokens
  }

  const totalChars = messages.reduce((sum, m) => {
    return sum + getMessageContent(m).length
  }, 0)

  return Math.ceil(totalChars / cfg.charsPerToken) > cfg.maxMessageTokens
}

/**
 * Multi-phase conversation compression.
 *
 * 1. Prune old tool results (cheap, no LLM)
 * 2. Repair orphaned tool pairs
 * 3. Split at a safe boundary
 * 4. Summarize old messages with structured template
 * 5. Return summary + trimmed recent messages
 *
 * If there is an existing summary, it is updated (not replaced) to
 * preserve accumulated context.
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

  // Phase 1: Prune old tool results
  const pruned = pruneToolResults(messages, cfg)

  // Phase 2: Find safe split boundary
  const rawSplit = pruned.length - keep
  const splitIdx = alignSplitBoundary(pruned, rawSplit)

  const oldMessages = pruned.slice(0, splitIdx)
  const recentMessages = pruned.slice(splitIdx)

  if (oldMessages.length === 0) {
    return { summary: existingSummary ?? '', trimmedMessages: recentMessages }
  }

  // Phase 3: Repair orphaned pairs in the recent section
  const repairedRecent = repairOrphanedToolPairs(recentMessages)

  // Phase 4: Structured summarization
  const formattedOld = oldMessages
    .map(m => {
      const role = m._getType()
      const content = getMessageContent(m)
      return `[${role}]: ${content.slice(0, 500)}`
    })
    .join('\n')

  // Scale summary budget: ~20% of the old content's token estimate
  const oldTokens = estimateTokens(
    formattedOld,
    cfg.charsPerToken,
    resolveTokenCounter(config),
  )
  const summaryBudget = Math.min(Math.max(Math.round(oldTokens * 0.2), 200), 2000)

  const userPrompt = existingSummary
    ? `Existing summary to UPDATE (incorporate new information, don't repeat unchanged items):\n${existingSummary}\n\nNew messages to incorporate:\n${formattedOld}\n\nKeep the summary under ${summaryBudget} tokens.`
    : `Conversation to summarize:\n${formattedOld}\n\nKeep the summary under ${summaryBudget} tokens.`

  try {
    const response = await model.invoke([
      new SystemMessage(STRUCTURED_SUMMARY_SYSTEM),
      new HumanMessage(userPrompt),
    ])
    const summary =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)

    return { summary, trimmedMessages: repairedRecent }
  } catch (err) {
    // Compression failures must never abort a run. Surface via the event
    // bus so telemetry/observability picks it up and fall back to trim.
    config?.eventBus?.emit({
      type: 'context:compress_failed',
      error: err instanceof Error ? err.message : String(err),
      phase: 'summarize',
    })
    return { summary: existingSummary ?? '', trimmedMessages: repairedRecent }
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
