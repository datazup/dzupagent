/**
 * Coordinator entry-point for the agent's memory context loader.
 *
 * This module is intentionally thin: implementation lives in focused
 * sibling modules under `agent/memory-context-loader-*.ts`. The split
 * (MC-039) was driven by the file growing past 600 LOC while mixing
 * Arrow IPC, decay/budget math, and standard fallback formatting.
 *
 * Public surface (re-exported below) is unchanged so existing callers
 * and tests continue to import from `./memory-context-loader.js`.
 */

import type { BaseMessage } from '@langchain/core/messages'

import { resolveArrowMemoryConfig } from './memory-profiles.js'
import {
  ArrowRuntimeNotInjectedError,
  DEFAULT_ARROW_FAILURE_FALLBACK_MAX_TOKENS,
  DEFAULT_STANDARD_MEMORY_BUDGET_CONFIG,
  DEFAULT_STANDARD_MEMORY_MAX_CHARS_PER_ITEM,
  DEFAULT_STANDARD_MEMORY_MAX_ITEMS,
  type AgentMemoryContextLoaderConfig,
  type AgentMemoryReadContext,
  type ArrowMemoryRuntime,
  type StandardMemoryBudgetConfig,
} from './memory-context-loader-types.js'
import { defaultLoadArrowRuntime } from './memory-context-loader-runtime.js'
import { safeEstimateInputTokens, safeNamespace } from './memory-context-loader-budget.js'
import { loadArrowMemoryContext } from './memory-context-loader-arrow.js'
import {
  loadBoundedStandardMemoryContext,
  loadStandardMemoryContext,
  type StandardMemoryRuntimeOptions,
} from './memory-context-loader-standard.js'

// Re-export the public surface so existing imports keep working.
export {
  ArrowRuntimeNotInjectedError,
  type AgentMemoryContextLoaderConfig,
  type AgentMemoryContextLoaderLimits,
  type AgentMemoryReadContext,
  type ArrowMemoryRuntime,
} from './memory-context-loader-types.js'

export class AgentMemoryContextLoader {
  private readonly loadArrowRuntime: () => Promise<ArrowMemoryRuntime>
  private readonly arrowFailureFallbackMaxTokens: number
  private readonly standardMemoryMaxItems: number
  private readonly standardMemoryMaxCharsPerItem: number
  private readonly standardMemoryBudgetConfig: StandardMemoryBudgetConfig

  constructor(private readonly config: AgentMemoryContextLoaderConfig) {
    this.loadArrowRuntime = config.loadArrowRuntime ?? defaultLoadArrowRuntime

    const limits = config.limits ?? {}
    this.arrowFailureFallbackMaxTokens =
      limits.arrowFallbackMaxTokens ?? DEFAULT_ARROW_FAILURE_FALLBACK_MAX_TOKENS
    this.standardMemoryMaxItems =
      limits.standardMaxItems ?? DEFAULT_STANDARD_MEMORY_MAX_ITEMS
    this.standardMemoryMaxCharsPerItem =
      limits.standardMaxCharsPerItem ?? DEFAULT_STANDARD_MEMORY_MAX_CHARS_PER_ITEM
    this.standardMemoryBudgetConfig = {
      totalBudget:
        limits.standardTotalBudget ??
        DEFAULT_STANDARD_MEMORY_BUDGET_CONFIG.totalBudget,
      maxMemoryFraction:
        limits.standardMaxMemoryFraction ??
        DEFAULT_STANDARD_MEMORY_BUDGET_CONFIG.maxMemoryFraction,
      minResponseReserve:
        limits.standardMinResponseReserve ??
        DEFAULT_STANDARD_MEMORY_BUDGET_CONFIG.minResponseReserve,
    }
  }

  async load(
    messages: BaseMessage[],
    memoryReadContext: AgentMemoryReadContext | undefined = this.config.memoryReadContext,
  ): Promise<{ context: string | null; frame?: unknown }> {
    const memory = this.config.memory
    const scope = this.config.memoryScope
    const namespace = this.config.memoryNamespace

    if (!memory || !scope || !namespace) {
      return { context: null }
    }

    // Frozen snapshot optimization: skip reload when cache prefix is stable.
    // Returns the cached context immediately, preserving Anthropic prompt-cache
    // prefix hits across agent iterations.
    if (this.config.frozenSnapshot?.isActive()) {
      return { context: this.config.frozenSnapshot.get() }
    }

    const resolvedArrowConfig = resolveArrowMemoryConfig(
      this.config.arrowMemory,
      this.config.memoryProfile,
    )

    const standardOpts: StandardMemoryRuntimeOptions = {
      config: this.config,
      standardMemoryMaxItems: this.standardMemoryMaxItems,
      standardMemoryMaxCharsPerItem: this.standardMemoryMaxCharsPerItem,
    }

    if (resolvedArrowConfig) {
      try {
        const result = await loadArrowMemoryContext(
          { config: this.config, loadArrowRuntime: this.loadArrowRuntime },
          memory,
          namespace,
          scope,
          messages,
          resolvedArrowConfig,
        )
        // Freeze snapshot after a successful Arrow load so subsequent calls
        // can short-circuit to the cached context.
        if (result.context !== null) {
          this.config.frozenSnapshot?.freeze(result.context, result.frame)
        }
        return result
      } catch (err) {
        // Misconfiguration (no injector) is a contract violation — surface it
        // to the caller so the agent can fail loudly rather than silently
        // degrading to the standard path. ADR-0005 explicitly requires the
        // injector once the enforcement flag is set.
        if (err instanceof ArrowRuntimeNotInjectedError) {
          throw err
        }
        // Fall back to the standard path if Arrow selection fails.
        // Emit structured reason so operators can distinguish absence from outage.
        // Tokens before = estimated conversation+system before fallback;
        // tokensAfter is unknown until the standard path runs, so emit 0
        // as a non-leaking placeholder.
        const reason = err instanceof Error ? err.message : String(err)
        const tokensBefore = safeEstimateInputTokens(
          this.config.instructions,
          messages,
          this.config.estimateConversationTokens,
        )
        this.config.onFallback?.('arrow_fallback', tokensBefore, 0)
        this.config.onFallbackDetail?.({
          reason: 'arrow_runtime_failure',
          detail: reason,
          namespace: safeNamespace(namespace),
          provider: 'arrow',
          tokensBefore,
          tokensAfter: 0,
        })
        return await loadBoundedStandardMemoryContext(
          standardOpts,
          memory,
          namespace,
          scope,
          messages,
          resolvedArrowConfig,
          this.arrowFailureFallbackMaxTokens,
          memoryReadContext,
        )
      }
    }

    return await loadStandardMemoryContext(
      standardOpts,
      memory,
      namespace,
      scope,
      messages,
      this.standardMemoryBudgetConfig,
      memoryReadContext,
    )
  }
}
