/**
 * TokenLifecycleManager integration for agent runs.
 *
 * Closes the loop between passive token tracking and active compression:
 *
 *   - {@link TokenLifecycleManager} counts tokens per phase and classifies
 *     pressure (ok / warn / critical / exhausted) against a budget, but
 *     emits no events on its own.
 *   - {@link autoCompress} can summarize and trim a message array but
 *     needs a trigger.
 *
 * {@link withTokenLifecycle} returns a {@link TokenLifecycleHooks} object
 * that ties these together. The run engine (or any caller holding the
 * hooks) feeds usage into the manager via {@link TokenLifecycleHooks.onUsage}
 * and then asks {@link TokenLifecycleHooks.maybeCompress} to run
 * autoCompress when the manager's status reaches `warn` or above.
 *
 * The hooks are self-contained — no event bus subscription, no global
 * state. The returned {@link TokenLifecycleHooks.cleanup} is safe to
 * call multiple times and tears down any internal listeners.
 *
 * @example
 * ```ts
 * const manager = new TokenLifecycleManager({
 *   budget: createTokenBudget(200_000, 4_096),
 * })
 * const hooks = withTokenLifecycle(manager)
 *
 * // Wire into tool loop:
 * await runToolLoop(model, messages, tools, {
 *   onUsage: hooks.onUsage,
 *   // ...
 * })
 *
 * // Before re-invoking the model:
 * const compressed = await hooks.maybeCompress(messages, model, summary)
 * if (compressed.compressed) {
 *   messages = compressed.messages
 *   summary = compressed.summary
 * }
 *
 * hooks.cleanup()
 * ```
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import type { TokenUsage } from '@dzupagent/core'
import {
  type TokenLifecycleManager,
  type TokenLifecycleStatus,
} from '@dzupagent/context'
import {
  autoCompress,
  type AutoCompressConfig,
  type CompressResult,
} from './auto-compress.js'

/**
 * Phase labels emitted by the integration when tracking usage.
 * Matches the optional `phase` override on {@link TokenLifecycleHooks.onUsage}.
 */
export type TokenLifecyclePhase = 'input' | 'output' | 'tool-output' | string

/**
 * Callback fired when the manager transitions to `warn`, `critical`, or
 * `exhausted`. The `previousStatus` is supplied so subscribers can detect
 * edge transitions (e.g. `ok -> warn`) without reading `.status` twice.
 */
export type TokenPressureListener = (event: {
  status: TokenLifecycleStatus
  previousStatus: TokenLifecycleStatus
  usedTokens: number
  remainingTokens: number
}) => void

/**
 * Hooks returned by {@link withTokenLifecycle}. Each method is bound to
 * the underlying {@link TokenLifecycleManager} and safe to pass as a
 * callback into the tool loop / run engine.
 */
export interface TokenLifecycleHooks {
  /**
   * Tracks a {@link TokenUsage} record against the manager. Input tokens
   * are charged to the `input` phase (or `phaseOverride`) and output
   * tokens to the `output` phase. Called once per LLM invocation.
   */
  onUsage: (usage: TokenUsage, phaseOverride?: TokenLifecyclePhase) => void

  /**
   * Tracks an arbitrary phase + token count. Useful for charging
   * non-LLM events (e.g. tool output ingestion) against the budget.
   */
  trackPhase: (phase: string, tokens: number) => void

  /**
   * Runs {@link autoCompress} when the manager's status is `warn`,
   * `critical`, or `exhausted`. Returns the result of autoCompress
   * (which itself no-ops when thresholds are not met) or a result with
   * `compressed: false` when pressure is `ok`.
   *
   * When compression succeeds, the manager is reset so subsequent
   * tracking reflects the compressed message budget.
   */
  maybeCompress: (
    messages: BaseMessage[],
    model: BaseChatModel,
    existingSummary?: string | null,
    config?: AutoCompressConfig,
  ) => Promise<CompressResult>

  /**
   * Subscribe to pressure transitions. The listener fires whenever the
   * manager's status changes to a higher-pressure state (ok -> warn,
   * warn -> critical, etc.) or back to ok. Returns an unsubscribe fn.
   */
  onPressure: (listener: TokenPressureListener) => () => void

  /** Current status snapshot from the underlying manager. */
  readonly status: TokenLifecycleStatus

  /** Returns the underlying {@link TokenLifecycleManager}. */
  readonly manager: TokenLifecycleManager

  /**
   * Clears all internal subscriptions. Safe to call multiple times.
   * Does NOT reset the underlying manager — callers can keep reading
   * `manager.report` after cleanup.
   */
  cleanup: () => void
}

/** Relative ordering of {@link TokenLifecycleStatus} for transition checks. */
const STATUS_ORDER: Record<TokenLifecycleStatus, number> = {
  ok: 0,
  warn: 1,
  critical: 2,
  exhausted: 3,
}

/**
 * Wire a {@link TokenLifecycleManager} into an agent run.
 *
 * Returns a set of hooks that let the caller plug token tracking into
 * the tool loop and request {@link autoCompress} when the budget is
 * under pressure.
 *
 * The returned {@link TokenLifecycleHooks.cleanup} removes any internal
 * pressure listeners. It does NOT reset the manager — that is the
 * caller's responsibility if desired.
 */
export function withTokenLifecycle(
  manager: TokenLifecycleManager,
): TokenLifecycleHooks {
  const listeners = new Set<TokenPressureListener>()
  let lastStatus: TokenLifecycleStatus = manager.status
  let disposed = false

  function notifyIfTransitioned(): void {
    if (disposed) return
    const current = manager.status
    if (STATUS_ORDER[current] === STATUS_ORDER[lastStatus]) return
    const previous = lastStatus
    lastStatus = current
    if (listeners.size === 0) return
    const event = {
      status: current,
      previousStatus: previous,
      usedTokens: manager.usedTokens,
      remainingTokens: manager.remainingTokens,
    }
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // Listener errors must never propagate to the run loop.
      }
    }
  }

  const onUsage: TokenLifecycleHooks['onUsage'] = (usage, phaseOverride) => {
    if (disposed) return
    if (usage.inputTokens > 0) {
      manager.track(phaseOverride ?? 'input', usage.inputTokens)
    }
    if (usage.outputTokens > 0) {
      manager.track(phaseOverride ?? 'output', usage.outputTokens)
    }
    notifyIfTransitioned()
  }

  const trackPhase: TokenLifecycleHooks['trackPhase'] = (phase, tokens) => {
    if (disposed) return
    if (tokens <= 0) return
    manager.track(phase, tokens)
    notifyIfTransitioned()
  }

  const maybeCompress: TokenLifecycleHooks['maybeCompress'] = async (
    messages,
    model,
    existingSummary = null,
    config,
  ) => {
    const status = manager.status
    if (status === 'ok') {
      return { messages, summary: existingSummary, compressed: false }
    }
    const result = await autoCompress(messages, existingSummary, model, config)
    if (result.compressed) {
      // Reset the manager so subsequent tracking reflects the compressed
      // budget. Without this, `used` would remain pinned above the warn
      // threshold even though the transcript was trimmed.
      manager.reset()
      // Forcibly notify subscribers that we dropped back to ok.
      notifyIfTransitioned()
    }
    return result
  }

  const onPressure: TokenLifecycleHooks['onPressure'] = (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const cleanup: TokenLifecycleHooks['cleanup'] = () => {
    if (disposed) return
    disposed = true
    listeners.clear()
  }

  return {
    onUsage,
    trackPhase,
    maybeCompress,
    onPressure,
    cleanup,
    get status() {
      return manager.status
    },
    get manager() {
      return manager
    },
  }
}
