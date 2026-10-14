import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage, type StandardMessageStructure } from '@langchain/core/messages'
import type { GenerateResult } from '../agent/agent-types.js'
import type { AgentRunnerResult } from './runner-ports.js'
import { assertDurableJson, cloneDurableJson, digestRunnerJson } from './runner-durable-json.js'
import { projectLegacyCompletedRunnerResult } from './legacy-runner-completed-result-projection.js'
import type { LegacyRunnerExecutionProfile } from './legacy-runner-execution-profile.js'
import {
  boundMessageEnvelopeEntry, captureMessageEnvelopeEntry, reconstructLegacyMessage,
  validMessageEnvelopeEntry, type LegacyMessageEnvelopeEntry,
} from './legacy-runner-message-envelope-codec.js'

/** Internal qualification contract; no entrypoint or public export opts into tools. */
export const LEGACY_READ_TOOL_ENVELOPE_SCHEMA = 'dzupagent.legacyReadToolResultEnvelope/v1' as const
export const LEGACY_READ_TOOL_TIMING_POLICY = 'host-elapsed-ms/v1' as const

export interface LegacyReadToolTiming {
  readonly policy: typeof LEGACY_READ_TOOL_TIMING_POLICY
  readonly runId: string
  readonly invocationId: string
  readonly callId: string
  readonly attempt: 1
  readonly startedMs: number
  readonly completedMs: number
}

export interface LegacyReadToolResultEnvelope {
  readonly schema: typeof LEGACY_READ_TOOL_ENVELOPE_SCHEMA
  readonly entrypoint: 'not-delegated' | 'generate-single-read-opt-in'
  readonly profileDigest: string
  readonly behaviorDigest: string
  readonly runnerResultDigest: string
  readonly preparedInput: readonly LegacyMessageEnvelopeEntry[]
  readonly assistantCall: LegacyMessageEnvelopeEntry
  readonly finalAssistant: LegacyMessageEnvelopeEntry
  readonly timing: LegacyReadToolTiming
  readonly envelopeDigest: string
}

type Rejected = { readonly status: 'rejected'; readonly reason: string }
const reject = (reason: string): Rejected => ({ status: 'rejected', reason })

function keys(value: object, expected: readonly string[]): boolean {
  return Object.getOwnPropertyNames(value).sort().join('|') === [...expected].sort().join('|')
}

function dataRecord(value: unknown, expected: readonly string[]): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertySymbols(value).length === 0 && keys(value, expected)
    && Object.getOwnPropertyNames(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor?.enumerable === true && 'value' in descriptor
    })
}

function denseArray(value: unknown): boolean {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.getOwnPropertyNames(value).length === value.length + 1
    && Object.getOwnPropertyNames(value).every((key) => {
      if (key === 'length') return true
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length
        && descriptor?.enumerable === true && 'value' in descriptor
    })
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 192 && value.trim() === value
}

function instant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** Reject own accessors and serializer overrides before reading message values. */
export function boundedMessageShape(value: BaseMessage): boolean {
  const prototype = Object.getPrototypeOf(value)
  const baseline = prototype === AIMessage.prototype ? new AIMessage('')
    : prototype === ToolMessage.prototype ? new ToolMessage({ content: '', tool_call_id: 'shape-only' })
    : prototype === HumanMessage.prototype ? new HumanMessage('')
    : prototype === SystemMessage.prototype ? new SystemMessage('') : undefined
  if (baseline === undefined || !keys(value, Object.getOwnPropertyNames(baseline))) return false
  const actualSymbols = Object.getOwnPropertySymbols(value)
  const expectedSymbols = Object.getOwnPropertySymbols(baseline)
  return actualSymbols.length === expectedSymbols.length && actualSymbols.every((symbol) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, symbol)
    return expectedSymbols.includes(symbol) && descriptor !== undefined && 'value' in descriptor
      && descriptor.value === Object.getOwnPropertyDescriptor(baseline, symbol)?.value
  }) && Object.getOwnPropertyNames(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor
      && descriptor.enumerable === Object.getOwnPropertyDescriptor(baseline, key)?.enumerable
  })
}

/** Check descriptors before JSON operations, which otherwise skip hidden data or invoke accessors. */
function closedJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return
  if (ancestors.has(value)) throw new Error('cycle')
  ancestors.add(value)
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error('symbol')
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null
        && !(Array.isArray(value) && prototype === Array.prototype)) throw new Error('prototype')
    for (const key of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && key === 'length') continue
      if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)) {
        throw new Error('array-extension')
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true || !('value' in descriptor)) throw new Error('descriptor')
      closedJson(descriptor.value, ancestors)
    }
    if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new Error('sparse-array')
  } finally {
    ancestors.delete(value)
  }
}

function durable(value: unknown): void {
  closedJson(value)
  assertDurableJson(value)
}

function same(left: unknown, right: unknown): boolean {
  return digestRunnerJson(left) === digestRunnerJson(right)
}

/** Undefined is legitimate on message instances, but unknown own data must not vanish in toDict(). */
function messageDataEqual(left: unknown, right: unknown, ancestors = new Set<object>()): boolean {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return typeof left !== 'function' && Object.is(left, right)
  }
  if (ancestors.has(left) || ancestors.has(right)) return false
  const prototype = Object.getPrototypeOf(left)
  if (prototype !== Object.getPrototypeOf(right)
      || (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype)
      || Object.getOwnPropertySymbols(left).length !== 0 || Object.getOwnPropertySymbols(right).length !== 0
      || !keys(left, Object.getOwnPropertyNames(right))) return false
  ancestors.add(left)
  ancestors.add(right)
  try {
    return Object.getOwnPropertyNames(left).every((key) => {
      const actual = Object.getOwnPropertyDescriptor(left, key)
      const expected = Object.getOwnPropertyDescriptor(right, key)
      return actual !== undefined && expected !== undefined && 'value' in actual && 'value' in expected
        && actual.enumerable === expected.enumerable && messageDataEqual(actual.value, expected.value, ancestors)
    })
  } finally {
    ancestors.delete(left)
    ancestors.delete(right)
  }
}

export function exactMessage(actual: BaseMessage, expected: BaseMessage): boolean {
  const actualSymbols = Object.getOwnPropertySymbols(actual)
  const expectedSymbols = Object.getOwnPropertySymbols(expected)
  return Object.getPrototypeOf(actual) === Object.getPrototypeOf(expected)
    && actualSymbols.length === expectedSymbols.length
    && actualSymbols.every((symbol) => {
      const descriptor = Object.getOwnPropertyDescriptor(actual, symbol)
      return expectedSymbols.includes(symbol) && descriptor !== undefined && 'value' in descriptor
        && descriptor.value === Object.getOwnPropertyDescriptor(expected, symbol)?.value
    })
    && keys(actual, Object.getOwnPropertyNames(expected))
    && Object.getOwnPropertyNames(actual).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(actual, key)
      const wanted = Object.getOwnPropertyDescriptor(expected, key)
      return descriptor !== undefined && wanted !== undefined && 'value' in descriptor && 'value' in wanted
        && descriptor.enumerable === wanted.enumerable && messageDataEqual(descriptor.value, wanted.value)
    })
    && same(actual.toDict(), expected.toDict())
}

function inspect(profile: LegacyRunnerExecutionProfile, result: AgentRunnerResult) {
  durable({ profile, result })
  if (!dataRecord(profile, ['schema', 'profileId', 'behaviorDigest', 'claims', 'profileDigest'])
      || !denseArray(profile.claims) || profile.claims.some((claim) =>
        !dataRecord(claim, ['obligation', 'disposition', 'owner', 'evidence', 'binding']))) {
    throw new Error('profile-schema-unsupported')
  }
  const completed = projectLegacyCompletedRunnerResult({
    profile, expectedProfileDigest: profile.profileDigest,
    expectedBehaviorDigest: profile.behaviorDigest, result,
  })
  if (completed.status !== 'projected' || completed.report.outcome !== 'completed'
      || completed.report.exactSubset === undefined) throw new Error('completed-result-evidence-inexact')
  const projection = profile.claims.find((claim) => claim.obligation === 'legacy-result-projection')
  const entrypoint = projection?.disposition === 'disabled' && projection.binding.entrypoint === 'runner-direct-only'
    ? 'not-delegated' as const
    : projection?.disposition === 'supported' && projection.binding.entrypoint === 'generate-single-read-opt-in'
      ? 'generate-single-read-opt-in' as const : undefined
  if (entrypoint === undefined) throw new Error('read-profile-required')
  const state = result.state
  if (!keys(result, ['state', 'events']) || !keys(state, [
    'schema', 'runId', 'revision', 'status', 'agent', 'attempt', 'input', 'committedItems',
    'nextEventSeq', 'invocations', 'interactions', 'interactionDecisions', 'handoffs',
    'usage', 'budget', 'context', 'createdAt', 'updatedAt',
  ]) || !same(state.context, { state: 'absent' }) || state.attempt.number !== 1
      || !keys(state.agent, ['initialAgentId', 'currentAgentId', 'behaviorDigest'])
      || !keys(state.attempt, ['number', 'startedAt'])
      || !instant(state.createdAt) || !instant(state.updatedAt) || !instant(state.attempt.startedAt)
      || [state.input, state.committedItems, state.invocations, state.interactions,
        state.interactionDecisions, state.handoffs].some((value) => !denseArray(value))
      || state.agent.initialAgentId !== state.agent.currentAgentId
      || state.interactions.length !== 0 || state.interactionDecisions.length !== 0
      || state.handoffs.length !== 0 || state.invocations.length !== 1
      || state.committedItems.length !== 4
      || result.events.some((event) => ['run.suspended', 'run.resumed', 'tool.failed',
        'model.failed', 'interaction.requested', 'interaction.decided'].includes(event.type))) {
    throw new Error('single-uninterrupted-read-required')
  }
  const [assistant, call, output, final] = state.committedItems
  const invocation = state.invocations[0]!
  const allItems = [...state.input, ...state.committedItems]
  if (assistant?.type !== 'message' || assistant.role !== 'assistant'
      || call?.type !== 'tool-call' || output?.type !== 'tool-result'
      || final?.type !== 'message' || final.role !== 'assistant'
      || [assistant, final, ...state.input].some((item) =>
        item.type !== 'message' || !keys(item, ['type', 'itemId', 'role', 'content']))
      || !keys(call, ['type', 'itemId', 'callId', 'toolId', 'arguments'])
      || !keys(output, ['type', 'itemId', 'callId', 'output', 'isError'])
      || output.isError !== false || typeof output.output !== 'string'
      || allItems.some((item) => !identity(item.itemId))
      || !identity(state.runId) || !identity(state.agent.initialAgentId) || !identity(state.agent.currentAgentId)
      || !identity(call.callId) || !identity(call.toolId) || !identity(invocation.invocationId)
      || !identity(invocation.toolRevision)
      || new Set(allItems.map((item) => item.itemId)).size !== allItems.length
      || call.arguments === null || typeof call.arguments !== 'object' || Array.isArray(call.arguments)
      || !keys(invocation, ['invocationId', 'callId', 'attempt', 'inputDigest', 'toolId',
        'toolRevision', 'effectClass', 'state', 'resultDigest', 'completionEvidence'])
      || invocation.effectClass !== 'read' || invocation.state !== 'completed'
      || invocation.attempt !== 1 || invocation.effectKey !== undefined
      || invocation.parentInvocationId !== undefined || invocation.idempotencyKey !== undefined
      || call.callId !== invocation.callId || output.callId !== call.callId
      || call.toolId !== invocation.toolId || invocation.inputDigest !== digestRunnerJson(call.arguments)
      || invocation.resultDigest !== digestRunnerJson(output.output)) throw new Error('read-binding-invalid')
  if (!same(invocation.completionEvidence, { resultDigest: invocation.resultDigest })
      || (result.events.at(-1)!.payload as Record<string, unknown>).finalItemId !== final.itemId) {
    throw new Error('completion-binding-invalid')
  }
  const usage = state.usage.records
  if (!keys(state.usage, ['records']) || usage.length !== 2 || usage.some((record) =>
    !keys(record, ['usageId', 'source', 'accountingSource', 'recordedAt', 'inputTokens', 'outputTokens', 'totalTokens'])
      || record.source !== 'model' || typeof record.accountingSource !== 'string' || record.accountingSource.length === 0
      || !instant(record.recordedAt) || !identity(record.usageId)
      || !Number.isSafeInteger(record.inputTokens) || Number(record.inputTokens) < 0
      || !Number.isSafeInteger(record.outputTokens) || Number(record.outputTokens) < 0
      || record.totalTokens !== Number(record.inputTokens) + Number(record.outputTokens))) {
    throw new Error('complete-two-turn-usage-required')
  }
  if (!same(state.budget, { policyRef: 'runner/unbounded-local', policyRevision: '1',
    status: 'within-limit', limits: {}, consumed: {} })) throw new Error('budget-profile-unsupported')

  // This is the exact one-read, two-turn completion trace; extra events and every
  // unrepresented payload field are outside the qualified subset.
  const request1 = (result.events[1]?.payload as Record<string, unknown> | undefined)?.requestId
  const request2 = (result.events[10]?.payload as Record<string, unknown> | undefined)?.requestId
  if (!identity(request1) || !identity(request2) || request1 === request2) throw new Error('model-request-identity-invalid')
  const trace = [
    { type: 'run.started', payload: { status: 'running' } },
    { type: 'model.requested', payload: { requestId: request1, turn: 1 } },
    { type: 'model.completed', payload: { requestId: request1, turn: 1, itemType: 'message',
      itemCount: 2, itemIds: [assistant.itemId, call.itemId], callIds: [call.callId],
      usageId: usage[0]!.usageId, finishReason: 'tool-calls' } },
    { type: 'usage.recorded', payload: { usageId: usage[0]!.usageId, accountingSource: usage[0]!.accountingSource } },
    { type: 'item.added', payload: { itemId: assistant.itemId, itemType: 'message' } },
    { type: 'item.added', payload: { itemId: call.itemId, itemType: 'tool-call' } },
    { type: 'tool.selected', payload: { invocationId: invocation.invocationId, callId: call.callId,
      toolId: call.toolId, toolRevision: invocation.toolRevision, inputDigest: invocation.inputDigest } },
    { type: 'tool.started', payload: { invocationId: invocation.invocationId, callId: call.callId, executionAttempt: 1 } },
    { type: 'tool.completed', payload: { invocationId: invocation.invocationId,
      executionAttempt: 1, resultDigest: invocation.resultDigest, effectClass: 'read' } },
    { type: 'item.added', payload: { itemId: output.itemId, itemType: 'tool-result' } },
    { type: 'model.requested', payload: { requestId: request2, turn: 2 } },
    { type: 'model.completed', payload: { requestId: request2, turn: 2, itemType: 'message',
      itemCount: 1, itemIds: [final.itemId], callIds: [], usageId: usage[1]!.usageId, finishReason: 'stop' } },
    { type: 'usage.recorded', payload: { usageId: usage[1]!.usageId, accountingSource: usage[1]!.accountingSource } },
    { type: 'item.added', payload: { itemId: final.itemId, itemType: 'message' } },
    { type: 'run.completed', payload: { status: 'completed', finalItemId: final.itemId } },
  ]
  if (result.events.length !== trace.length || result.events.some((event, index) =>
    !keys(event, ['schema', 'runId', 'eventId', 'sequence', 'stateRevision', 'attempt', 'occurredAt', 'type', 'payload'])
      || !identity(event.eventId) || !instant(event.occurredAt)
      || event.type !== trace[index]!.type || !same(event.payload, trace[index]!.payload))) {
    throw new Error('qualified-event-trace-invalid')
  }
  return { state, assistant, call, output, outputText: output.output, final, invocation, usage, entrypoint, completed: completed.report.exactSubset }
}

function validTiming(timing: LegacyReadToolTiming, observed: ReturnType<typeof inspect>): boolean {
  return keys(timing, ['policy', 'runId', 'invocationId', 'callId', 'attempt', 'startedMs', 'completedMs'])
    && timing.policy === LEGACY_READ_TOOL_TIMING_POLICY && timing.runId === observed.state.runId
    && timing.invocationId === observed.invocation.invocationId && timing.callId === observed.call.callId
    && timing.attempt === 1 && Number.isSafeInteger(timing.startedMs) && timing.startedMs >= 0
    && Number.isSafeInteger(timing.completedMs) && timing.completedMs >= timing.startedMs
}

function assistantMessage(entry: LegacyMessageEnvelopeEntry, observed: ReturnType<typeof inspect>): AIMessage {
  const base = reconstructLegacyMessage(entry)
  const value = new AIMessage<StandardMessageStructure>({
    content: base.content,
    tool_calls: [{ name: observed.call.toolId, id: observed.call.callId,
      args: cloneDurableJson(observed.call.arguments) as Record<string, unknown> }],
    ...(entry.usageInConstructor === true ? { usage_metadata: { ...entry.usageMetadata! } } : {}),
  })
  if (entry.usageMetadata !== undefined) value.usage_metadata = { ...entry.usageMetadata }
  return value
}

function usageMatches(entry: LegacyMessageEnvelopeEntry, record: ReturnType<typeof inspect>['usage'][number]): boolean {
  return entry.usageMetadata !== undefined && entry.usageMetadata.input_tokens === record.inputTokens
    && entry.usageMetadata.output_tokens === record.outputTokens
    && entry.usageMetadata.total_tokens === Number(record.inputTokens) + Number(record.outputTokens)
}

export function captureLegacyReadToolResultEnvelope(input: {
  readonly profile: LegacyRunnerExecutionProfile
  readonly result: AgentRunnerResult
  readonly preparedInput: readonly BaseMessage[]
  readonly assistantCall: AIMessage
  readonly toolMessage: ToolMessage
  readonly finalAssistant: AIMessage
  readonly timing: LegacyReadToolTiming
}): { readonly status: 'captured'; readonly envelope: LegacyReadToolResultEnvelope } | Rejected {
  try {
    if (!dataRecord(input, ['profile', 'result', 'preparedInput', 'assistantCall', 'toolMessage', 'finalAssistant', 'timing'])
        || !denseArray(input.preparedInput)
        || [...input.preparedInput, input.assistantCall, input.toolMessage, input.finalAssistant]
          .some((message) => !boundedMessageShape(message))) return reject('capture-input-malformed')
    const observed = inspect(input.profile, input.result)
    durable(input.timing)
    if (!validTiming(input.timing, observed)) return reject('timing-invalid')
    if (input.preparedInput.length !== observed.state.input.length) return reject('input-count-mismatch')
    const preparedInput: LegacyMessageEnvelopeEntry[] = []
    for (const [index, message] of input.preparedInput.entries()) {
      const item = observed.state.input[index]
      if (item?.type !== 'message') return reject('input-item-invalid')
      const entry = captureMessageEnvelopeEntry(message, item, index)
      if (typeof entry === 'string' || !exactMessage(message, reconstructLegacyMessage(entry))) {
        return reject('input-message-invalid')
      }
      preparedInput.push(entry)
    }
    // Retain the assistant's ordinary envelope independently of its canonical call.
    const stripped = Object.hasOwn(input.assistantCall.toDict().data, 'usage_metadata')
      ? new AIMessage<StandardMessageStructure>({ content: input.assistantCall.content,
          usage_metadata: input.assistantCall.usage_metadata! })
      : new AIMessage(input.assistantCall.content)
    if (input.assistantCall.usage_metadata !== undefined) stripped.usage_metadata = input.assistantCall.usage_metadata
    const assistantCall = captureMessageEnvelopeEntry(stripped, observed.assistant, preparedInput.length, true)
    const finalAssistant = captureMessageEnvelopeEntry(input.finalAssistant, observed.final, preparedInput.length + 2, true)
    if (typeof assistantCall === 'string' || typeof finalAssistant === 'string'
        || !usageMatches(assistantCall, observed.usage[0]!) || !usageMatches(finalAssistant, observed.usage[1]!)
        || !exactMessage(input.assistantCall, assistantMessage(assistantCall, observed))
        || !exactMessage(input.toolMessage, new ToolMessage({ content: observed.outputText,
          tool_call_id: observed.call.callId, name: observed.call.toolId }))
        || !exactMessage(input.finalAssistant, reconstructLegacyMessage(finalAssistant))) {
      return reject('output-message-invalid')
    }
    const body = {
      schema: LEGACY_READ_TOOL_ENVELOPE_SCHEMA, entrypoint: observed.entrypoint,
      profileDigest: input.profile.profileDigest, behaviorDigest: input.profile.behaviorDigest,
      runnerResultDigest: digestRunnerJson(input.result), preparedInput, assistantCall, finalAssistant,
      timing: cloneDurableJson(input.timing),
    }
    durable(body)
    return { status: 'captured', envelope: { ...body, envelopeDigest: digestRunnerJson(body) } }
  } catch {
    return reject('read-evidence-invalid')
  }
}

export function projectLegacyReadToolGenerateResult(input: {
  readonly profile: LegacyRunnerExecutionProfile
  readonly result: AgentRunnerResult
  readonly envelope: LegacyReadToolResultEnvelope
  readonly expectedEnvelopeDigest: string
}): { readonly status: 'projected'; readonly result: GenerateResult; readonly resultDigest: string } | Rejected {
  try {
    durable(input)
    if (!keys(input, ['profile', 'result', 'envelope', 'expectedEnvelopeDigest'])) return reject('input-malformed')
    const observed = inspect(input.profile, input.result)
    const envelope = input.envelope
    if (!keys(envelope, ['schema', 'entrypoint', 'profileDigest', 'behaviorDigest', 'runnerResultDigest',
      'preparedInput', 'assistantCall', 'finalAssistant', 'timing', 'envelopeDigest'])) return reject('envelope-malformed')
    const { envelopeDigest, ...body } = envelope
    if (envelope.schema !== LEGACY_READ_TOOL_ENVELOPE_SCHEMA || envelope.entrypoint !== observed.entrypoint
        || envelope.profileDigest !== input.profile.profileDigest
        || envelope.behaviorDigest !== input.profile.behaviorDigest
        || envelope.runnerResultDigest !== digestRunnerJson(input.result)
        || envelopeDigest !== input.expectedEnvelopeDigest || envelopeDigest !== digestRunnerJson(body)
        || !validTiming(envelope.timing, observed)) return reject('envelope-binding-invalid')
    if (!Array.isArray(envelope.preparedInput) || envelope.preparedInput.length !== observed.state.input.length
        || !envelope.preparedInput.every((entry, index) => {
          const item = observed.state.input[index]
          return validMessageEnvelopeEntry(entry, index) && item?.type === 'message'
            && boundMessageEnvelopeEntry(entry, item)
        }) || !validMessageEnvelopeEntry(envelope.assistantCall, envelope.preparedInput.length)
        || !validMessageEnvelopeEntry(envelope.finalAssistant, envelope.preparedInput.length + 2)
        || !boundMessageEnvelopeEntry(envelope.assistantCall, observed.assistant)
        || !boundMessageEnvelopeEntry(envelope.finalAssistant, observed.final)
        || !usageMatches(envelope.assistantCall, observed.usage[0]!)
        || !usageMatches(envelope.finalAssistant, observed.usage[1]!)) return reject('message-binding-invalid')
    const preparedMessages = envelope.preparedInput.map(reconstructLegacyMessage)
    const messages = [...preparedMessages,
      assistantMessage(envelope.assistantCall, observed),
      new ToolMessage({ content: observed.outputText, tool_call_id: observed.call.callId, name: observed.call.toolId }),
      reconstructLegacyMessage(envelope.finalAssistant)]
    const durationMs = envelope.timing.completedMs - envelope.timing.startedMs
    const maxIterations = input.profile.claims.find((claim) => claim.obligation === 'bounded-model-turns')?.binding.maxModelTurns
    const result: GenerateResult = {
      content: envelope.finalAssistant.content.encoding === 'string'
        ? envelope.finalAssistant.content.value : JSON.stringify(envelope.finalAssistant.content.value),
      messages, usage: observed.completed.usage, hitIterationLimit: false, stopReason: 'complete',
      toolStats: [{ name: observed.call.toolId, calls: 1, errors: 0, totalMs: durationMs, avgMs: Math.round(durationMs) }],
      middlewareState: { agentId: observed.state.agent.initialAgentId, runId: observed.state.runId,
        messages: preparedMessages, maxIterations, tools: [observed.call.toolId] },
    }
    return { status: 'projected', result, resultDigest: digestRunnerJson({
      ...result, messages: messages.map((message) => message.toDict()), middlewareState: {
        ...result.middlewareState, messages: preparedMessages.map((message) => message.toDict()),
      },
    }) }
  } catch {
    return reject('read-evidence-invalid')
  }
}
