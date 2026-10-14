import { AIMessage, ToolMessage, type BaseMessage, type StandardMessageStructure } from '@langchain/core/messages'
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
  readonly entrypoint: 'not-delegated'
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

function exactMessage(actual: BaseMessage, expected: BaseMessage): boolean {
  return Object.getPrototypeOf(actual) === Object.getPrototypeOf(expected)
    && Object.getOwnPropertySymbols(actual).length === 0
    && keys(actual, Object.getOwnPropertyNames(expected))
    && Object.getOwnPropertyNames(actual).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(actual, key)
      return descriptor !== undefined && 'value' in descriptor
    })
    && same(actual.toDict(), expected.toDict())
}

function inspect(profile: LegacyRunnerExecutionProfile, result: AgentRunnerResult) {
  durable({ profile, result })
  const completed = projectLegacyCompletedRunnerResult({
    profile, expectedProfileDigest: profile.profileDigest,
    expectedBehaviorDigest: profile.behaviorDigest, result,
  })
  if (completed.status !== 'projected' || completed.report.outcome !== 'completed'
      || completed.report.exactSubset === undefined) throw new Error('completed-result-evidence-inexact')
  const projection = profile.claims.find((claim) => claim.obligation === 'legacy-result-projection')
  if (projection?.disposition !== 'disabled'
      || projection.binding.entrypoint !== 'runner-direct-only') throw new Error('direct-profile-required')
  const state = result.state
  if (!keys(result, ['state', 'events']) || !keys(state, [
    'schema', 'runId', 'revision', 'status', 'agent', 'attempt', 'input', 'committedItems',
    'nextEventSeq', 'invocations', 'interactions', 'interactionDecisions', 'handoffs',
    'usage', 'budget', 'context', 'createdAt', 'updatedAt',
  ]) || !same(state.context, { state: 'absent' }) || state.attempt.number !== 1
      || !keys(state.agent, ['initialAgentId', 'currentAgentId', 'behaviorDigest'])
      || !keys(state.attempt, ['number', 'startedAt'])
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
  if (assistant?.type !== 'message' || assistant.role !== 'assistant'
      || call?.type !== 'tool-call' || output?.type !== 'tool-result'
      || final?.type !== 'message' || final.role !== 'assistant'
      || [assistant, final, ...state.input].some((item) =>
        item.type !== 'message' || !keys(item, ['type', 'itemId', 'role', 'content']))
      || !keys(call, ['type', 'itemId', 'callId', 'toolId', 'arguments'])
      || !keys(output, ['type', 'itemId', 'callId', 'output', 'isError'])
      || output.isError !== false || typeof output.output !== 'string'
      || !keys(invocation, ['invocationId', 'callId', 'attempt', 'inputDigest', 'toolId',
        'toolRevision', 'effectClass', 'state', 'resultDigest', 'completionEvidence'])
      || invocation.effectClass !== 'read' || invocation.state !== 'completed'
      || invocation.attempt !== 1 || invocation.effectKey !== undefined
      || invocation.parentInvocationId !== undefined || invocation.idempotencyKey !== undefined
      || call.callId !== invocation.callId || output.callId !== call.callId
      || call.toolId !== invocation.toolId || invocation.inputDigest !== digestRunnerJson(call.arguments)
      || invocation.resultDigest !== digestRunnerJson(output.output)) throw new Error('read-binding-invalid')
  const starts = result.events.filter((event) => event.type === 'tool.started')
  const finishes = result.events.filter((event) => event.type === 'tool.completed')
  if (starts.length !== 1 || finishes.length !== 1 || starts[0]!.sequence >= finishes[0]!.sequence
      || [starts[0]!, finishes[0]!].some((event) => {
        const payload = event.payload as Record<string, unknown>
        return payload.invocationId !== invocation.invocationId || payload.executionAttempt !== 1
      }) || (finishes[0]!.payload as Record<string, unknown>).resultDigest !== invocation.resultDigest
      || (finishes[0]!.payload as Record<string, unknown>).effectClass !== 'read') {
    throw new Error('read-lifecycle-invalid')
  }
  const usage = state.usage.records
  if (usage.length !== 2 || usage.some((record) =>
    !Number.isSafeInteger(record.inputTokens) || Number(record.inputTokens) < 0
      || !Number.isSafeInteger(record.outputTokens) || Number(record.outputTokens) < 0)) {
    throw new Error('complete-two-turn-usage-required')
  }
  return { state, assistant, call, output, final, invocation, usage, completed: completed.report.exactSubset }
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
    const stripped = input.assistantCall.toDict().data.usage_metadata !== undefined
      ? new AIMessage<StandardMessageStructure>({ content: input.assistantCall.content,
          usage_metadata: input.assistantCall.usage_metadata! })
      : new AIMessage(input.assistantCall.content)
    if (input.assistantCall.usage_metadata !== undefined) stripped.usage_metadata = input.assistantCall.usage_metadata
    const assistantCall = captureMessageEnvelopeEntry(stripped, observed.assistant, preparedInput.length, true)
    const finalAssistant = captureMessageEnvelopeEntry(input.finalAssistant, observed.final, preparedInput.length + 2, true)
    if (typeof assistantCall === 'string' || typeof finalAssistant === 'string'
        || !usageMatches(assistantCall, observed.usage[0]!) || !usageMatches(finalAssistant, observed.usage[1]!)
        || !exactMessage(input.assistantCall, assistantMessage(assistantCall, observed))
        || !exactMessage(input.toolMessage, new ToolMessage({ content: observed.output.output,
          tool_call_id: observed.call.callId, name: observed.call.toolId }))
        || !exactMessage(input.finalAssistant, reconstructLegacyMessage(finalAssistant))) {
      return reject('output-message-invalid')
    }
    const body = {
      schema: LEGACY_READ_TOOL_ENVELOPE_SCHEMA, entrypoint: 'not-delegated' as const,
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
    if (envelope.schema !== LEGACY_READ_TOOL_ENVELOPE_SCHEMA || envelope.entrypoint !== 'not-delegated'
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
    const messages = [...envelope.preparedInput.map(reconstructLegacyMessage),
      assistantMessage(envelope.assistantCall, observed),
      new ToolMessage({ content: observed.output.output, tool_call_id: observed.call.callId, name: observed.call.toolId }),
      reconstructLegacyMessage(envelope.finalAssistant)]
    const durationMs = envelope.timing.completedMs - envelope.timing.startedMs
    const maxIterations = input.profile.claims.find((claim) => claim.obligation === 'bounded-model-turns')?.binding.maxModelTurns
    const result: GenerateResult = {
      content: envelope.finalAssistant.content.encoding === 'string'
        ? envelope.finalAssistant.content.value : JSON.stringify(envelope.finalAssistant.content.value),
      messages, usage: observed.completed.usage, hitIterationLimit: false, stopReason: 'complete',
      toolStats: [{ name: observed.call.toolId, calls: 1, errors: 0, totalMs: durationMs, avgMs: Math.round(durationMs) }],
      middlewareState: { agentId: observed.state.agent.initialAgentId, runId: observed.state.runId,
        messages: messages.slice(0, -1), maxIterations, tools: [observed.call.toolId] },
    }
    return { status: 'projected', result, resultDigest: digestRunnerJson({
      ...result, messages: messages.map((message) => message.toDict()), middlewareState: {
        ...result.middlewareState, messages: messages.slice(0, -1).map((message) => message.toDict()),
      },
    }) }
  } catch {
    return reject('read-evidence-invalid')
  }
}
