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

interface StandardMemoryRecords {
  records: Record<string, unknown>[]
  queryRanked: boolean
}

type SearchCapableMemoryService = AgentMemoryService & {
  search?: (
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit?: number,
    memoryReadContext?: AgentMemoryReadContext,
  ) => Promise<Record<string, unknown>[]>
}

export function deriveStandardMemorySearchQuery(messages: BaseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?._getType() !== 'human') continue
    const content = stringifyMessageContent(message.content)
    const query = content.trim()
    if (query.length > 0) return query
  }
  return null
}

function stringifyMessageContent(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .filter((part) => part.length > 0)
    .join('\n')
}

async function loadStandardMemoryRecords(
  opts: StandardMemoryRuntimeOptions,
  memory: AgentMemoryService,
  namespace: string,
  scope: Record<string, string>,
  messages: BaseMessage[],
  memoryReadContext?: AgentMemoryReadContext,
): Promise<StandardMemoryRecords> {
  const query = deriveStandardMemorySearchQuery(messages)
  const searchableMemory = memory as SearchCapableMemoryService
  if (query && typeof searchableMemory.search === 'function') {
    try {
      return {
        records: await searchableMemory.search(
          namespace,
          scope,
          query,
          opts.standardMemoryMaxItems,
          memoryReadContext,
        ),
        queryRanked: true,
      }
    } catch (err) {
      // Preserve legacy non-fatal behavior by falling back to broad scoped
      // recall when a search-capable memory service rejects.
      const message = err instanceof Error ? err.message : String(err)
      console.warn(
        `[memory-context-loader] searchableMemory.search() failed: ${message}. Falling back to memory.get().`,
      )
    }
  }

  const records = memoryReadContext
    ? await memory.get(namespace, scope, undefined, memoryReadContext)
    : await memory.get(namespace, scope)
  return { records, queryRanked: false }
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
  const { records, queryRanked } = await loadStandardMemoryRecords(
    opts,
    memory,
    namespace,
    scope,
    messages,
    memoryReadContext,
  )
  return formatStandardMemoryContext(opts, memory, records, messages, budgetCfg, undefined, {
    queryRanked,
  })
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
  const { records, queryRanked } = await loadStandardMemoryRecords(
    opts,
    memory,
    namespace,
    scope,
    messages,
    memoryReadContext,
  )

  return formatStandardMemoryContext(
    opts,
    memory,
    records,
    messages,
    arrowCfg,
    arrowFailureFallbackMaxTokens,
    { queryRanked },
  )
}

export function formatStandardMemoryContext(
  opts: StandardMemoryRuntimeOptions,
  memory: AgentMemoryService,
  records: Record<string, unknown>[],
  messages: BaseMessage[],
  budgetCfg: ResolvedArrowMemoryConfig,
  maxMemoryBudget?: number,
  recordOptions: { queryRanked?: boolean } = {},
): { context: string | null } {
  const { config, standardMemoryMaxItems, standardMemoryMaxCharsPerItem } = opts

  if (records.length === 0) {
    return { context: null }
  }

  // Apply ranker before budget truncation so the strongest memories survive.
  const ranker = config.memoryRanker ?? (recordOptions.queryRanked ? (items) => items : defaultMemoryRanker)
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
