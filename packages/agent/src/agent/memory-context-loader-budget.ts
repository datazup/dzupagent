import type { BaseMessage } from '@langchain/core/messages'
import { estimateTokens } from '@dzupagent/core/llm'

import {
  FALLBACK_CHARS_PER_TOKEN,
  type ResolvedArrowMemoryConfig,
} from './memory-context-loader-types.js'

export interface ComputedMemoryBudget {
  memoryBudget: number
  totalBudget: number
  maxMemoryFraction: number
  minResponseReserve: number
  systemPromptTokens: number
  conversationTokens: number
}

export interface ComputeMemoryBudgetInput {
  instructions: string
  messages: BaseMessage[]
  arrowCfg: ResolvedArrowMemoryConfig
  estimateConversationTokens: (messages: BaseMessage[]) => number
}

export function computeMemoryBudget(
  input: ComputeMemoryBudgetInput,
): ComputedMemoryBudget {
  const { instructions, messages, arrowCfg, estimateConversationTokens } = input
  const totalBudget = arrowCfg.totalBudget ?? 128_000
  const maxMemoryFraction = arrowCfg.maxMemoryFraction ?? 0.3
  const minResponseReserve = arrowCfg.minResponseReserve ?? 4_000
  const systemPromptTokens = estimateTokens(instructions)
  const conversationTokens = estimateConversationTokens(messages)
  const remaining =
    totalBudget - systemPromptTokens - conversationTokens - minResponseReserve
  const memoryBudget = Math.max(
    0,
    Math.min(
      Math.floor(remaining),
      Math.floor(totalBudget * maxMemoryFraction),
    ),
  )

  return {
    memoryBudget,
    totalBudget,
    maxMemoryFraction,
    minResponseReserve,
    systemPromptTokens,
    conversationTokens,
  }
}

export function safeComputeMemoryBudget(
  input: ComputeMemoryBudgetInput,
  maxMemoryBudget?: number,
): number | undefined {
  try {
    const memoryBudget = computeMemoryBudget(input).memoryBudget
    return maxMemoryBudget === undefined
      ? memoryBudget
      : Math.min(memoryBudget, maxMemoryBudget)
  } catch {
    return undefined
  }
}

/**
 * Estimate the input token cost (system prompt + conversation) without
 * touching memory content. Used purely for telemetry; never leaks
 * scope keys/values or stored records.
 */
export function safeEstimateInputTokens(
  instructions: string,
  messages: BaseMessage[],
  estimateConversationTokens: (messages: BaseMessage[]) => number,
): number {
  try {
    const systemTokens = estimateTokens(instructions)
    const conversationTokens = estimateConversationTokens(messages)
    return systemTokens + conversationTokens
  } catch {
    return 0
  }
}

/**
 * Return a redacted namespace label safe for telemetry. The namespace is
 * a logical bucket name (e.g. 'facts', 'episodic') and never a secret in
 * the framework, but we cap the length defensively in case operators
 * choose unconventional values.
 */
export function safeNamespace(namespace: string | undefined): string {
  if (!namespace) return 'unknown'
  return namespace.length > 64 ? `${namespace.slice(0, 64)}...` : namespace
}

export function deriveStandardMemoryPromptBounds(
  memoryBudget: number,
  recordCount: number,
  standardMemoryMaxItems: number,
  standardMemoryMaxCharsPerItem: number,
): { maxItems: number; maxCharsPerItem: number } | undefined {
  if (memoryBudget <= 0 || recordCount <= 0) {
    return undefined
  }

  const defaultTokensPerItem = Math.ceil(
    standardMemoryMaxCharsPerItem / FALLBACK_CHARS_PER_TOKEN,
  )
  const maxItemsByBudget = Math.max(
    1,
    Math.floor(memoryBudget / defaultTokensPerItem),
  )
  const maxItems = Math.max(
    1,
    Math.min(recordCount, standardMemoryMaxItems, maxItemsByBudget),
  )
  const maxCharsPerItem = Math.max(
    1,
    Math.min(
      standardMemoryMaxCharsPerItem,
      Math.floor((memoryBudget * FALLBACK_CHARS_PER_TOKEN) / maxItems),
    ),
  )

  return { maxItems, maxCharsPerItem }
}

export function boundContextToTokenBudget(
  context: string | null,
  memoryBudget: number,
): string | null {
  if (!context) return null
  if (estimateTokens(context) <= memoryBudget) return context

  let low = 0
  let high = Math.min(context.length, memoryBudget * FALLBACK_CHARS_PER_TOKEN)
  let best = ''

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = context.slice(0, mid)
    if (estimateTokens(candidate) <= memoryBudget) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return best.trimEnd() || null
}
