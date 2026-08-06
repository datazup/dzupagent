import type { BaseMessage } from '@langchain/core/messages'

import {
  DEFAULT_MEMORY_QUERY_MAX_CHARS,
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
  safeNamespace,
} from './memory-context-loader-budget.js'

export interface StandardMemoryRuntimeOptions {
  config: AgentMemoryContextLoaderConfig
  standardMemoryMaxItems: number
  standardMemoryMaxCharsPerItem: number
}

/**
 * Extract a retrieval query from the windowed conversation (MC-QR).
 *
 * Deterministic by construction: the newest non-empty human message, trimmed
 * and truncated. No LLM call, no rewriting — a query-derivation step that can
 * itself fail or cost money would defeat the point of making retrieval cheap
 * enough to run on every turn.
 *
 * Returns `''` when the window holds no usable user text, which callers treat
 * as "fall back to the namespace read".
 */
export function deriveMemoryQuery(
  messages: BaseMessage[],
  maxChars: number = DEFAULT_MEMORY_QUERY_MAX_CHARS,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message._getType() !== 'human') continue

    const raw =
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content)
    const trimmed = raw.trim()
    if (!trimmed) continue

    return maxChars > 0 && trimmed.length > maxChars
      ? trimmed.slice(0, maxChars)
      : trimmed
  }
  return ''
}

/**
 * Number of records to request from the memory service in `'query'` mode.
 *
 * Derived from the same budget math that later trims the prompt, so retrieval
 * never pays to fetch (and embed-compare) records the budget would discard.
 * The record count is not known before the search runs, so the per-agent item
 * cap stands in as its upper bound.
 */
export function deriveMemoryQueryLimit(
  opts: StandardMemoryRuntimeOptions,
  messages: BaseMessage[],
  budgetCfg: ResolvedArrowMemoryConfig,
  maxMemoryBudget?: number,
): number {
  const { config, standardMemoryMaxItems, standardMemoryMaxCharsPerItem } = opts
  const memoryBudget = safeComputeMemoryBudget(
    {
      instructions: config.instructions,
      messages,
      arrowCfg: budgetCfg,
      estimateConversationTokens: config.estimateConversationTokens,
    },
    maxMemoryBudget,
  )
  if (memoryBudget === undefined) return standardMemoryMaxItems

  const bounds = deriveStandardMemoryPromptBounds(
    memoryBudget,
    standardMemoryMaxItems,
    standardMemoryMaxItems,
    standardMemoryMaxCharsPerItem,
  )
  return bounds?.maxItems ?? standardMemoryMaxItems
}

/**
 * Read the records the standard path will format.
 *
 * In the default `'namespace'` mode this is the historical whole-namespace
 * `get()`, byte-for-byte. In `'query'` mode it is a query-conditioned search
 * — the only route by which a configured semantic/vector store reaches the
 * prompt, since fusion happens inside the memory service's search path.
 *
 * Query mode degrades to the namespace read whenever retrieval cannot be
 * trusted: no derivable query, no search method on the service, a thrown
 * search, or a search that reports `searchFailed`. An empty *result set* is
 * not a failure — it means the namespace holds nothing relevant, and
 * returning the whole namespace instead would silently undo the mode.
 */
async function readStandardMemoryRecords(
  opts: StandardMemoryRuntimeOptions,
  memory: AgentMemoryService,
  namespace: string,
  scope: Record<string, string>,
  messages: BaseMessage[],
  budgetCfg: ResolvedArrowMemoryConfig,
  maxMemoryBudget: number | undefined,
  memoryReadContext: AgentMemoryReadContext | undefined,
): Promise<Record<string, unknown>[]> {
  const queryRecords = await tryQueryConditionedRead(
    opts,
    memory,
    namespace,
    scope,
    messages,
    budgetCfg,
    maxMemoryBudget,
    memoryReadContext,
  )
  if (queryRecords) return queryRecords

  return memoryReadContext
    ? await memory.get(namespace, scope, undefined, memoryReadContext)
    : await memory.get(namespace, scope)
}

/**
 * Attempt the `'query'`-mode read. Returns `undefined` to mean "use the
 * namespace path instead" — distinct from `[]`, which is a successful search
 * that matched nothing.
 */
async function tryQueryConditionedRead(
  opts: StandardMemoryRuntimeOptions,
  memory: AgentMemoryService,
  namespace: string,
  scope: Record<string, string>,
  messages: BaseMessage[],
  budgetCfg: ResolvedArrowMemoryConfig,
  maxMemoryBudget: number | undefined,
  memoryReadContext: AgentMemoryReadContext | undefined,
): Promise<Record<string, unknown>[] | undefined> {
  const { config } = opts
  if (config.memoryContextMode !== 'query') return undefined

  const reportFallback = (reason: string, detail: string): undefined => {
    config.onFallbackDetail?.({
      reason,
      detail,
      namespace: safeNamespace(namespace),
      provider: 'memory-query',
    })
    return undefined
  }

  const query = deriveMemoryQuery(
    messages,
    config.memoryQueryMaxChars ?? DEFAULT_MEMORY_QUERY_MAX_CHARS,
  )
  if (!query) {
    return reportFallback(
      'memory_query_empty',
      'no user message in the window yielded a retrieval query',
    )
  }

  const limit = deriveMemoryQueryLimit(opts, messages, budgetCfg, maxMemoryBudget)

  try {
    // Prefer searchWithStatus: it distinguishes "matched nothing" from "the
    // store was unreachable", and only the latter should fall back. Plain
    // `search` collapses both into `[]`, so an outage would render as an
    // empty memory context rather than the namespace read.
    if (typeof memory.searchWithStatus === 'function') {
      const { results, searchFailed } = await memory.searchWithStatus(
        namespace,
        scope,
        query,
        limit,
        memoryReadContext,
      )
      if (searchFailed) {
        return reportFallback(
          'memory_query_search_failure',
          'memory search reported the store as unreadable',
        )
      }
      return results
    }

    if (typeof memory.search === 'function') {
      // Called as a method, not a detached reference: `MemoryService.search`
      // reads `this` for the namespace map and store handles.
      return await memory.search(namespace, scope, query, limit, memoryReadContext)
    }

    return reportFallback(
      'memory_query_unsupported',
      'memory service exposes no search method',
    )
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return reportFallback('memory_query_search_failure', detail.slice(0, 200))
  }
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
  const records = await readStandardMemoryRecords(
    opts,
    memory,
    namespace,
    scope,
    messages,
    budgetCfg,
    undefined,
    memoryReadContext,
  )
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
  const records = await readStandardMemoryRecords(
    opts,
    memory,
    namespace,
    scope,
    messages,
    arrowCfg,
    arrowFailureFallbackMaxTokens,
    memoryReadContext,
  )

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
