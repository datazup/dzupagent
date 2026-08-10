import {
  AIMessage,
  ChatMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type ContentBlock,
  type UsageMetadata,
} from '@langchain/core/messages'
import type {
  AgentContentBlock,
  AgentItem,
  AgentMessageItem,
  AgentRunJsonValue,
  AgentToolCallItem,
} from '@dzupagent/agent-types/run'
import {
  cloneDurableJson,
  type AgentRunnerModelFailure,
  type AgentRunnerModelFinishReason,
  type AgentRunnerModelResult,
  type AgentRunnerModelUsage,
  type AgentRunnerProviderErrorCategory,
} from '@dzupagent/agent/runner'

export type AgentRunnerConversionIssueCode =
  | 'duplicate-tool-call-id'
  | 'duplicate-tool-result'
  | 'invalid-durable-json'
  | 'invalid-finish-reason'
  | 'invalid-message'
  | 'invalid-tool-arguments'
  | 'invalid-usage'
  | 'missing-tool-call-id'
  | 'provider-message-id-omitted'
  | 'provider-metadata-omitted'
  | 'unsupported-adapter-reference'
  | 'unsupported-content'
  | 'unsupported-item'
  | 'unsupported-message-name'
  | 'unsupported-tool-call-representation'

export interface AgentRunnerConversionIssue {
  readonly code: AgentRunnerConversionIssueCode
  readonly path: string
  readonly omittedCount?: number
}

export type AgentRunnerConversionResult<T> =
  | {
      readonly status: 'converted'
      readonly value: T
      readonly losses: readonly AgentRunnerConversionIssue[]
    }
  | { readonly status: 'rejected'; readonly issues: readonly AgentRunnerConversionIssue[] }

export interface AgentRunnerLangChainModelResultOptions {
  readonly itemIdPrefix: string
  readonly accountingSource: string
}

type MutableResult<T> =
  | { readonly value: T; readonly losses: AgentRunnerConversionIssue[] }
  | { readonly issues: AgentRunnerConversionIssue[] }

function issue(
  code: AgentRunnerConversionIssueCode,
  path: string,
  omittedCount?: number,
): AgentRunnerConversionIssue {
  return omittedCount === undefined ? { code, path } : { code, path, omittedCount }
}

function rejected<T>(issues: readonly AgentRunnerConversionIssue[]): AgentRunnerConversionResult<T> {
  return { status: 'rejected', issues }
}

function converted<T>(value: T, losses: readonly AgentRunnerConversionIssue[] = []): AgentRunnerConversionResult<T> {
  return { status: 'converted', value, losses }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneJson(value: unknown, path: string): MutableResult<AgentRunJsonValue> {
  try {
    return { value: cloneDurableJson(value as AgentRunJsonValue), losses: [] }
  } catch {
    return { issues: [issue('invalid-durable-json', path)] }
  }
}

function toLangChainContent(
  blocks: readonly AgentContentBlock[],
  path: string,
): MutableResult<ContentBlock.Standard[]> {
  const content: ContentBlock.Standard[] = []
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'reasoning-summary') {
      content.push({ type: 'reasoning', reasoning: block.text })
    } else return { issues: [issue('unsupported-content', `${path}[${index}]`)] }
  }
  return { value: content, losses: [] }
}

function toolCallsToLangChain(
  calls: readonly AgentToolCallItem[],
  path: string,
): MutableResult<Array<{ id: string; name: string; args: Record<string, AgentRunJsonValue> }>> {
  const seen = new Set<string>()
  const convertedCalls: Array<{
    id: string
    name: string
    args: Record<string, AgentRunJsonValue>
  }> = []
  for (const [index, call] of calls.entries()) {
    if (call.callId.length === 0) {
      return { issues: [issue('missing-tool-call-id', `${path}[${index}].callId`)] }
    }
    if (seen.has(call.callId)) {
      return { issues: [issue('duplicate-tool-call-id', `${path}[${index}].callId`)] }
    }
    if (call.toolId.length === 0 || !isRecord(call.arguments)) {
      return { issues: [issue('invalid-tool-arguments', `${path}[${index}].arguments`)] }
    }
    const cloned = cloneJson(call.arguments, `${path}[${index}].arguments`)
    if ('issues' in cloned) return cloned
    seen.add(call.callId)
    convertedCalls.push({
      id: call.callId,
      name: call.toolId,
      args: cloned.value as Record<string, AgentRunJsonValue>,
    })
  }
  return { value: convertedCalls, losses: [] }
}

function messageToLangChain(
  item: AgentMessageItem,
  calls: readonly AgentToolCallItem[],
  path: string,
): MutableResult<BaseMessage> {
  if (item.providerRef !== undefined) {
    return { issues: [issue('unsupported-adapter-reference', `${path}.providerRef`)] }
  }
  const content = toLangChainContent(item.content, `${path}.content`)
  if ('issues' in content) return content
  if (item.role === 'assistant') {
    const toolCalls = toolCallsToLangChain(calls, `${path}.toolCalls`)
    if ('issues' in toolCalls) return toolCalls
    return {
      value: new AIMessage({
        id: item.itemId,
        content: content.value,
        ...(toolCalls.value.length === 0 ? {} : { tool_calls: toolCalls.value }),
      }),
      losses: [],
    }
  }
  if (calls.length > 0) {
    return { issues: [issue('invalid-message', path)] }
  }
  if (item.role === 'system') {
    return { value: new SystemMessage({ id: item.itemId, content: content.value }), losses: [] }
  }
  if (item.role === 'user') {
    return { value: new HumanMessage({ id: item.itemId, content: content.value }), losses: [] }
  }
  return {
    value: new ChatMessage({ id: item.itemId, role: 'developer', content: content.value }),
    losses: [],
  }
}

/** Pure canonical-to-LangChain projection with exact tool-result linkage. */
export function agentRunnerItemsToLangChainMessages(
  items: readonly AgentItem[],
): AgentRunnerConversionResult<readonly BaseMessage[]> {
  const messages: BaseMessage[] = []
  const callCounts = new Map<string, number>()
  const resolvedCallIds = new Set<string>()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item === undefined) return rejected([issue('invalid-message', `items[${index}]`)])
    if (item.type === 'message') {
      const calls: AgentToolCallItem[] = []
      if (item.role === 'assistant') {
        while (items[index + 1]?.type === 'tool-call') {
          const call = items[index + 1] as AgentToolCallItem
          calls.push(call)
          index += 1
        }
      }
      const result = messageToLangChain(item, calls, `items[${index - calls.length}]`)
      if ('issues' in result) return rejected(result.issues)
      for (const call of calls) {
        if (callCounts.has(call.callId)) {
          return rejected([issue('duplicate-tool-call-id', `items[${index}].callId`)])
        }
        callCounts.set(call.callId, 1)
      }
      messages.push(result.value)
      continue
    }
    if (item.type === 'tool-call') {
      const calls = [item]
      while (items[index + 1]?.type === 'tool-call') {
        calls.push(items[index + 1] as AgentToolCallItem)
        index += 1
      }
      const toolCalls = toolCallsToLangChain(calls, `items[${index - calls.length + 1}]`)
      if ('issues' in toolCalls) return rejected(toolCalls.issues)
      for (const call of calls) {
        if (callCounts.has(call.callId)) {
          return rejected([issue('duplicate-tool-call-id', `items[${index}].callId`)])
        }
        callCounts.set(call.callId, 1)
      }
      messages.push(new AIMessage({ content: [], tool_calls: toolCalls.value }))
      continue
    }
    if (item.type === 'tool-result') {
      const count = callCounts.get(item.callId) ?? 0
      if (count === 0) return rejected([issue('missing-tool-call-id', `items[${index}].callId`)])
      if (count !== 1) return rejected([issue('duplicate-tool-call-id', `items[${index}].callId`)])
      if (resolvedCallIds.has(item.callId)) {
        return rejected([issue('duplicate-tool-result', `items[${index}].callId`)])
      }
      const output = cloneJson(item.output, `items[${index}].output`)
      if ('issues' in output) return rejected(output.issues)
      messages.push(
        new ToolMessage({
          id: item.itemId,
          content: JSON.stringify(output.value),
          tool_call_id: item.callId,
          status: item.isError ? 'error' : 'success',
        }),
      )
      resolvedCallIds.add(item.callId)
      continue
    }
    return rejected([issue('unsupported-item', `items[${index}]`)])
  }
  return converted(messages)
}

function fromLangChainContent(content: AIMessage['content']): MutableResult<AgentContentBlock[]> {
  if (typeof content === 'string') {
    return { value: content.length === 0 ? [] : [{ type: 'text', text: content }], losses: [] }
  }
  const blocks: AgentContentBlock[] = []
  const losses: AgentRunnerConversionIssue[] = []
  for (const [index, block] of content.entries()) {
    if (!isRecord(block)) return { issues: [issue('unsupported-content', `message.content[${index}]`)] }
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
      const omitted = Object.keys(block).filter((key) => key !== 'type' && key !== 'text').length
      if (omitted > 0) losses.push(issue('provider-metadata-omitted', `message.content[${index}]`, omitted))
    } else if (block.type === 'reasoning' && typeof block.reasoning === 'string') {
      blocks.push({ type: 'reasoning-summary', text: block.reasoning })
      const omitted = Object.keys(block).filter((key) => key !== 'type' && key !== 'reasoning').length
      if (omitted > 0) losses.push(issue('provider-metadata-omitted', `message.content[${index}]`, omitted))
    } else return { issues: [issue('unsupported-content', `message.content[${index}]`)] }
  }
  return { value: blocks, losses }
}

function token(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function mapUsage(
  usage: UsageMetadata | undefined,
  accountingSource: string,
): MutableResult<AgentRunnerModelUsage | undefined> {
  if (usage === undefined) return { value: undefined, losses: [] }
  if (!token(usage.input_tokens) || !token(usage.output_tokens) || !token(usage.total_tokens)) {
    return { issues: [issue('invalid-usage', 'message.usage_metadata')] }
  }
  if (usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
    return { issues: [issue('invalid-usage', 'message.usage_metadata.total_tokens')] }
  }
  const inputDetails = usage.input_token_details
  const outputDetails = usage.output_token_details
  const cacheRead = inputDetails?.cache_read
  const cacheWrite = inputDetails?.cache_creation
  const reasoning = outputDetails?.reasoning
  if (![cacheRead, cacheWrite, reasoning].every((value) => value === undefined || token(value))) {
    return { issues: [issue('invalid-usage', 'message.usage_metadata.details')] }
  }
  const losses: AgentRunnerConversionIssue[] = []
  const omittedInput = Object.keys(inputDetails ?? {}).filter(
    (key) => key !== 'cache_read' && key !== 'cache_creation',
  ).length
  const omittedOutput = Object.keys(outputDetails ?? {}).filter((key) => key !== 'reasoning').length
  if (omittedInput + omittedOutput > 0) {
    losses.push(
      issue('provider-metadata-omitted', 'message.usage_metadata.details', omittedInput + omittedOutput),
    )
  }
  return {
    value: {
      accountingSource,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
      ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    },
    losses,
  }
}

const FINISH_REASONS = new Map<string, AgentRunnerModelFinishReason>([
  ['stop', 'stop'],
  ['end_turn', 'stop'],
  ['tool_calls', 'tool-calls'],
  ['tool_use', 'tool-calls'],
  ['length', 'length'],
  ['max_tokens', 'length'],
  ['content_filter', 'content-filter'],
  ['cancelled', 'cancelled'],
  ['canceled', 'cancelled'],
  ['error', 'error'],
])

function finishReason(metadata: Readonly<Record<string, unknown>>): MutableResult<AgentRunnerModelFinishReason> {
  const values = [metadata.finish_reason, metadata.stop_reason].filter(
    (value): value is string => typeof value === 'string',
  )
  if (values.length === 0) return { value: 'unknown', losses: [] }
  const mapped = values.map((value) => FINISH_REASONS.get(value))
  if (mapped.some((value) => value === undefined) || new Set(mapped).size !== 1) {
    return { issues: [issue('invalid-finish-reason', 'message.response_metadata')] }
  }
  return { value: mapped[0] ?? 'unknown', losses: [] }
}

/** Pure LangChain completion-to-canonical conversion. No provider payload is retained. */
export function langChainMessageToAgentRunnerModelResult(
  message: BaseMessage,
  options: AgentRunnerLangChainModelResultOptions,
): AgentRunnerConversionResult<AgentRunnerModelResult> {
  if (!AIMessage.isInstance(message) || options.itemIdPrefix.length === 0 || options.accountingSource.length === 0) {
    return rejected([issue('invalid-message', 'message')])
  }
  if (message.name !== undefined) return rejected([issue('unsupported-message-name', 'message.name')])
  if ((message.invalid_tool_calls?.length ?? 0) > 0) {
    return rejected([issue('invalid-tool-arguments', 'message.invalid_tool_calls')])
  }
  const legacyKeys = Object.keys(message.additional_kwargs)
  if (legacyKeys.includes('function_call') || legacyKeys.includes('tool_calls')) {
    return rejected([issue('unsupported-tool-call-representation', 'message.additional_kwargs')])
  }
  const content = fromLangChainContent(message.content)
  if ('issues' in content) return rejected(content.issues)
  const usage = mapUsage(message.usage_metadata, options.accountingSource)
  if ('issues' in usage) return rejected(usage.issues)
  const finish = finishReason(message.response_metadata)
  if ('issues' in finish) return rejected(finish.issues)
  const calls: AgentToolCallItem[] = []
  const seen = new Set<string>()
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    if (typeof call.id !== 'string' || call.id.length === 0) {
      return rejected([issue('missing-tool-call-id', `message.tool_calls[${index}].id`)])
    }
    if (seen.has(call.id)) {
      return rejected([issue('duplicate-tool-call-id', `message.tool_calls[${index}].id`)])
    }
    if (call.name.length === 0 || !isRecord(call.args)) {
      return rejected([issue('invalid-tool-arguments', `message.tool_calls[${index}].args`)])
    }
    const args = cloneJson(call.args, `message.tool_calls[${index}].args`)
    if ('issues' in args) return rejected(args.issues)
    seen.add(call.id)
    calls.push({
      type: 'tool-call',
      itemId: `${options.itemIdPrefix}-tool-call-${index + 1}`,
      callId: call.id,
      toolId: call.name,
      arguments: args.value,
    })
  }
  const items: Array<AgentMessageItem | AgentToolCallItem> = []
  if (content.value.length > 0 || calls.length === 0) {
    items.push({
      type: 'message',
      itemId: `${options.itemIdPrefix}-message`,
      role: 'assistant',
      content: content.value,
    })
  }
  items.push(...calls)
  const first = items[0]
  if (first === undefined) return rejected([issue('invalid-message', 'message')])
  const losses = [...content.losses, ...usage.losses]
  if (message.id !== undefined) losses.push(issue('provider-message-id-omitted', 'message.id'))
  if (legacyKeys.length > 0) {
    losses.push(issue('provider-metadata-omitted', 'message.additional_kwargs', legacyKeys.length))
  }
  const retainedMetadata = ['finish_reason', 'stop_reason']
  const omittedMetadata = Object.keys(message.response_metadata).filter(
    (key) => !retainedMetadata.includes(key),
  ).length
  if (omittedMetadata > 0) {
    losses.push(issue('provider-metadata-omitted', 'message.response_metadata', omittedMetadata))
  }
  return converted(
    {
      status: 'completed',
      item: first,
      ...(items.length === 1 ? {} : { additionalItems: items.slice(1) }),
      ...(usage.value === undefined ? {} : { usage: usage.value }),
      finishReason: finish.value,
    },
    losses,
  )
}

export interface AgentRunnerProviderErrorInput {
  readonly statusCode?: number
  readonly code?: string
  readonly name?: string
}

function errorCategory(input: AgentRunnerProviderErrorInput): AgentRunnerProviderErrorCategory {
  const marker = `${input.code ?? ''} ${input.name ?? ''}`.toLowerCase()
  if (input.statusCode === 401) return 'authentication'
  if (input.statusCode === 403) return 'authorization'
  if (input.statusCode === 429 || marker.includes('rate')) return 'rate-limit'
  if (input.statusCode === 408 || marker.includes('timeout')) return 'timeout'
  if (input.statusCode === 400 || input.statusCode === 422) return 'invalid-request'
  if (input.statusCode === 503 || marker.includes('unavailable')) return 'unavailable'
  if (marker.includes('content_filter')) return 'content-filter'
  if (marker.includes('cancel')) return 'cancelled'
  if (
    marker.includes('authorization') ||
    marker.includes('authorisation') ||
    marker.includes('permission') ||
    marker.includes('forbidden')
  ) return 'authorization'
  if (
    marker.includes('authentication') ||
    marker.includes('unauthenticated') ||
    marker.includes('unauthorized') ||
    marker.includes('unauthorised') ||
    marker.includes('api_key') ||
    marker.includes('apikey')
  ) return 'authentication'
  if (input.statusCode !== undefined && input.statusCode >= 500) return 'internal'
  return 'unknown'
}

/** Normalize an error without retaining its message, payload, headers, or client. */
export function normalizeAgentRunnerProviderFailure(
  input: AgentRunnerProviderErrorInput,
  phase: 'before-dispatch' | 'possible-dispatch',
): AgentRunnerModelFailure {
  const category = errorCategory(input)
  if (phase === 'possible-dispatch') {
    return {
      status: 'outcome-unknown',
      code: 'provider-outcome-unknown',
      category,
      retryClassification: 'reconciliation-required',
    }
  }
  const retryable = ['rate-limit', 'timeout', 'unavailable', 'internal', 'unknown'].includes(category)
  return {
    status: 'failed-before-dispatch',
    code: `provider-${category}-before-dispatch`,
    category,
    retryClassification: retryable ? 'retryable' : 'non-retryable',
  }
}
