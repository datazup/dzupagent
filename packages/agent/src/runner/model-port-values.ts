import type {
  AgentStructuredOutputRequest,
  AgentStructuredOutputStrategy,
  AgentMessageItem,
  AgentToolCallItem,
  AgentToolInvocationState,
  AgentUsageRecord,
} from '@dzupagent/agent-types/run'

import type {
  AgentRunnerModelFailure,
  AgentRunnerModelPort,
  AgentRunnerModelRequest,
  AgentRunnerModelResult,
  AgentRunnerModelUsage,
  AgentRunnerReadOnlyToolPort,
  AgentRunnerStructuredOutputFailure,
  AgentRunnerStructuredOutputSelection,
  AgentRunnerStructuredOutputSuccess,
} from './runner-ports.js'
import {
  AGENT_RUNNER_STRUCTURED_OUTPUT_BLOCK_NAMESPACE,
  AGENT_RUNNER_STRUCTURED_OUTPUT_CAPABILITY_SCHEMA,
  AGENT_RUNNER_STRUCTURED_OUTPUT_EVIDENCE_SCHEMA,
} from './runner-ports.js'
import { AGENT_STRUCTURED_OUTPUT_REQUEST_SCHEMA } from '@dzupagent/agent-types/run'
import { assertDurableJson, digestRunnerJson } from './runner-values.js'

const MODEL_ERROR_CATEGORIES = new Set([
  'authentication',
  'authorization',
  'rate-limit',
  'timeout',
  'invalid-request',
  'invalid-response',
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
  return ['failed-before-dispatch', 'failed-after-dispatch', 'outcome-unknown'].includes(
    String(value.status),
  )
}

const STRUCTURED_STRATEGIES = new Set<AgentStructuredOutputStrategy>([
  'native-json-schema',
  'json-text',
])

function structuredSchemaDigest(value: unknown): string {
  return digestRunnerJson(value).slice('sha256:'.length, 'sha256:'.length + 16)
}

function assertUniqueStrategies(
  value: readonly AgentStructuredOutputStrategy[],
  allowEmpty = false,
): void {
  if ((!allowEmpty && value.length === 0) || new Set(value).size !== value.length ||
      value.some((strategy) => !STRUCTURED_STRATEGIES.has(strategy))) {
    throw new TypeError('AgentRunner structured-output strategies are invalid')
  }
}

export function assertAgentRunnerStructuredOutputRequest(
  request: AgentStructuredOutputRequest | undefined,
): void {
  if (request === undefined) return
  assertDurableJson(request)
  if (
    request.schema !== AGENT_STRUCTURED_OUTPUT_REQUEST_SCHEMA ||
    !isNonEmptyId(request.schemaName) ||
    request.schemaDigest !== structuredSchemaDigest(request.jsonSchema) ||
    !Number.isSafeInteger(request.maxAttempts) ||
    request.maxAttempts < 1 ||
    request.maxAttempts > 10
  ) {
    throw new TypeError('AgentRunner structured-output request is invalid')
  }
  assertUniqueStrategies(request.allowedStrategies)
}

export function selectAgentRunnerStructuredOutput(
  model: AgentRunnerModelPort,
  request: AgentStructuredOutputRequest,
): AgentRunnerStructuredOutputSelection
export function selectAgentRunnerStructuredOutput(
  model: AgentRunnerModelPort,
  request: undefined,
): undefined
export function selectAgentRunnerStructuredOutput(
  model: AgentRunnerModelPort,
  request: AgentStructuredOutputRequest | undefined,
): AgentRunnerStructuredOutputSelection | undefined {
  assertAgentRunnerStructuredOutputRequest(request)
  if (request === undefined) return undefined
  const capability = model.structuredOutputCapabilities
  if (capability === undefined ||
      capability.schema !== AGENT_RUNNER_STRUCTURED_OUTPUT_CAPABILITY_SCHEMA) {
    rejectStructuredOutput(request, 'structured-output-unsupported')
  }
  assertUniqueStrategies(capability.strategies, true)
  const selectedStrategy = request.allowedStrategies.find((strategy) =>
    capability.strategies.includes(strategy))
  if (selectedStrategy === undefined) {
    rejectStructuredOutput(request, 'structured-output-unsupported')
  }
  return {
    ...request,
    selectedStrategy,
    supportedStrategies: capability.strategies,
  }
}

function structuredFailure(
  request: AgentStructuredOutputRequest,
  failure: AgentRunnerStructuredOutputFailure['failure'],
): AgentRunnerStructuredOutputFailure {
  return {
    schema: AGENT_RUNNER_STRUCTURED_OUTPUT_EVIDENCE_SCHEMA,
    schemaName: request.schemaName,
    schemaDigest: request.schemaDigest,
    failure,
    attempts: 0,
  }
}

function rejectStructuredOutput(request: AgentStructuredOutputRequest, code: string): never {
  throw new AgentRunnerModelInvocationError({
    status: 'failed-before-dispatch',
    code,
    category: 'invalid-request',
    retryClassification: 'non-retryable',
    structuredOutput: structuredFailure(request, 'unsupported'),
  })
}

function assertStructuredEvidenceIdentity(
  evidence: AgentRunnerStructuredOutputSuccess | AgentRunnerStructuredOutputFailure,
  request: AgentRunnerStructuredOutputSelection,
): void {
  if (evidence.schema !== AGENT_RUNNER_STRUCTURED_OUTPUT_EVIDENCE_SCHEMA ||
      evidence.schemaName !== request.schemaName ||
      evidence.schemaDigest !== request.schemaDigest ||
      !Number.isSafeInteger(evidence.attempts) || evidence.attempts < 0 ||
      evidence.attempts > request.maxAttempts) {
    rejectModelResult('model-structured-output-evidence-mismatch')
  }
  if (evidence.strategy !== undefined &&
      (!request.allowedStrategies.includes(evidence.strategy) ||
       !request.supportedStrategies.includes(evidence.strategy))) {
    rejectModelResult('model-structured-output-strategy-mismatch')
  }
  if (evidence.fallbackFrom !== undefined &&
      (evidence.fallbackFrom !== request.selectedStrategy ||
       evidence.fallbackFrom !== 'native-json-schema' ||
       evidence.strategy !== 'json-text')) {
    rejectModelResult('model-structured-output-fallback-mismatch')
  }
  if (evidence.strategy !== undefined &&
      evidence.strategy !== request.selectedStrategy &&
      evidence.fallbackFrom !== request.selectedStrategy) {
    rejectModelResult('model-structured-output-fallback-mismatch')
  }
}

function assertFailure(
  failure: AgentRunnerModelFailure,
  request: AgentRunnerModelRequest,
): void {
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
  if (failure.status === 'failed-after-dispatch' &&
      failure.retryClassification === 'reconciliation-required') {
    throw new TypeError('AgentRunner known dispatched failure cannot require reconciliation')
  }
  if (failure.structuredOutput !== undefined) {
    if (request.structuredOutput === undefined) {
      throw new TypeError('AgentRunner unexpected structured-output failure evidence')
    }
    assertStructuredEvidenceIdentity(failure.structuredOutput, request.structuredOutput)
    if ((failure.structuredOutput.failure === 'unsupported') !==
        (failure.structuredOutput.attempts === 0)) {
      throw new TypeError('AgentRunner structured-output failure attempt evidence is invalid')
    }
  } else if (failure.status === 'failed-after-dispatch' &&
      request.structuredOutput !== undefined) {
    throw new TypeError('AgentRunner known structured-output failure requires evidence')
  }
}

function rejectModelResult(code: string): never {
  throw new AgentRunnerModelInvocationError({
    status: 'failed-after-dispatch',
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

/** @internal */
export interface PreparedAgentRunnerModelTurn {
  readonly items: readonly (AgentMessageItem | AgentToolCallItem)[]
  readonly toolCalls: readonly AgentToolCallItem[]
  readonly invocations: readonly AgentToolInvocationState[]
  readonly usage?: AgentUsageRecord
}

/** @internal */
export function prepareAgentRunnerModelTurn(options: {
  readonly result: AgentRunnerModelResult
  readonly tools: ReadonlyMap<string, AgentRunnerReadOnlyToolPort>
  readonly createId: (kind: 'invocation' | 'usage') => string
  readonly now: string
}): PreparedAgentRunnerModelTurn {
  const items = agentRunnerModelResultItems(options.result)
  const toolCalls = items.filter(
    (item): item is AgentToolCallItem => item.type === 'tool-call',
  )
  const invocations = toolCalls.map((toolCall): AgentToolInvocationState => {
    const tool = options.tools.get(toolCall.toolId)
    if (tool === undefined) rejectModelResult('model-unknown-tool')
    return {
      invocationId: options.createId('invocation'),
      callId: toolCall.callId,
      attempt: 1,
      inputDigest: digestRunnerJson(toolCall.arguments),
      toolId: tool.toolId,
      toolRevision: tool.toolRevision,
      effectClass: 'read',
      state: 'planned',
    }
  })
  const usage = options.result.usage === undefined
    ? undefined
    : createAgentRunnerModelUsageRecord(
        options.result.usage,
        options.createId('usage'),
        options.now,
      )
  return { items, toolCalls, invocations, ...(usage === undefined ? {} : { usage }) }
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

  assertStructuredModelResult(result, request, items, toolCallCount)
}

function assertStructuredModelResult(
  result: AgentRunnerModelResult,
  request: AgentRunnerModelRequest,
  items: readonly (AgentMessageItem | AgentToolCallItem)[],
  toolCallCount: number,
): void {
  if (request.structuredOutput === undefined) {
    if (result.structuredOutput !== undefined) {
      rejectModelResult('model-unrequested-structured-output')
    }
    return
  }
  const evidence = result.structuredOutput
  if (evidence === undefined || evidence.attempts < 1 || toolCallCount > 0 ||
      result.finishReason !== 'stop' || items.length !== 1) {
    rejectModelResult('model-invalid-structured-output')
  }
  assertStructuredEvidenceIdentity(evidence, request.structuredOutput)
  const item = items[0]
  if (item?.type !== 'message' || item.content.length !== 1) {
    rejectModelResult('model-invalid-structured-output')
  }
  const block = item.content[0]
  if (block?.type !== 'extension' ||
      block.namespace !== AGENT_RUNNER_STRUCTURED_OUTPUT_BLOCK_NAMESPACE ||
      digestRunnerJson(block.value) !== digestRunnerJson(evidence.value)) {
    rejectModelResult('model-structured-output-value-mismatch')
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
    assertFailure(result, request)
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
