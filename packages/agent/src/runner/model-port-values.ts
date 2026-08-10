import type {
  AgentMessageItem,
  AgentToolCallItem,
  AgentUsageRecord,
} from '@dzupagent/agent-types/run'

import type {
  AgentRunnerModelFailure,
  AgentRunnerModelPort,
  AgentRunnerModelRequest,
  AgentRunnerModelResult,
  AgentRunnerModelUsage,
} from './runner-ports.js'
import { assertDurableJson } from './runner-values.js'

const MODEL_ERROR_CATEGORIES = new Set([
  'authentication',
  'authorization',
  'rate-limit',
  'timeout',
  'invalid-request',
  'unavailable',
  'content-filter',
  'cancelled',
  'internal',
  'unknown',
])

const MODEL_RETRY_CLASSIFICATIONS = new Set([
  'retryable',
  'non-retryable',
  'reconciliation-required',
])

/** @internal */
export class AgentRunnerModelInvocationError extends Error {
  readonly failure: AgentRunnerModelFailure

  constructor(failure: AgentRunnerModelFailure) {
    super(`AgentRunner model invocation failed: ${failure.code}`)
    this.name = 'AgentRunnerModelInvocationError'
    this.failure = failure
  }
}

function isSafeTokenCount(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0)
}

function assertModelUsage(usage: AgentRunnerModelUsage | undefined): void {
  if (usage === undefined) return
  if (
    usage.accountingSource.length === 0 ||
    !isSafeTokenCount(usage.inputTokens) ||
    !isSafeTokenCount(usage.outputTokens) ||
    !isSafeTokenCount(usage.totalTokens) ||
    !isSafeTokenCount(usage.cacheReadTokens) ||
    !isSafeTokenCount(usage.cacheWriteTokens) ||
    !isSafeTokenCount(usage.reasoningTokens)
  ) {
    throw new TypeError('AgentRunner model usage must contain finite non-negative integers')
  }
  if (
    usage.totalTokens !== undefined &&
    usage.inputTokens !== undefined &&
    usage.outputTokens !== undefined &&
    usage.totalTokens !== usage.inputTokens + usage.outputTokens
  ) {
    throw new TypeError('AgentRunner model total usage must equal input plus output')
  }
}

function isFailure(value: unknown): value is AgentRunnerModelFailure {
  if (typeof value !== 'object' || value === null || !('status' in value)) return false
  return value.status === 'failed-before-dispatch' || value.status === 'outcome-unknown'
}

function assertFailure(failure: AgentRunnerModelFailure): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(failure.code)) {
    throw new TypeError('AgentRunner model failure code must be normalized')
  }
  if (!MODEL_ERROR_CATEGORIES.has(failure.category)) {
    throw new TypeError('AgentRunner model failure category must be normalized')
  }
  if (!MODEL_RETRY_CLASSIFICATIONS.has(failure.retryClassification)) {
    throw new TypeError('AgentRunner model retry classification must be normalized')
  }
  if (
    failure.status === 'outcome-unknown' &&
    failure.retryClassification !== 'reconciliation-required'
  ) {
    throw new TypeError('AgentRunner unknown model outcome requires reconciliation')
  }
  if (
    failure.status === 'failed-before-dispatch' &&
    failure.retryClassification === 'reconciliation-required'
  ) {
    throw new TypeError('AgentRunner undispatched model failure cannot require reconciliation')
  }
}

function rejectModelResult(code: string): never {
  throw new AgentRunnerModelInvocationError({
    status: 'failed-before-dispatch',
    code,
    category: 'invalid-request',
    retryClassification: 'non-retryable',
  })
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** @internal */
export function agentRunnerModelResultItems(
  result: AgentRunnerModelResult,
): readonly (AgentMessageItem | AgentToolCallItem)[] {
  return [result.item, ...(result.additionalItems ?? [])]
}

function assertModelTurn(
  result: AgentRunnerModelResult,
  request: AgentRunnerModelRequest,
): void {
  if (result.status !== undefined && result.status !== 'completed') {
    rejectModelResult('model-invalid-result-status')
  }
  if (result.item === undefined ||
    (result.additionalItems !== undefined && !Array.isArray(result.additionalItems))) {
    rejectModelResult('model-empty-turn')
  }

  const items = agentRunnerModelResultItems(result)
  if (items.length === 0) rejectModelResult('model-empty-turn')

  const existingItemIds = new Set(
    [...request.input, ...request.committedItems].map((item) => item.itemId),
  )
  const existingCallIds = new Set(
    [...request.input, ...request.committedItems]
      .filter((item): item is AgentToolCallItem => item.type === 'tool-call')
      .map((item) => item.callId),
  )
  const itemIds = new Set<string>()
  const callIds = new Set<string>()
  const toolDescriptors = new Map(request.tools.map((tool) => [tool.toolId, tool]))
  if (
    toolDescriptors.size !== request.tools.length ||
    request.tools.some(
      (tool) =>
        !isNonEmptyId(tool.toolId) ||
        !isNonEmptyId(tool.toolRevision) ||
        tool.effectClass !== 'read',
    )
  ) {
    rejectModelResult('model-tool-descriptor-mismatch')
  }

  let messageCount = 0
  let toolCallCount = 0
  for (const [index, item] of items.entries()) {
    if (typeof item !== 'object' || item === null || !isNonEmptyId(item.itemId)) {
      rejectModelResult('model-invalid-item-id')
    }
    if (itemIds.has(item.itemId) || existingItemIds.has(item.itemId)) {
      rejectModelResult('model-duplicate-item-id')
    }
    itemIds.add(item.itemId)

    if (item.type === 'message') {
      messageCount += 1
      if (
        item.role !== 'assistant' ||
        !Array.isArray(item.content) ||
        messageCount > 1
      ) {
        rejectModelResult('model-invalid-assistant-message')
      }
      if (index !== 0 || toolCallCount > 0) {
        rejectModelResult('model-invalid-turn-order')
      }
      continue
    }
    if (item.type !== 'tool-call') rejectModelResult('model-unsupported-item')
    toolCallCount += 1
    if (!isNonEmptyId(item.callId) || !isNonEmptyId(item.toolId)) {
      rejectModelResult('model-invalid-call-id')
    }
    if (callIds.has(item.callId) || existingCallIds.has(item.callId)) {
      rejectModelResult('model-duplicate-call-id')
    }
    callIds.add(item.callId)
    if (!toolDescriptors.has(item.toolId)) rejectModelResult('model-unknown-tool')
  }

  if (messageCount === 0 && toolCallCount === 0) rejectModelResult('model-empty-turn')
  if (toolCallCount > 0) {
    if (result.finishReason !== undefined && result.finishReason !== 'tool-calls') {
      rejectModelResult('model-conflicting-finish-reason')
    }
  } else if (
    result.finishReason !== undefined &&
    !['stop', 'length', 'content-filter'].includes(result.finishReason)
  ) {
    rejectModelResult('model-conflicting-finish-reason')
  }
}

/** @internal */
export async function invokeAgentRunnerModel(
  model: AgentRunnerModelPort,
  request: AgentRunnerModelRequest,
): Promise<AgentRunnerModelResult> {
  const result = await model.invoke(request)
  assertDurableJson(result)
  if (isFailure(result)) {
    assertFailure(result)
    throw new AgentRunnerModelInvocationError(result)
  }
  assertModelUsage(result.usage)
  assertModelTurn(result, request)
  return result
}

/** @internal */
export function createAgentRunnerModelUsageRecord(
  usage: AgentRunnerModelUsage,
  usageId: string,
  recordedAt: string,
): AgentUsageRecord {
  return {
    usageId,
    source: 'model',
    accountingSource: usage.accountingSource,
    recordedAt,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  }
}
