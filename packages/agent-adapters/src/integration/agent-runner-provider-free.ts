import { AIMessage, type ContentBlock, type UsageMetadata } from '@langchain/core/messages'
import type { AgentContentBlock, AgentRunJsonValue } from '@dzupagent/agent-types/run'
import { z } from 'zod'
import {
  AGENT_RUNNER_STRUCTURED_OUTPUT_BLOCK_NAMESPACE,
  AGENT_RUNNER_STRUCTURED_OUTPUT_EVIDENCE_SCHEMA,
  cloneDurableJson,
  type AgentRunnerModelFailure,
  type AgentRunnerModelFinishReason,
  type AgentRunnerModelInvocationResult,
  type AgentRunnerModelPort,
  type AgentRunnerModelRequest,
  type AgentRunnerModelUsage,
  type AgentRunnerReadOnlyToolPort,
  type AgentRunnerReadOnlyToolRequest,
  type AgentRunnerReadOnlyToolResult,
  type AgentRunnerStructuredOutputCapability,
  type AgentRunnerStructuredOutputFailure,
  type AgentRunnerStructuredOutputSelection,
} from '@dzupagent/agent/runner'

import { langChainMessageToAgentRunnerModelResult } from './agent-runner-langchain-conversion.js'

export interface ProviderFreeAgentRunnerToolCall {
  readonly callId: string
  readonly toolId: string
  readonly arguments: AgentRunJsonValue
}

export type ProviderFreeAgentRunnerStructuredAttempt =
  | { readonly outcome: 'native-rejected' }
  | { readonly outcome: 'output'; readonly text: string }

export type ProviderFreeAgentRunnerModelStep =
  | {
      readonly status: 'completed'
      readonly content: readonly AgentContentBlock[]
      readonly toolCalls?: readonly ProviderFreeAgentRunnerToolCall[]
      readonly usage?: AgentRunnerModelUsage
      readonly finishReason: AgentRunnerModelFinishReason
      readonly structuredAttempts?: readonly ProviderFreeAgentRunnerStructuredAttempt[]
    }
  | AgentRunnerModelFailure

export interface ProviderFreeAgentRunnerModelState {
  readonly schema: 'dzupagent.providerFreeAgentRunnerModel/v1'
  readonly cursor: number
  readonly steps: readonly ProviderFreeAgentRunnerModelStep[]
  readonly structuredOutputCapabilities?: AgentRunnerStructuredOutputCapability
}

export interface ProviderFreeAgentRunnerModelInvocation {
  readonly runId: string
  readonly requestId: string
  readonly attempt: number
  readonly turn: number
  readonly agentId: string
  readonly toolCount: number
  readonly structuredStrategy?: AgentRunnerStructuredOutputSelection['selectedStrategy']
}

function extractStructuredJsonText(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return fenced[1].trim()
  return trimmed
}

function langChainFinishReason(reason: AgentRunnerModelFinishReason): string | undefined {
  if (reason === 'tool-calls') return 'tool_calls'
  if (reason === 'content-filter') return 'content_filter'
  return reason === 'unknown' ? undefined : reason
}

function langChainContent(blocks: readonly AgentContentBlock[]): ContentBlock.Standard[] {
  return blocks.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'reasoning-summary') {
      return { type: 'reasoning', reasoning: block.text }
    }
    throw new TypeError(`Provider-free model does not support ${block.type}`)
  })
}

function langChainUsage(usage: AgentRunnerModelUsage | undefined): UsageMetadata | undefined {
  if (
    usage === undefined ||
    usage.inputTokens === undefined ||
    usage.outputTokens === undefined ||
    usage.totalTokens === undefined
  ) {
    return undefined
  }
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...((usage.cacheReadTokens === undefined && usage.cacheWriteTokens === undefined)
      ? {}
      : {
          input_token_details: {
            ...(usage.cacheReadTokens === undefined ? {} : { cache_read: usage.cacheReadTokens }),
            ...(usage.cacheWriteTokens === undefined
              ? {}
              : { cache_creation: usage.cacheWriteTokens }),
          },
        }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { output_token_details: { reasoning: usage.reasoningTokens } }),
  }
}

function providerFreeUsage(usage: AgentRunnerModelUsage | undefined): AgentRunnerModelUsage | undefined {
  if (usage === undefined) return undefined
  const cloned = cloneDurableJson(usage)
  const counts = [
    cloned.inputTokens,
    cloned.outputTokens,
    cloned.totalTokens,
    cloned.cacheReadTokens,
    cloned.cacheWriteTokens,
    cloned.reasoningTokens,
  ]
  if (
    cloned.accountingSource.length === 0 ||
    counts.some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0)) ||
    (cloned.totalTokens !== undefined &&
      cloned.inputTokens !== undefined &&
      cloned.outputTokens !== undefined &&
      cloned.totalTokens !== cloned.inputTokens + cloned.outputTokens)
  ) {
    throw new TypeError('Provider-free model usage is invalid')
  }
  return cloned
}

function structuredFailure(
  request: AgentRunnerStructuredOutputSelection,
  failure: AgentRunnerStructuredOutputFailure['failure'],
  attempts: number,
  strategy: AgentRunnerStructuredOutputSelection['selectedStrategy'],
  fallbackFrom: AgentRunnerStructuredOutputSelection['selectedStrategy'] | undefined,
): AgentRunnerModelFailure {
  return {
    status: attempts === 0 ? 'failed-before-dispatch' : 'failed-after-dispatch',
    code: `structured-output-${failure}`,
    category: 'invalid-response',
    retryClassification: 'non-retryable',
    structuredOutput: {
      schema: AGENT_RUNNER_STRUCTURED_OUTPUT_EVIDENCE_SCHEMA,
      schemaName: request.schemaName,
      schemaDigest: request.schemaDigest,
      failure,
      attempts,
      strategy,
      ...(fallbackFrom === undefined ? {} : { fallbackFrom }),
    },
  }
}

function providerFreeStructuredResult(options: {
  readonly request: AgentRunnerStructuredOutputSelection
  readonly attempts: readonly ProviderFreeAgentRunnerStructuredAttempt[]
  readonly itemId: string
  readonly usage?: AgentRunnerModelUsage
}): AgentRunnerModelInvocationResult {
  let schema: z.ZodType
  try {
    schema = z.fromJSONSchema(options.request.jsonSchema as Record<string, unknown>)
  } catch {
    return structuredFailure(
      options.request,
      'unsupported',
      0,
      options.request.selectedStrategy,
      undefined,
    )
  }
  let strategy = options.request.selectedStrategy
  let fallbackFrom: AgentRunnerStructuredOutputSelection['selectedStrategy'] | undefined
  let lastFailure: AgentRunnerStructuredOutputFailure['failure'] = 'malformed-json'
  let attemptCount = 0
  for (const attempt of options.attempts.slice(0, options.request.maxAttempts)) {
    attemptCount += 1
    if (attempt.outcome === 'native-rejected') {
      lastFailure = 'native-rejected'
      const canFallback = strategy === 'native-json-schema' &&
        options.request.allowedStrategies.includes('json-text') &&
        options.request.supportedStrategies.includes('json-text')
      if (!canFallback) {
        return structuredFailure(options.request, lastFailure, attemptCount, strategy, fallbackFrom)
      }
      fallbackFrom = strategy
      strategy = 'json-text'
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(extractStructuredJsonText(attempt.text))
    } catch {
      lastFailure = 'malformed-json'
      continue
    }
    const validated = schema.safeParse(parsed)
    if (!validated.success) {
      lastFailure = 'schema-invalid'
      continue
    }
    const value = cloneDurableJson(validated.data as AgentRunJsonValue)
    const structuredOutput = {
      schema: AGENT_RUNNER_STRUCTURED_OUTPUT_EVIDENCE_SCHEMA,
      schemaName: options.request.schemaName,
      schemaDigest: options.request.schemaDigest,
      strategy,
      attempts: attemptCount,
      ...(fallbackFrom === undefined ? {} : { fallbackFrom }),
      value,
    } as const
    return {
      status: 'completed',
      item: {
        type: 'message',
        itemId: options.itemId,
        role: 'assistant',
        content: [{
          type: 'extension',
          namespace: AGENT_RUNNER_STRUCTURED_OUTPUT_BLOCK_NAMESPACE,
          value,
        }],
      },
      structuredOutput,
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      finishReason: 'stop',
    }
  }
  return structuredFailure(options.request, lastFailure, attemptCount, strategy, fallbackFrom)
}

/** Deterministic, credential-free model adapter for conformance only. */
export class ProviderFreeAgentRunnerModelAdapter implements AgentRunnerModelPort {
  readonly adapterId = 'dzupagent-provider-free-runner-model/v1'
  readonly invocations: ProviderFreeAgentRunnerModelInvocation[] = []
  readonly structuredOutputCapabilities?: AgentRunnerStructuredOutputCapability
  readonly #steps: readonly ProviderFreeAgentRunnerModelStep[]
  #cursor: number

  constructor(state: ProviderFreeAgentRunnerModelState) {
    if (state.schema !== 'dzupagent.providerFreeAgentRunnerModel/v1') {
      throw new TypeError('Unsupported provider-free model state')
    }
    this.#steps = cloneDurableJson(state.steps)
    this.#cursor = state.cursor
    if (state.structuredOutputCapabilities !== undefined) {
      this.structuredOutputCapabilities = cloneDurableJson(state.structuredOutputCapabilities)
    }
    if (!Number.isSafeInteger(this.#cursor) || this.#cursor < 0 || this.#cursor > this.#steps.length) {
      throw new RangeError('Invalid provider-free model cursor')
    }
  }

  snapshot(): ProviderFreeAgentRunnerModelState {
    return cloneDurableJson({
      schema: 'dzupagent.providerFreeAgentRunnerModel/v1' as const,
      cursor: this.#cursor,
      steps: this.#steps,
      ...(this.structuredOutputCapabilities === undefined
        ? {}
        : { structuredOutputCapabilities: this.structuredOutputCapabilities }),
    })
  }

  async invoke(request: AgentRunnerModelRequest): Promise<AgentRunnerModelInvocationResult> {
    this.invocations.push({
      runId: request.runId,
      requestId: request.requestId,
      attempt: request.attempt,
      turn: request.turn,
      agentId: request.agentId,
      toolCount: request.tools.length,
      ...(request.structuredOutput === undefined
        ? {}
        : { structuredStrategy: request.structuredOutput.selectedStrategy }),
    })
    const step = this.#steps[this.#cursor]
    if (step === undefined) {
      return {
        status: 'failed-before-dispatch',
        code: 'provider-free-script-exhausted',
        category: 'invalid-request',
        retryClassification: 'non-retryable',
      }
    }
    this.#cursor += 1
    if (step.status !== 'completed') return cloneDurableJson(step)
    const usage = providerFreeUsage(step.usage)
    if (request.structuredOutput !== undefined) {
      return providerFreeStructuredResult({
        request: request.structuredOutput,
        attempts: step.structuredAttempts ?? [],
        itemId: `${request.requestId}-turn-${request.turn}-message`,
        ...(usage === undefined ? {} : { usage }),
      })
    }
    const usageMetadata = langChainUsage(usage)
    const finishReason = langChainFinishReason(step.finishReason)
    const message = new AIMessage({
      content: langChainContent(step.content),
      tool_calls: (step.toolCalls ?? []).map((call) => ({
        id: call.callId,
        name: call.toolId,
        args: cloneDurableJson(call.arguments) as Record<string, AgentRunJsonValue>,
      })),
      ...(finishReason === undefined ? {} : { response_metadata: { finish_reason: finishReason } }),
      ...(usageMetadata === undefined ? {} : { usage_metadata: usageMetadata }),
    })
    const result = langChainMessageToAgentRunnerModelResult(message, {
      itemIdPrefix: `${request.requestId}-turn-${request.turn}`,
      accountingSource: step.usage?.accountingSource ?? this.adapterId,
    })
    if (result.status === 'rejected' || result.losses.length > 0) {
      throw new TypeError('Provider-free model conversion failed closed')
    }
    if (usage !== undefined && result.value.usage === undefined) {
      return { ...result.value, usage }
    }
    return result.value
  }
}

export type ProviderFreeAgentRunnerReadToolStep =
  | AgentRunnerReadOnlyToolResult
  | { readonly status: 'outcome-unknown' }

export interface ProviderFreeAgentRunnerReadToolState {
  readonly schema: 'dzupagent.providerFreeAgentRunnerReadTool/v1'
  readonly cursor: number
  readonly steps: readonly ProviderFreeAgentRunnerReadToolStep[]
}

/** Deterministic read-tool fake. Thrown steps deliberately mean possible dispatch. */
export class ProviderFreeAgentRunnerReadToolAdapter implements AgentRunnerReadOnlyToolPort {
  readonly toolId: string
  readonly toolRevision: string
  readonly effectClass = 'read' as const
  readonly description = 'Provider-free AgentRunner conformance read tool'
  readonly inputSchema = { type: 'object', additionalProperties: true } as const
  invocations = 0
  readonly #steps: readonly ProviderFreeAgentRunnerReadToolStep[]
  #cursor: number

  constructor(
    toolId: string,
    toolRevision: string,
    state: ProviderFreeAgentRunnerReadToolState,
  ) {
    this.toolId = toolId
    this.toolRevision = toolRevision
    this.#steps = cloneDurableJson(state.steps)
    this.#cursor = state.cursor
    if (
      toolId.length === 0 ||
      toolRevision.length === 0 ||
      !Number.isSafeInteger(this.#cursor) ||
      this.#cursor < 0 ||
      this.#cursor > this.#steps.length
    ) {
      throw new TypeError('Invalid provider-free read-tool state')
    }
  }

  snapshot(): ProviderFreeAgentRunnerReadToolState {
    return cloneDurableJson({
      schema: 'dzupagent.providerFreeAgentRunnerReadTool/v1' as const,
      cursor: this.#cursor,
      steps: this.#steps,
    })
  }

  async execute(_request: AgentRunnerReadOnlyToolRequest): Promise<AgentRunnerReadOnlyToolResult> {
    this.invocations += 1
    const step = this.#steps[this.#cursor]
    if (step === undefined) {
      return { status: 'failed-before-effect', code: 'provider-free-script-exhausted', retryable: false }
    }
    this.#cursor += 1
    if (step.status === 'outcome-unknown') throw new Error('provider-free-outcome-unknown')
    return cloneDurableJson(step)
  }
}
