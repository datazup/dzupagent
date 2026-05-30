import type { BaseMessage } from '@langchain/core/messages'

import {
  defaultMemoryRanker,
  type AgentMemoryContextLoaderConfig,
  type AgentMemoryReadContext,
  type AgentMemoryService,
  type ResolvedArrowMemoryConfig,
} from './memory-context-loader-types.js'
import {
  boundContextToTokenBudget,
  deriveStandardMemoryPromptBounds,
  safeComputeMemoryBudget,
} from './memory-context-loader-budget.js'

export interface StandardMemoryRuntimeOptions {
  config: AgentMemoryContextLoaderConfig
  standardMemoryMaxItems: number
  standardMemoryMaxCharsPerItem: number
}

export async function loadStandardMemoryContext(
  opts: StandardMemoryRuntimeOptions,
  memory: AgentMemoryService,
  namespace: string,
  scope: Record<string, string>,
  messages: BaseMessage[],
  budgetCfg: ResolvedArrowMemoryConfig,
  memoryReadContext?: AgentMemoryReadContext,
): Promise<{ context: string | null }> {
  const records = memoryReadContext
    ? await memory.get(namespace, scope, undefined, memoryReadContext)
    : await memory.get(namespace, scope)
  return formatStandardMemoryContext(opts, memory, records, messages, budgetCfg)
}

export async function loadBoundedStandardMemoryContext(
  opts: StandardMemoryRuntimeOptions,
  memory: AgentMemoryService,
  namespace: string,
  scope: Record<string, string>,
  messages: BaseMessage[],
  arrowCfg: ResolvedArrowMemoryConfig,
  arrowFailureFallbackMaxTokens: number,
  memoryReadContext?: AgentMemoryReadContext,
): Promise<{ context: string | null }> {
  const records = memoryReadContext
    ? await memory.get(namespace, scope, undefined, memoryReadContext)
    : await memory.get(namespace, scope)

  return formatStandardMemoryContext(
    opts,
    memory,
    records,
    messages,
    arrowCfg,
    arrowFailureFallbackMaxTokens,
  )
}

export function formatStandardMemoryContext(
  opts: StandardMemoryRuntimeOptions,
  memory: AgentMemoryService,
  records: Record<string, unknown>[],
  messages: BaseMessage[],
  budgetCfg: ResolvedArrowMemoryConfig,
  maxMemoryBudget?: number,
): { context: string | null } {
  const { config, standardMemoryMaxItems, standardMemoryMaxCharsPerItem } = opts

  if (records.length === 0) {
    return { context: null }
  }

  // Apply ranker before budget truncation so the strongest memories survive.
  const ranker = config.memoryRanker ?? defaultMemoryRanker
  const ranked = ranker(records)

  const memoryBudget = safeComputeMemoryBudget(
    {
      instructions: config.instructions,
      messages,
      arrowCfg: budgetCfg,
      estimateConversationTokens: config.estimateConversationTokens,
    },
    maxMemoryBudget,
  )
  if (memoryBudget === undefined) {
    return { context: memory.formatForPrompt(ranked) || null }
  }
  if (memoryBudget <= 0) {
    return { context: null }
  }

  const bounds = deriveStandardMemoryPromptBounds(
    memoryBudget,
    ranked.length,
    standardMemoryMaxItems,
    standardMemoryMaxCharsPerItem,
  )
  if (!bounds) {
    return { context: null }
  }

  const context = memory.formatForPrompt(ranked, bounds) || null

  return {
    context: boundContextToTokenBudget(context, memoryBudget),
  }
}
