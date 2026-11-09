/**
 * Token lifecycle wiring for the default agent loop.
 *
 * Adapts a {@link TokenLifecycleManager} into a self-contained plugin that
 * can be plugged into the tool loop and agent-level hooks. Pressure
 * transitions drive three actions:
 *
 *   - `warn`      → compression hint (listener callback, no mutation)
 *   - `critical`  → auto-compression is triggered on the supplied messages
 *   - `exhausted` → the loop is instructed to halt via {@link AgentLoopPlugin.shouldHalt}
 *
 * Callers that prefer manual wiring can keep using the lower-level
 * {@link withTokenLifecycle} from `context/token-lifecycle-integration`.
 * This plugin is the "batteries-included" variant wired for the default
 * loop.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  SystemMessage,
  type AIMessage,
  type BaseMessage,
  type ToolMessage,
} from '@langchain/core/messages'
import type { TokenUsage } from '@dzupagent/core/llm'
import {
  formatSummaryContext,
  resolveModelId,
  type TokenLifecycleManager,
  type TokenLifecycleStatus,
} from '@dzupagent/context'
import {
  withTokenLifecycle as buildHooks,
  type TokenLifecycleHooks,
  type TokenLifecyclePhase,
  type TokenPressureListener,
} from './context/token-lifecycle-integration.js'
import type { AutoCompressConfig, CompressResult } from './context/auto-compress.js'

/**
 * Callback invoked when the manager reaches `warn`. Used by callers to
 * inject a soft compression hint (e.g. a system nudge) without forcing a
 * full compression pass.
 */
export type CompressionHintListener = (event: {
  status: TokenLifecycleStatus
  usedTokens: number
  remainingTokens: number
}) => void

/**
 * Options accepted by {@link createTokenLifecyclePlugin}.
 */
export interface TokenLifecyclePluginOptions {
  /** Fired when the manager transitions into `warn`. Optional. */
  onCompressionHint?: CompressionHintListener
  /**
   * Fired when the manager transitions into `critical` or `exhausted`.
   * Receives the same event shape as {@link TokenPressureListener}.
   */
  onPressure?: TokenPressureListener
  /** Auto-compress config forwarded to `maybeCompress`. Optional. */
  autoCompressConfig?: AutoCompressConfig
}

/**
 * Plugin surface consumed by the default agent loop. All methods are
 * safe to call when the underlying manager is missing — in that case
 * the plugin degrades to a no-op.
 */
export interface AgentLoopPlugin {
  /** Record token usage from a single LLM invocation. */
  onUsage: (usage: TokenUsage, phase?: TokenLifecyclePhase) => void
  /** Record an arbitrary phase charge (e.g. tool output ingestion). */
  trackPhase: (phase: string, tokens: number) => void
  /**
   * Run `autoCompress` when the manager's status is `critical` or
   * `exhausted`. Returns `{ compressed: false }` otherwise. A compressed
   * transcript keeps its leading system messages (with the summary merged
   * into the first) and any tool-call exchange still awaiting results.
   */
  maybeCompress: (
    messages: BaseMessage[],
    model: BaseChatModel,
    existingSummary?: string | null,
  ) => Promise<CompressResult>
  /** Whether the loop should stop immediately (status is `exhausted`). */
  shouldHalt: () => boolean
  /** Current status snapshot. `'ok'` when no manager is attached. */
  readonly status: TokenLifecycleStatus
  /**
   * Underlying hooks object. `null` when no manager was attached —
   * callers should guard before using.
   */
  readonly hooks: TokenLifecycleHooks | null
  /** Underlying manager. `null` when no manager was attached. */
  readonly manager: TokenLifecycleManager | null
  /** Reset the manager and internal listener state. */
  reset: () => void
  /** Tear down internal listeners. Safe to call multiple times. */
  cleanup: () => void
}

/** Header written by `formatSummaryContext` (same shape as `buildPreparedMessages`). */
const SUMMARY_PREFIX = '## Prior Conversation Context\n\n'

type TextBlock = { type?: string; text?: unknown; [key: string]: unknown }

/** Text a content block contributes to the joined system text (`''` for non-text blocks). */
function blockText(block: TextBlock): string {
  return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
}

/** The block texts concatenated in order, with no separator (`J`). */
function joinedText(blocks: readonly TextBlock[]): string {
  return blocks.map(blockText).join('')
}

/**
 * Read the summary section previously merged into a system message.
 *
 * Block content uses legacy recognition (MC-04b): the summary is found in the
 * joined block text exactly as the string path finds it, so
 * `readSummary(blocks) === readSummary(joined(blocks))` for every text-only
 * block array.
 */
function readSummary(content: BaseMessage['content']): string | null {
  const text = typeof content === 'string' ? content : joinedText(content as TextBlock[])
  const idx = text.indexOf(SUMMARY_PREFIX)
  return idx < 0 ? null : text.slice(idx + SUMMARY_PREFIX.length)
}

/**
 * Replace (or add) the summary section of a system message's content.
 *
 * The result is the ordered-text-block shape `buildPreparedMessages` produces
 * (MC-04b), and its joined text equals the former string result byte for
 * byte:
 *
 * - string content: with `base` = the content without its summary section,
 *   `trimEnd()`ed — no summary keeps the string `base`; an empty `base` gives
 *   the single block `summaryContext`; otherwise `[base, '\n\n' + summary]`.
 * - block content, legacy recognition on the joined text `J`:
 *   - cut: with `idx = J.indexOf(prefix)`, blocks that end before `idx` are
 *     kept unchanged, the block containing `idx` is truncated to its text
 *     before `idx`, and everything from `idx` on is dropped (`idx < 0` keeps
 *     every block);
 *   - trim: the last remaining text block is `trimEnd()`ed and omitted when
 *     that empties it, repeatedly, as the string path trims `base`;
 *   - every remaining empty text block (leading or interior) is omitted;
 *   - append: the replacement is its own block, `'\n\n' + summary` when a
 *     block remains and `summary` otherwise; an empty summary appends nothing.
 */
function writeSummary(
  content: BaseMessage['content'],
  summaryContext: string,
): BaseMessage['content'] {
  if (typeof content === 'string') {
    const idx = content.indexOf(SUMMARY_PREFIX)
    const base = (idx < 0 ? content : content.slice(0, idx)).trimEnd()
    if (!summaryContext) return base
    if (!base) return [{ type: 'text', text: summaryContext }] as BaseMessage['content']
    return [
      { type: 'text', text: base },
      { type: 'text', text: `\n\n${summaryContext}` },
    ] as BaseMessage['content']
  }

  const source = content as TextBlock[]
  const idx = joinedText(source).indexOf(SUMMARY_PREFIX)

  // Cut at the joined index.
  const kept: TextBlock[] = []
  let offset = 0
  for (const block of source) {
    if (idx < 0) {
      kept.push(block)
      continue
    }
    const length = blockText(block).length
    if (offset >= idx) break
    if (offset + length <= idx) {
      kept.push(block)
    } else {
      kept.push({ ...block, text: blockText(block).slice(0, idx - offset) })
      break
    }
    offset += length
  }

  // Trim, as the string path's `trimEnd()` of `base`.
  while (kept.length > 0) {
    const last = kept[kept.length - 1]!
    if (last.type !== 'text' || typeof last.text !== 'string') break
    const trimmed = last.text.trimEnd()
    if (trimmed.length > 0) {
      if (trimmed !== last.text) kept[kept.length - 1] = { ...last, text: trimmed }
      break
    }
    kept.pop()
  }

  // Omit every empty text block (leading and interior too): providers reject
  // empty text blocks, and dropping `''` leaves the joined text unchanged.
  const nonEmpty = kept.filter(block => !(block.type === 'text' && block.text === ''))

  // Append the replacement as its own block.
  if (summaryContext) {
    nonEmpty.push({ type: 'text', text: nonEmpty.length > 0 ? `\n\n${summaryContext}` : summaryContext })
  }
  return nonEmpty as BaseMessage['content']
}

/**
 * @internal Test seam for the MC-04b text-compatibility oracle. Not part of
 * the package surface (`index.ts` re-exports only named plugin symbols).
 */
export { readSummary as _readSummaryForTest, writeSummary as _writeSummaryForTest }

/**
 * MC-04b item 3: when the caller's config selects no counter (neither
 * `tokenCounter` nor `summaryModelId`, and no `charsPerToken` override), pass
 * the call's model id as `summaryModelId` so `resolveTokenCounter` selects
 * the tokenizer for the compression decision. Explicit settings keep today's
 * behaviour unchanged.
 */
function withDefaultCounterModel(
  config: AutoCompressConfig | undefined,
  model: BaseChatModel,
): AutoCompressConfig | undefined {
  if (
    config?.tokenCounter !== undefined
    || config?.summaryModelId !== undefined
    || config?.charsPerToken !== undefined
  ) {
    return config
  }
  const modelId = resolveModelId(model)
  if (!modelId) return config
  return { ...config, summaryModelId: modelId }
}

/**
 * Index where an unresolved tool-call exchange starts: the last AI message,
 * when it carries tool calls that no later ToolMessage answers yet. Returns
 * `messages.length` when nothing is pending.
 */
function pendingToolCallStart(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!._getType() !== 'ai') continue
    const calls = (messages[i] as AIMessage).tool_calls ?? []
    const answered = new Set(
      messages
        .slice(i + 1)
        .filter(m => m._getType() === 'tool')
        .map(m => (m as ToolMessage).tool_call_id),
    )
    const pending = calls.some(call => !call.id || !answered.has(call.id))
    return pending ? i : messages.length
  }
  return messages.length
}

/**
 * Compress a live agent transcript without breaking its shape (DZC-P1b).
 *
 * Leading system messages (the agent instructions) and a trailing tool-call
 * exchange that is still waiting for its results are kept out of
 * `autoCompress`. The summary is merged into the first system message as a
 * `## Prior Conversation Context` section; a section already there is fed back
 * as the existing summary and replaced, so repeated compressions update it.
 * When nothing is compressed the caller's array is returned unchanged.
 */
async function compressTranscript(
  hooks: TokenLifecycleHooks,
  messages: BaseMessage[],
  model: BaseChatModel,
  existingSummary: string | null,
  autoCompressConfig: AutoCompressConfig | undefined,
): Promise<CompressResult> {
  let headEnd = 0
  while (headEnd < messages.length && messages[headEnd]!._getType() === 'system') {
    headEnd++
  }
  const tailStart = Math.max(headEnd, pendingToolCallStart(messages))
  const head = messages.slice(0, headEnd)
  const body = messages.slice(headEnd, tailStart)
  const tail = messages.slice(tailStart)

  const priorSummary = existingSummary ?? (head[0] ? readSummary(head[0].content) : null)
  const result = await hooks.maybeCompress(body, model, priorSummary, autoCompressConfig)
  if (!result.compressed) return { ...result, messages }

  const summaryContext = formatSummaryContext(result.summary || priorSummary)
  const first = head[0]
  const adoptedHead = first
    ? [
        new SystemMessage({
          content: writeSummary(first.content, summaryContext),
          additional_kwargs: first.additional_kwargs,
          ...(first.name !== undefined ? { name: first.name } : {}),
          ...(first.id !== undefined ? { id: first.id } : {}),
        }),
        ...head.slice(1),
      ]
    : summaryContext
      ? [new SystemMessage(summaryContext)]
      : []
  return { ...result, messages: [...adoptedHead, ...result.messages, ...tail] }
}

/**
 * Build a no-op plugin used when no manager is supplied. Every method is
 * safe to call and returns a benign default.
 */
function createNoopPlugin(): AgentLoopPlugin {
  return {
    onUsage: () => {},
    trackPhase: () => {},
    maybeCompress: async (messages, _model, existingSummary = null) => ({
      messages,
      summary: existingSummary,
      compressed: false,
    }),
    shouldHalt: () => false,
    status: 'ok',
    hooks: null,
    manager: null,
    reset: () => {},
    cleanup: () => {},
  }
}

/**
 * Create a token lifecycle plugin for the default agent loop.
 *
 * When `manager` is undefined the plugin is a no-op, allowing callers to
 * unconditionally wire it up regardless of whether token tracking is
 * configured.
 */
export function createTokenLifecyclePlugin(
  manager: TokenLifecycleManager | undefined,
  options: TokenLifecyclePluginOptions = {},
): AgentLoopPlugin {
  if (!manager) return createNoopPlugin()

  const hooks = buildHooks(manager)
  const { onCompressionHint, onPressure, autoCompressConfig } = options

  const unsubscribe = hooks.onPressure((event) => {
    if (event.status === 'warn' && event.previousStatus !== 'warn') {
      onCompressionHint?.({
        status: event.status,
        usedTokens: event.usedTokens,
        remainingTokens: event.remainingTokens,
      })
    }
    if (event.status === 'critical' || event.status === 'exhausted') {
      onPressure?.(event)
    }
  })

  let disposed = false

  return {
    onUsage(usage, phase) {
      if (disposed) return
      hooks.onUsage(usage, phase)
    },
    trackPhase(phase, tokens) {
      if (disposed) return
      hooks.trackPhase(phase, tokens)
    },
    async maybeCompress(messages, model, existingSummary = null) {
      if (disposed) return { messages, summary: existingSummary, compressed: false }
      const status = hooks.status
      if (status === 'ok' || status === 'warn') {
        return { messages, summary: existingSummary, compressed: false }
      }
      return compressTranscript(
        hooks,
        messages,
        model,
        existingSummary,
        withDefaultCounterModel(autoCompressConfig, model),
      )
    },
    shouldHalt() {
      if (disposed) return false
      return hooks.status === 'exhausted'
    },
    get status() {
      return disposed ? 'ok' : hooks.status
    },
    get hooks() {
      return disposed ? null : hooks
    },
    get manager() {
      return disposed ? null : manager
    },
    reset() {
      if (disposed) return
      manager.reset()
    },
    cleanup() {
      if (disposed) return
      disposed = true
      unsubscribe()
      hooks.cleanup()
    },
  }
}
