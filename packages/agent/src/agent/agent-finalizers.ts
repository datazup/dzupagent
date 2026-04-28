/**
 * Agent post-run finalizer helpers — extracted from DzupAgent.
 *
 * These helpers handle the "after the loop runs" concerns: updating the
 * conversation summary (compression), persisting the final response to
 * memory (write-back). Keeping them out of `dzip-agent.ts` makes the
 * class body focus on orchestration.
 */

import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { shouldSummarize, summarizeAndTrim } from '@dzupagent/context'
import type { DzupAgentConfig } from './agent-types.js'

export interface UpdateSummaryParams {
  agentId: string
  config: DzupAgentConfig
  resolvedModel: BaseChatModel
  conversationSummary: string | null
  messages: BaseMessage[]
  memoryFrame?: unknown
}

/**
 * Maybe update the running conversation summary for the agent.
 *
 * Runs the full compression pipeline (prune + repair + split + summarize)
 * via `summarizeAndTrim` when the input messages exceed the configured
 * threshold. Returns the new summary string (or the previous one if no
 * update was needed). Failures are swallowed — summarization must never
 * abort a run.
 */
export async function maybeUpdateSummary(
  params: UpdateSummaryParams,
): Promise<string | null> {
  const { agentId, config, resolvedModel, conversationSummary, messages, memoryFrame } = params

  if (!shouldSummarize(messages, config.messageConfig)) {
    return conversationSummary
  }

  try {
    // Use a cheaper model for summarization when a registry is configured.
    const summaryModel = config.registry
      ? config.registry.getModel('chat')
      : resolvedModel

    const { summary } = await summarizeAndTrim(
      messages,
      conversationSummary,
      summaryModel,
      {
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
      },
    )
    return summary
  } catch {
    // Summarization failures are non-fatal
    return conversationSummary
  }
}

export interface WriteBackMemoryParams {
  agentId: string
  config: DzupAgentConfig
  content: string
}

/**
 * Persist the agent's final response content to the configured memory
 * store so memory becomes durable across calls without callers having to
 * do it manually.
 *
 * No-op unless `memory`, `memoryNamespace`, `memoryScope` are all set,
 * `memoryWriteBack !== false`, and `content` is non-empty. Failures are
 * swallowed — write-back must never throw.
 */
export async function maybeWriteBackMemory(
  params: WriteBackMemoryParams,
): Promise<void> {
  const { agentId, config, content } = params
  if (
    config.memoryWriteBack === false ||
    !config.memory ||
    !config.memoryNamespace ||
    !config.memoryScope ||
    !content
  ) return
  const now = Date.now()
  const key = now.toString()
  try {
    await config.memory.put(
      config.memoryNamespace,
      config.memoryScope,
      key,
      {
        text: content,
        agentId,
        timestamp: now,
        ...(config.ttlMs !== undefined
          ? { expiresAt: now + config.ttlMs }
          : {}),
      },
    )
    config.eventBus?.emit({
      type: 'memory:written',
      namespace: config.memoryNamespace,
      key,
    })
  } catch {
    config.eventBus?.emit({
      type: 'memory:error',
      namespace: config.memoryNamespace,
      key,
      message: 'Memory write-back failed',
    })
    // write-back failures are non-fatal
  }
}
