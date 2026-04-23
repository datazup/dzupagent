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
import type { BaseMessage } from '@langchain/core/messages'
import type { TokenUsage } from '@dzupagent/core'
import {
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
   * `exhausted`. Returns `{ compressed: false }` otherwise.
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
      return hooks.maybeCompress(messages, model, existingSummary, autoCompressConfig)
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
