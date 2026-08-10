import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type {
  AgentMessageItem,
  AgentRunJsonValue,
} from '@dzupagent/agent-types/run'

import type { GenerateResult } from '../../agent/agent-types.js'
import type { AgentRunnerResult } from '../../runner/in-memory-agent-runner.js'
import { assertDurableJson, digestRunnerJson } from '../../runner/runner-values.js'
import {
  projectLegacyCompletedRunnerResult,
  type LegacyCompletedResultProjectionReport,
} from './legacy-runner-completed-result-projection.js'
import {
  evaluateRunnerProviderFreeExecutionProfile,
  type LegacyRunnerExecutionProfile,
} from './legacy-runner-execution-profile.js'

export const LEGACY_NO_TOOL_RESULT_ENVELOPE_SCHEMA =
  'dzupagent.legacyNoToolResultEnvelope/v1' as const
export const LEGACY_NO_TOOL_RESULT_PROJECTOR_ID =
  'legacy-no-tool-generate-result/v1' as const

type LegacyMessageRole = 'system' | 'human' | 'ai'

export type LegacyMessageContentEnvelope =
  | { readonly encoding: 'string'; readonly value: string }
  | {
      readonly encoding: 'standard-text-blocks'
      readonly value: readonly { readonly type: 'text'; readonly text: string }[]
    }

export interface LegacyMessageEnvelopeEntry {
  readonly index: number
  readonly role: LegacyMessageRole
  readonly content: LegacyMessageContentEnvelope
  readonly itemId: string
  readonly itemDigest: string
  readonly usageMetadata?: {
    readonly input_tokens: number
    readonly output_tokens: number
    readonly total_tokens: number
  }
}

export interface LegacyNoToolResultEnvelope {
  readonly schema: typeof LEGACY_NO_TOOL_RESULT_ENVELOPE_SCHEMA
  readonly behaviorDigest: string
  readonly profileDigest: string
  readonly source: {
    readonly runId: string
    readonly stateRevision: number
    readonly terminalEventSequence: number
  }
  readonly preparedInput: readonly LegacyMessageEnvelopeEntry[]
  readonly finalAssistant: LegacyMessageEnvelopeEntry
  readonly envelopeDigest: string
}

export type LegacyNoToolEnvelopeRejectionCode =
  | 'profile-ineligible'
  | 'projection-profile-required'
  | 'result-not-uninterrupted-completion'
  | 'result-not-no-tool'
  | 'result-state-extension-unsupported'
  | 'message-count-mismatch'
  | 'message-class-unsupported'
  | 'message-content-unsupported'
  | 'message-metadata-unsupported'
  | 'message-item-mismatch'
  | 'final-item-invalid'

export type LegacyNoToolEnvelopeCapture =
  | { readonly status: 'captured'; readonly envelope: LegacyNoToolResultEnvelope }
  | { readonly status: 'rejected'; readonly reasons: readonly LegacyNoToolEnvelopeRejectionCode[] }

export interface LegacyNoToolEnvelopeCaptureInput {
  readonly profile: LegacyRunnerExecutionProfile
  readonly preparedInput: readonly BaseMessage[]
  readonly finalAssistant: BaseMessage
  readonly result: AgentRunnerResult
}

export type LegacyNoToolResultProjectionRejectionCode =
  | 'input-not-json-safe'
  | 'profile-ineligible'
  | 'projection-profile-required'
  | 'profile-digest-mismatch'
  | 'behavior-digest-mismatch'
  | 'envelope-digest-mismatch'
  | 'source-binding-mismatch'
  | 'result-not-uninterrupted-completion'
  | 'result-not-no-tool'
  | 'result-state-extension-unsupported'
  | 'message-count-mismatch'
  | 'message-binding-mismatch'
  | 'message-envelope-malformed'
  | 'completed-result-evidence-inexact'

export interface LegacyNoToolResultProjectionReport {
  readonly schema: typeof LEGACY_NO_TOOL_RESULT_ENVELOPE_SCHEMA
  readonly projectorId: typeof LEGACY_NO_TOOL_RESULT_PROJECTOR_ID
  readonly profileDigest: string
  readonly behaviorDigest: string
  readonly envelopeDigest: string
  readonly source: LegacyNoToolResultEnvelope['source']
  readonly fullGenerateResultCompatible: true
  readonly resultDigest: string
}

export type LegacyNoToolResultProjection =
  | {
      readonly status: 'projected'
      readonly result: GenerateResult
      readonly report: LegacyNoToolResultProjectionReport
    }
  | {
      readonly status: 'rejected'
      readonly reasons: readonly LegacyNoToolResultProjectionRejectionCode[]
    }

export interface LegacyNoToolResultProjectionInput {
  readonly profile: LegacyRunnerExecutionProfile
  readonly expectedProfileDigest: string
  readonly expectedBehaviorDigest: string
  readonly expectedEnvelopeDigest: string
  readonly envelope: LegacyNoToolResultEnvelope
  readonly result: AgentRunnerResult
}

function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function emptyObject(value: unknown): boolean {
  return object(value) && Object.keys(value).length === 0
}

function projectionClaim(profile: LegacyRunnerExecutionProfile): boolean {
  const claim = profile.claims.find(
    (candidate) => candidate.obligation === 'legacy-result-projection',
  )
  return claim?.owner === 'host'
    && claim.disposition === 'supported'
    && claim.evidence.length === 1
    && claim.evidence[0] === 'r5m-no-tool-generate-result'
    && claim.binding.entrypoint === 'not-delegated'
    && claim.binding.projection === 'no-tool-generate-result/v1'
}

function legacyRole(message: BaseMessage): LegacyMessageRole | undefined {
  if (SystemMessage.isInstance(message)) return 'system'
  if (HumanMessage.isInstance(message)) return 'human'
  if (AIMessage.isInstance(message)) return 'ai'
  return undefined
}

function captureContent(content: BaseMessage['content']): LegacyMessageContentEnvelope | undefined {
  if (typeof content === 'string') return { encoding: 'string', value: content }
  if (!Array.isArray(content)) return undefined
  const blocks: Array<{ readonly type: 'text'; readonly text: string }> = []
  for (const block of content) {
    if (!object(block)
        || Object.keys(block).sort().join('|') !== 'text|type'
        || block.type !== 'text'
        || typeof block.text !== 'string') return undefined
    blocks.push({ type: 'text', text: block.text })
  }
  return { encoding: 'standard-text-blocks', value: blocks }
}

function cleanMetadata(message: BaseMessage, allowUsage: boolean): boolean {
  if (message.id !== undefined || message.name !== undefined
      || !emptyObject(message.additional_kwargs)
      || !emptyObject(message.response_metadata)) return false
  if (!AIMessage.isInstance(message)) return true
  if ((message.tool_calls?.length ?? 0) !== 0
      || (message.invalid_tool_calls?.length ?? 0) !== 0) return false
  if (message.usage_metadata === undefined) return true
  const usage = message.usage_metadata
  return allowUsage
    && Object.keys(usage).sort().join('|') === 'input_tokens|output_tokens|total_tokens'
    && Number.isSafeInteger(usage.input_tokens)
    && Number.isSafeInteger(usage.output_tokens)
    && usage.total_tokens === usage.input_tokens + usage.output_tokens
}

function runnerRole(role: LegacyMessageRole): AgentMessageItem['role'] {
  return role === 'human' ? 'user' : role === 'ai' ? 'assistant' : 'system'
}

function runnerContent(content: LegacyMessageContentEnvelope) {
  return content.encoding === 'string'
    ? [{ type: 'text' as const, text: content.value }]
    : content.value
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function captureEntry(
  message: BaseMessage,
  item: AgentMessageItem,
  index: number,
  allowUsage = false,
): LegacyMessageEnvelopeEntry | LegacyNoToolEnvelopeRejectionCode {
  const role = legacyRole(message)
  if (role === undefined) return 'message-class-unsupported'
  if (!cleanMetadata(message, allowUsage)) return 'message-metadata-unsupported'
  const content = captureContent(message.content)
  if (content === undefined) return 'message-content-unsupported'
  if (item.providerRef !== undefined
      || item.role !== runnerRole(role)
      || !same(item.content, runnerContent(content))) return 'message-item-mismatch'
  const usage = AIMessage.isInstance(message) ? message.usage_metadata : undefined
  return {
    index,
    role,
    content,
    itemId: item.itemId,
    itemDigest: digestRunnerJson(item),
    ...(usage === undefined ? {} : {
      usageMetadata: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
      },
    }),
  }
}

function terminalFinalItem(result: AgentRunnerResult): AgentMessageItem | undefined {
  const terminal = result.events.at(-1)
  const payload = object(terminal?.payload) ? terminal.payload : undefined
  if (terminal?.type !== 'run.completed' || typeof payload?.finalItemId !== 'string') {
    return undefined
  }
  const item = result.state.committedItems.find(
    (candidate) => candidate.itemId === payload.finalItemId,
  )
  return item?.type === 'message' && item.role === 'assistant' ? item : undefined
}

function noToolState(result: AgentRunnerResult): boolean {
  return result.state.invocations.length === 0
    && result.state.committedItems.every((item) => item.type === 'message')
}

function uninterruptedCompletion(result: AgentRunnerResult): boolean {
  return result.state.status === 'completed'
    && result.events.at(-1)?.type === 'run.completed'
    && !result.events.some((event) => event.type === 'run.suspended' || event.type === 'model.failed')
}

function unsupportedStateExtension(result: AgentRunnerResult): boolean {
  return result.state.structuredOutput !== undefined
    || result.state.context.state !== 'absent'
    || result.state.sessionBinding !== undefined
    || result.state.adapterState !== undefined
    || result.state.sandboxRef !== undefined
}

function rejectCapture(
  ...reasons: LegacyNoToolEnvelopeRejectionCode[]
): LegacyNoToolEnvelopeCapture {
  return { status: 'rejected', reasons: [...new Set(reasons)] }
}

export function captureLegacyNoToolResultEnvelope(
  input: LegacyNoToolEnvelopeCaptureInput,
): LegacyNoToolEnvelopeCapture {
  const eligible = evaluateRunnerProviderFreeExecutionProfile(
    input.profile,
    input.profile.behaviorDigest,
  )
  if (eligible.status !== 'eligible') return rejectCapture('profile-ineligible')
  if (!projectionClaim(input.profile)) return rejectCapture('projection-profile-required')
  if (!uninterruptedCompletion(input.result)) {
    return rejectCapture('result-not-uninterrupted-completion')
  }
  if (!noToolState(input.result)) return rejectCapture('result-not-no-tool')
  if (unsupportedStateExtension(input.result)) {
    return rejectCapture('result-state-extension-unsupported')
  }
  if (input.preparedInput.length !== input.result.state.input.length) {
    return rejectCapture('message-count-mismatch')
  }

  const preparedInput: LegacyMessageEnvelopeEntry[] = []
  for (const [index, message] of input.preparedInput.entries()) {
    const item = input.result.state.input[index]
    if (item?.type !== 'message') return rejectCapture('message-item-mismatch')
    const entry = captureEntry(message, item, index)
    if (typeof entry === 'string') return rejectCapture(entry)
    preparedInput.push(entry)
  }
  const finalItem = terminalFinalItem(input.result)
  if (finalItem === undefined || input.result.state.committedItems.length !== 1) {
    return rejectCapture('final-item-invalid')
  }
  const finalAssistant = captureEntry(
    input.finalAssistant,
    finalItem,
    preparedInput.length,
    true,
  )
  if (typeof finalAssistant === 'string') return rejectCapture(finalAssistant)
  if (finalAssistant.role !== 'ai') return rejectCapture('final-item-invalid')

  const body = {
    schema: LEGACY_NO_TOOL_RESULT_ENVELOPE_SCHEMA,
    behaviorDigest: input.result.state.agent.behaviorDigest,
    profileDigest: input.profile.profileDigest,
    source: {
      runId: input.result.state.runId,
      stateRevision: input.result.state.revision,
      terminalEventSequence: input.result.events.at(-1)?.sequence ?? -1,
    },
    preparedInput,
    finalAssistant,
  }
  const envelope: LegacyNoToolResultEnvelope = {
    ...body,
    envelopeDigest: digestRunnerJson(body),
  }
  return { status: 'captured', envelope }
}

function rejectProjection(
  ...reasons: LegacyNoToolResultProjectionRejectionCode[]
): LegacyNoToolResultProjection {
  return { status: 'rejected', reasons: [...new Set(reasons)] }
}

function validEnvelopeEntry(value: unknown, index: number): value is LegacyMessageEnvelopeEntry {
  if (!object(value)
      || value.index !== index
      || !['system', 'human', 'ai'].includes(String(value.role))
      || typeof value.itemId !== 'string'
      || typeof value.itemDigest !== 'string'
      || !object(value.content)) return false
  const usageValid = value.usageMetadata === undefined || (value.role === 'ai'
    && object(value.usageMetadata)
    && Object.keys(value.usageMetadata).sort().join('|') === 'input_tokens|output_tokens|total_tokens'
    && Number.isSafeInteger(value.usageMetadata.input_tokens)
    && Number.isSafeInteger(value.usageMetadata.output_tokens)
    && value.usageMetadata.total_tokens
      === value.usageMetadata.input_tokens + value.usageMetadata.output_tokens)
  if (!usageValid) return false
  if (value.content.encoding === 'string') return typeof value.content.value === 'string'
  return value.content.encoding === 'standard-text-blocks'
    && Array.isArray(value.content.value)
    && value.content.value.every((block) => object(block)
      && Object.keys(block).sort().join('|') === 'text|type'
      && block.type === 'text'
      && typeof block.text === 'string')
}

function reconstruct(entry: LegacyMessageEnvelopeEntry): BaseMessage {
  const content = entry.content.encoding === 'string'
    ? entry.content.value
    : entry.content.value.map((block) => ({ ...block }))
  if (entry.role === 'system') return new SystemMessage(content)
  if (entry.role === 'human') return new HumanMessage(content)
  return new AIMessage({
    content,
    ...(entry.usageMetadata === undefined ? {} : { usage_metadata: entry.usageMetadata }),
  })
}

function exactField(
  report: LegacyCompletedResultProjectionReport,
  name: string,
): AgentRunJsonValue | undefined {
  const field = report.fields.find((candidate) => candidate.field === name)
  return field?.status === 'exact' ? field.value : undefined
}

function allOptionalAbsencesExact(report: LegacyCompletedResultProjectionReport): boolean {
  return ['stuckError', 'learnings', 'memoryFrame', 'compressionLog', 'suspended'].every(
    (name) => report.fields.find((field) => field.field === name)?.status === 'exact',
  )
}

function boundEntry(entry: LegacyMessageEnvelopeEntry, item: AgentMessageItem): boolean {
  return entry.itemId === item.itemId
    && entry.itemDigest === digestRunnerJson(item)
    && item.providerRef === undefined
    && item.role === runnerRole(entry.role)
    && same(item.content, runnerContent(entry.content))
}

export function projectLegacyNoToolGenerateResult(
  input: LegacyNoToolResultProjectionInput,
): LegacyNoToolResultProjection {
  try {
    assertDurableJson(input)
  } catch {
    return rejectProjection('input-not-json-safe')
  }
  const eligible = evaluateRunnerProviderFreeExecutionProfile(
    input.profile,
    input.expectedBehaviorDigest,
  )
  if (eligible.status !== 'eligible') return rejectProjection('profile-ineligible')
  if (!projectionClaim(input.profile)) return rejectProjection('projection-profile-required')
  if (input.profile.profileDigest !== input.expectedProfileDigest
      || input.envelope.profileDigest !== input.expectedProfileDigest) {
    return rejectProjection('profile-digest-mismatch')
  }
  if (input.envelope.schema !== LEGACY_NO_TOOL_RESULT_ENVELOPE_SCHEMA) {
    return rejectProjection('message-envelope-malformed')
  }
  if (input.profile.behaviorDigest !== input.expectedBehaviorDigest
      || input.envelope.behaviorDigest !== input.expectedBehaviorDigest
      || input.result.state.agent.behaviorDigest !== input.expectedBehaviorDigest) {
    return rejectProjection('behavior-digest-mismatch')
  }
  const { envelopeDigest: _digest, ...envelopeBody } = input.envelope
  if (input.envelope.envelopeDigest !== input.expectedEnvelopeDigest
      || input.envelope.envelopeDigest !== digestRunnerJson(envelopeBody)) {
    return rejectProjection('envelope-digest-mismatch')
  }
  if (!uninterruptedCompletion(input.result)) {
    return rejectProjection('result-not-uninterrupted-completion')
  }
  if (!noToolState(input.result)) return rejectProjection('result-not-no-tool')
  if (unsupportedStateExtension(input.result)) {
    return rejectProjection('result-state-extension-unsupported')
  }
  const terminal = input.result.events.at(-1)
  if (input.envelope.source.runId !== input.result.state.runId
      || input.envelope.source.stateRevision !== input.result.state.revision
      || input.envelope.source.terminalEventSequence !== terminal?.sequence) {
    return rejectProjection('source-binding-mismatch')
  }
  if (!Array.isArray(input.envelope.preparedInput)
      || input.envelope.preparedInput.length !== input.result.state.input.length) {
    return rejectProjection('message-count-mismatch')
  }
  const allEntries = [...input.envelope.preparedInput, input.envelope.finalAssistant]
  if (allEntries.some((entry, index) => !validEnvelopeEntry(entry, index))
      || input.envelope.finalAssistant.role !== 'ai') {
    return rejectProjection('message-envelope-malformed')
  }
  const inputBound = input.envelope.preparedInput.every((entry, index) => {
    const item = input.result.state.input[index]
    return item?.type === 'message' && boundEntry(entry, item)
  })
  const finalItem = terminalFinalItem(input.result)
  if (!inputBound || finalItem === undefined
      || input.result.state.committedItems.length !== 1
      || !boundEntry(input.envelope.finalAssistant, finalItem)) {
    return rejectProjection('message-binding-mismatch')
  }

  const completed = projectLegacyCompletedRunnerResult({
    profile: input.profile,
    expectedProfileDigest: input.expectedProfileDigest,
    expectedBehaviorDigest: input.expectedBehaviorDigest,
    result: input.result,
  })
  if (completed.status !== 'projected' || completed.report.outcome !== 'completed') {
    return rejectProjection('completed-result-evidence-inexact')
  }
  const usageInput = exactField(completed.report, 'usage.totalInputTokens')
  const usageOutput = exactField(completed.report, 'usage.totalOutputTokens')
  const llmCalls = exactField(completed.report, 'usage.llmCalls')
  if (typeof usageInput !== 'number' || typeof usageOutput !== 'number'
      || typeof llmCalls !== 'number'
      || exactField(completed.report, 'hitIterationLimit') !== false
      || exactField(completed.report, 'stopReason') !== 'complete'
      || !same(exactField(completed.report, 'toolStats'), [])
      || !allOptionalAbsencesExact(completed.report)) {
    return rejectProjection('completed-result-evidence-inexact')
  }
  const messageUsage = input.envelope.finalAssistant.usageMetadata
  if (messageUsage !== undefined
      && (messageUsage.input_tokens !== usageInput
        || messageUsage.output_tokens !== usageOutput
        || messageUsage.total_tokens !== usageInput + usageOutput)) {
    return rejectProjection('completed-result-evidence-inexact')
  }

  const messages = allEntries.map(reconstruct)
  const finalContent = input.envelope.finalAssistant.content
  const result: GenerateResult = {
    content: finalContent.encoding === 'string'
      ? finalContent.value
      : JSON.stringify(finalContent.value),
    messages,
    usage: {
      totalInputTokens: usageInput,
      totalOutputTokens: usageOutput,
      llmCalls,
    },
    hitIterationLimit: false,
    stopReason: 'complete',
    toolStats: [],
  }
  const resultBody = {
    content: result.content,
    messages: allEntries.map(({ index, role, content }) => ({ index, role, content })),
    usage: result.usage,
    hitIterationLimit: result.hitIterationLimit,
    stopReason: result.stopReason,
    toolStats: result.toolStats,
  }
  return {
    status: 'projected',
    result,
    report: {
      schema: LEGACY_NO_TOOL_RESULT_ENVELOPE_SCHEMA,
      projectorId: LEGACY_NO_TOOL_RESULT_PROJECTOR_ID,
      profileDigest: input.profile.profileDigest,
      behaviorDigest: input.expectedBehaviorDigest,
      envelopeDigest: input.envelope.envelopeDigest,
      source: input.envelope.source,
      fullGenerateResultCompatible: true,
      resultDigest: digestRunnerJson(resultBody),
    },
  }
}
