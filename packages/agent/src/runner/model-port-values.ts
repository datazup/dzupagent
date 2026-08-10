import type { AgentUsageRecord } from '@dzupagent/agent-types/run'

import type {
  AgentRunnerModelFailure,
  AgentRunnerModelPort,
  AgentRunnerModelRequest,
  AgentRunnerModelResult,
  AgentRunnerModelUsage,
} from './runner-ports.js'
import { assertDurableJson } from './runner-values.js'

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
  if ((result.additionalItems?.length ?? 0) > 0) {
    throw new AgentRunnerModelInvocationError({
      status: 'failed-before-dispatch',
      code: 'model-multiple-items-not-admitted',
      category: 'invalid-request',
      retryClassification: 'non-retryable',
    })
  }
  assertModelUsage(result.usage)
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

