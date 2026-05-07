/**
 * Message-preparation coordinator for {@link DzupAgent}.
 *
 * Bundles every pre-invocation message transform in one module:
 *
 *   - {@link prepareMessages} — resolves instructions, applies the
 *     phase window, loads memory context, and assembles the final
 *     message list. Memory failures are non-fatal (except
 *     {@link ArrowRuntimeNotInjectedError} per ADR-0005) and emit a
 *     structured `agent:context_fallback` event.
 *   - {@link maybeUpdateSummary} — runs the rolling summarizer when
 *     `shouldSummarize` returns true; mutates the agent's conversation
 *     summary via the supplied accessor.
 *   - {@link applyPhaseWindow} — opt-in `PhaseAwareWindowManager`
 *     retention split (no-op when `messagePhase` is unset or the
 *     dynamic import fails).
 *   - {@link describeMemoryProvider} — non-leaking provider label for
 *     telemetry.
 *
 * Extracted from `dzip-agent.ts` (MC-004) so the agent class can stay
 * a thin coordinator.
 */
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Tokenizer } from '@dzupagent/core'
import { shouldSummarize, summarizeAndTrim } from '@dzupagent/context'
import type { DzupAgentConfig } from './agent-types.js'
import { ArrowRuntimeNotInjectedError } from './memory-context-loader.js'
import type { AgentMemoryContextLoader } from './memory-context-loader.js'
import type { AgentInstructionResolver } from './instruction-resolution.js'
import {
  buildPreparedMessages,
  estimateConversationTokensForMessages,
} from './message-utils.js'
import { omitUndefined } from '../utils/exact-optional.js'

/**
 * Mutable conversation-summary accessor. The agent owns the summary
 * state; this module reads / writes via the supplied callbacks so the
 * caller can keep `conversationSummary` private.
 */
export interface ConversationSummaryAccessor {
  get(): string | null
  set(value: string | null): void
}

/**
 * Dependency bundle for {@link prepareMessages}.
 */
export interface PrepareMessagesDeps {
  agentId: string
  config: DzupAgentConfig
  tokenizer: Tokenizer
  instructionResolver: AgentInstructionResolver
  memoryContextLoader: AgentMemoryContextLoader
  summary: ConversationSummaryAccessor
}

/**
 * Resolve instructions, apply the phase window, load memory context,
 * and assemble the final prepared message list.
 */
export async function prepareMessages(
  deps: PrepareMessagesDeps,
  messages: BaseMessage[],
  memoryReadContext?: { runId: string },
): Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }> {
  const { agentId, config, tokenizer, instructionResolver, memoryContextLoader, summary } = deps
  const baseInstructions = await instructionResolver.resolve()
  const windowedMessages = await applyPhaseWindow(config, messages)

  let memoryContext: string | null = null
  let memoryFrame: unknown = undefined
  if (config.memory && config.memoryScope && config.memoryNamespace) {
    try {
      const result = await memoryContextLoader.load(windowedMessages, memoryReadContext)
      memoryContext = result.context
      if (config.arrowMemory || config.memoryProfile) {
        memoryFrame = result.frame ?? null
      }
    } catch (err) {
      // ADR-0005 misconfiguration is fatal — the Arrow runtime injector
      // contract was violated, so re-throw rather than masquerading as a
      // generic memory_load_failure. Operators get the precise error type
      // and message instead of a swallowed fallback.
      if (err instanceof ArrowRuntimeNotInjectedError) {
        throw err
      }
      // Memory failures are non-fatal; emit structured event so operators can
      // distinguish "no memory configured" from "memory unavailable".
      const detail = err instanceof Error ? err.message : String(err)
      const tokensBefore = estimateConversationTokensForMessages(windowedMessages, tokenizer)
      const provider = describeMemoryProvider(config)
      const namespace = config.memoryNamespace ?? 'unknown'
      config.onFallback?.('memory_load_failure', tokensBefore, 0)
      config.onFallbackDetail?.({
        reason: 'memory_load_failure',
        detail,
        namespace,
        provider,
        tokensBefore,
        tokensAfter: 0,
      })
      config.eventBus?.emit({
        type: 'agent:context_fallback',
        agentId,
        reason: 'memory_load_failure',
        before: tokensBefore,
        after: 0,
        provider,
        namespace,
        detail,
      })
    }
  }

  const preparedMessages = buildPreparedMessages({
    baseInstructions,
    memoryContext,
    conversationSummary: summary.get(),
    messages: windowedMessages,
  })

  return { messages: preparedMessages, memoryFrame }
}

/**
 * Apply the optional `PhaseAwareWindowManager` retention split. When
 * `config.messagePhase` is unset or the dynamic import fails, the
 * input is returned unchanged.
 */
export async function applyPhaseWindow(
  config: DzupAgentConfig,
  messages: BaseMessage[],
): Promise<BaseMessage[]> {
  if (!config.messagePhase) {
    return messages
  }

  const targetKeep = config.messageConfig?.keepRecentMessages ?? 10

  try {
    const { PhaseAwareWindowManager } = await import('@dzupagent/context')
    const manager = new PhaseAwareWindowManager()
    const splitIdx = manager.findRetentionSplit(messages, targetKeep)
    if (splitIdx <= 0) {
      return messages
    }
    return messages.slice(splitIdx)
  } catch {
    return messages
  }
}

/**
 * Return a non-leaking provider label for memory telemetry.
 *
 * Uses the memory service's constructor name when available so operators
 * can distinguish between e.g. `MemoryService`, `ScopedMemoryService`, and
 * custom providers without exposing the underlying instance.
 */
export function describeMemoryProvider(config: DzupAgentConfig): string {
  const memory = config.memory
  if (!memory) return 'none'
  const ctor = (memory as { constructor?: { name?: string } }).constructor
  return ctor?.name && ctor.name !== 'Object' ? ctor.name : 'standard'
}

/**
 * Dependency bundle for {@link maybeUpdateSummary}.
 */
export interface MaybeUpdateSummaryDeps {
  agentId: string
  config: DzupAgentConfig
  resolvedModel: BaseChatModel
  tokenizer: Tokenizer
  summary: ConversationSummaryAccessor
}

/**
 * Run the rolling summarizer when the message list crosses the
 * configured threshold. Mutates the conversation summary via the
 * supplied accessor. Failures are non-fatal and emit a structured
 * `agent:context_fallback` event.
 */
export async function maybeUpdateSummary(
  deps: MaybeUpdateSummaryDeps,
  messages: BaseMessage[],
  memoryFrame?: unknown,
): Promise<void> {
  const { agentId, config, resolvedModel, tokenizer, summary } = deps
  if (!shouldSummarize(messages, config.messageConfig)) return

  try {
    const summaryModel = config.registry
      ? config.registry.getModel('chat')
      : resolvedModel

    const { summary: nextSummary } = await summarizeAndTrim(
      messages,
      summary.get(),
      summaryModel,
      omitUndefined({
        ...config.messageConfig,
        ...(memoryFrame ? { memoryFrame } : {}),
        onFallback: config.onFallback
          ? (reason: string, before: number, after: number) => {
              config.onFallback!(reason, before, after)
              config.eventBus?.emit({
                type: 'agent:context_fallback',
                agentId,
                reason,
                before,
                after,
              })
            }
          : config.eventBus
            ? (reason: string, before: number, after: number) => {
                config.eventBus!.emit({
                  type: 'agent:context_fallback',
                  agentId,
                  reason,
                  before,
                  after,
                })
            }
          : undefined,
      }),
    )
    summary.set(nextSummary)
  } catch (err) {
    // Summarization failures are non-fatal; emit event so operators can
    // distinguish absence from failure.
    const detail = err instanceof Error ? err.message : String(err)
    const tokensBefore = estimateConversationTokensForMessages(messages, tokenizer)
    const namespace = config.memoryNamespace ?? 'unknown'
    config.onFallback?.('summary_failure', tokensBefore, tokensBefore)
    config.onFallbackDetail?.({
      reason: 'summary_failure',
      detail,
      namespace,
      provider: 'summary',
      tokensBefore,
      tokensAfter: tokensBefore,
    })
    config.eventBus?.emit({
      type: 'agent:context_fallback',
      agentId,
      reason: 'summary_failure',
      before: tokensBefore,
      after: tokensBefore,
      provider: 'summary',
      namespace,
      detail,
    })
  }
}
