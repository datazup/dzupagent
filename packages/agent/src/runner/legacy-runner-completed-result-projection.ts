import type {
  AgentItem,
  AgentRunEventEnvelope,
  AgentRunJsonValue,
  AgentRunStateV2,
  AgentToolCallItem,
  AgentToolResultItem,
} from '@dzupagent/agent-types/run'
import { AGENT_RUN_EVENT_SCHEMA, AGENT_RUN_STATE_SCHEMA } from '@dzupagent/agent-types/run'

import type { AgentRunnerResult } from './in-memory-agent-runner.js'
import { assertDurableJson, digestRunnerJson } from './runner-values.js'
import {
  evaluateRunnerProviderFreeExecutionProfile,
  type LegacyRunnerExecutionProfile,
} from './legacy-runner-execution-profile.js'

export const LEGACY_COMPLETED_RESULT_PROJECTION_SCHEMA =
  'dzupagent.legacyCompletedResultProjection/v1' as const
export const LEGACY_COMPLETED_RESULT_PROJECTOR_ID =
  'legacy-completed-result-read-profile/v1' as const

export type LegacyGenerateResultField =
  | 'content'
  | 'messages'
  | 'usage.totalInputTokens'
  | 'usage.totalOutputTokens'
  | 'usage.llmCalls'
  | 'hitIterationLimit'
  | 'stopReason'
  | 'toolStats'
  | 'stuckError'
  | 'learnings'
  | 'memoryFrame'
  | 'compressionLog'
  | 'suspended'

export type LegacyResultFieldReason =
  | 'exact-retained-value'
  | 'disabled-obligation-absent'
  | 'terminal-completion-excludes-field'
  | 'legacy-message-envelope-unrepresented'
  | 'legacy-tool-timing-unrepresented'
  | 'usage-measurement-incomplete'
  | 'structured-output-content-different'
  | 'final-content-representation-unsupported'
  | 'runner-context-not-legacy-memory'
  | 'runner-outcome-not-legacy-result'

export interface LegacyResultFieldDecision {
  readonly field: LegacyGenerateResultField
  readonly status: 'exact' | 'different' | 'unsupported'
  readonly reason: LegacyResultFieldReason
  readonly value?: AgentRunJsonValue
}

export interface LegacyCompletedTextItem {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export interface LegacyCompletedReadObservation {
  readonly callId: string
  readonly toolId: string
  readonly arguments: AgentRunJsonValue
  readonly result: AgentRunJsonValue
}

export interface LegacyCompletedResultExactSubset {
  readonly content: string
  readonly orderedTextItems: readonly LegacyCompletedTextItem[]
  readonly reads: readonly LegacyCompletedReadObservation[]
  readonly usage: {
    readonly totalInputTokens: number
    readonly totalOutputTokens: number
    readonly llmCalls: number
  }
  readonly hitIterationLimit: false
  readonly stopReason: 'complete'
}

export type LegacyCompletedRunnerOutcome =
  | 'completed'
  | 'completed-after-suspension'
  | 'cancelled'
  | 'failed-known'
  | 'failed-unknown'
  | 'suspended'
  | 'active'

export interface LegacyCompletedResultProjectionReport {
  readonly schema: typeof LEGACY_COMPLETED_RESULT_PROJECTION_SCHEMA
  readonly projectorId: typeof LEGACY_COMPLETED_RESULT_PROJECTOR_ID
  readonly profileId: LegacyRunnerExecutionProfile['profileId']
  readonly profileDigest: string
  readonly behaviorDigest: string
  readonly source: {
    readonly runId: string
    readonly stateRevision: number
    readonly terminalEventSequence: number
  }
  readonly outcome: LegacyCompletedRunnerOutcome
  readonly fields: readonly LegacyResultFieldDecision[]
  readonly exactSubset?: LegacyCompletedResultExactSubset
  readonly fullGenerateResultCompatible: false
  readonly reportDigest: string
}

export type LegacyCompletedResultProjectionRejectionCode =
  | 'input-not-json-safe'
  | 'profile-ineligible'
  | 'profile-digest-mismatch'
  | 'profile-state-binding-mismatch'
  | 'result-malformed'
  | 'state-schema-mismatch'
  | 'behavior-digest-mismatch'
  | 'event-malformed'
  | 'event-identity-mismatch'
  | 'event-order-invalid'
  | 'event-state-mismatch'
  | 'terminal-event-invalid'
  | 'model-lifecycle-invalid'
  | 'item-custody-invalid'

export type LegacyCompletedResultProjection =
  | { readonly status: 'projected'; readonly report: LegacyCompletedResultProjectionReport }
  | {
      readonly status: 'rejected'
      readonly reasons: readonly LegacyCompletedResultProjectionRejectionCode[]
    }

export interface LegacyCompletedResultProjectionInput {
  readonly profile: LegacyRunnerExecutionProfile
  readonly expectedProfileDigest: string
  readonly expectedBehaviorDigest: string
  readonly result: AgentRunnerResult
}

const EVENT_TYPES = new Set([
  'run.started', 'run.suspended', 'run.resumed', 'run.completed', 'run.failed',
  'run.cancelled', 'agent.activated', 'agent.deactivated', 'model.requested',
  'model.delta', 'model.completed', 'model.failed', 'item.added', 'item.updated',
  'handoff.proposed', 'handoff.authorized', 'handoff.committed', 'handoff.rejected',
  'tool.selected', 'tool.authorization_requested', 'tool.started', 'tool.output_delta',
  'tool.completed', 'tool.failed', 'guardrail.evaluated', 'interaction.requested',
  'interaction.resolved', 'interaction.expired', 'usage.recorded', 'budget.updated',
  'session.commit_requested', 'session.committed', 'session.conflicted',
])

function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function reject(
  ...reasons: LegacyCompletedResultProjectionRejectionCode[]
): LegacyCompletedResultProjection {
  return { status: 'rejected', reasons: [...new Set(reasons)] }
}

function field(
  fieldName: LegacyGenerateResultField,
  status: LegacyResultFieldDecision['status'],
  reason: LegacyResultFieldReason,
  value?: AgentRunJsonValue,
): LegacyResultFieldDecision {
  return value === undefined
    ? { field: fieldName, status, reason }
    : { field: fieldName, status, reason, value }
}

function assertStateShape(value: unknown): value is AgentRunStateV2 {
  return object(value)
    && typeof value.runId === 'string'
    && typeof value.revision === 'number'
    && typeof value.nextEventSeq === 'number'
    && typeof value.status === 'string'
    && object(value.agent)
    && typeof value.agent.behaviorDigest === 'string'
    && Array.isArray(value.input)
    && Array.isArray(value.committedItems)
    && Array.isArray(value.invocations)
    && object(value.usage)
    && Array.isArray(value.usage.records)
}

function assertEventShape(value: unknown): value is AgentRunEventEnvelope {
  return object(value)
    && value.schema === AGENT_RUN_EVENT_SCHEMA
    && typeof value.runId === 'string'
    && typeof value.eventId === 'string'
    && typeof value.sequence === 'number'
    && typeof value.stateRevision === 'number'
    && typeof value.attempt === 'number'
    && typeof value.occurredAt === 'string'
    && typeof value.type === 'string'
    && EVENT_TYPES.has(value.type)
    && 'payload' in value
}

function validateEventCustody(
  state: AgentRunStateV2,
  events: readonly AgentRunEventEnvelope[],
): readonly LegacyCompletedResultProjectionRejectionCode[] {
  const reasons: LegacyCompletedResultProjectionRejectionCode[] = []
  const eventIds = new Set<string>()
  for (const [index, event] of events.entries()) {
    if (!assertEventShape(event)) {
      reasons.push('event-malformed')
      continue
    }
    if (event.runId !== state.runId || event.attempt !== state.attempt.number || eventIds.has(event.eventId)) {
      reasons.push('event-identity-mismatch')
    }
    eventIds.add(event.eventId)
    if (event.sequence !== index || event.stateRevision !== index + 1) {
      reasons.push('event-order-invalid')
    }
  }
  if (state.nextEventSeq !== events.length || state.revision !== events.length) {
    reasons.push('event-state-mismatch')
  }
  return reasons
}

function eventPayload(event: AgentRunEventEnvelope | undefined): Readonly<Record<string, unknown>> {
  return object(event?.payload) ? event.payload : {}
}

function outcome(state: AgentRunStateV2, events: readonly AgentRunEventEnvelope[]): LegacyCompletedRunnerOutcome {
  if (state.status === 'completed') {
    return events.some((event) => event.type === 'run.suspended')
      ? 'completed-after-suspension'
      : 'completed'
  }
  if (state.status === 'cancelled') return 'cancelled'
  if (state.status === 'suspended' || state.status === 'suspending') return 'suspended'
  if (state.status === 'failed') {
    const modelFailure = eventPayload(events.findLast((event) => event.type === 'model.failed'))
    const unknown = state.invocations.some((invocation) => invocation.state === 'effect-unknown')
      || modelFailure.outcome === 'outcome-unknown'
    return unknown ? 'failed-unknown' : 'failed-known'
  }
  return 'active'
}

function completedModelEvents(
  events: readonly AgentRunEventEnvelope[],
): readonly AgentRunEventEnvelope[] | undefined {
  const requested = events.filter((event) => event.type === 'model.requested')
  const completed = events.filter((event) => event.type === 'model.completed')
  if (requested.length === 0 || requested.length !== completed.length) return undefined
  const requestedIds = requested.map((event) => eventPayload(event).requestId)
  const completedIds = completed.map((event) => eventPayload(event).requestId)
  if (requestedIds.some((id) => typeof id !== 'string')
      || new Set(requestedIds).size !== requestedIds.length
      || requestedIds.some((id, index) => id !== completedIds[index])) return undefined
  if (events.some((event) => event.type === 'model.failed')) return undefined
  return completed
}

function measuredUsage(
  state: AgentRunStateV2,
  events: readonly AgentRunEventEnvelope[],
  completed: readonly AgentRunEventEnvelope[],
): { readonly input: number; readonly output: number } | undefined {
  const usageIds = completed.map((event) => eventPayload(event).usageId)
  if (usageIds.some((id) => typeof id !== 'string')
      || new Set(usageIds).size !== usageIds.length
      || state.usage.records.length !== usageIds.length) return undefined
  const recordedIds = events
    .filter((event) => event.type === 'usage.recorded')
    .map((event) => eventPayload(event).usageId)
  if (recordedIds.length !== usageIds.length
      || recordedIds.some((id, index) => id !== usageIds[index])) return undefined
  const records = new Map(state.usage.records.map((record) => [record.usageId, record]))
  const ordered = usageIds.map((id) => records.get(String(id)))
  if (ordered.some((record) => record === undefined
      || record.source !== 'model'
      || !Number.isSafeInteger(record.inputTokens)
      || !Number.isSafeInteger(record.outputTokens))) return undefined
  return {
    input: ordered.reduce((sum, record) => sum + (record?.inputTokens ?? 0), 0),
    output: ordered.reduce((sum, record) => sum + (record?.outputTokens ?? 0), 0),
  }
}

function text(item: AgentItem): LegacyCompletedTextItem | undefined {
  if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) return undefined
  if (item.providerRef !== undefined || item.content.some((block) => block.type !== 'text')) return undefined
  return { role: item.role, text: item.content.map((block) => block.type === 'text' ? block.text : '').join('') }
}

function transcript(state: AgentRunStateV2): {
  readonly orderedTextItems: readonly LegacyCompletedTextItem[]
  readonly reads: readonly LegacyCompletedReadObservation[]
} | undefined {
  const items = [...state.input, ...state.committedItems]
  const textItems = items.filter(
    (item) => item.type === 'message' && (item.role === 'user' || item.role === 'assistant'),
  )
  const orderedTextItems = textItems.map(text)
  if (orderedTextItems.some((item) => item === undefined)) return undefined
  const results = new Map(state.committedItems
    .filter((item): item is AgentToolResultItem => item.type === 'tool-result' && !item.isError)
    .map((item) => [item.callId, item.output] as const))
  const calls = state.committedItems.filter(
    (item): item is AgentToolCallItem => item.type === 'tool-call',
  )
  const reads = calls.map((call) => {
    const result = results.get(call.callId)
    return result === undefined ? undefined : {
      callId: call.callId,
      toolId: call.toolId,
      arguments: call.arguments,
      result: result as AgentRunJsonValue,
    }
  })
  if (reads.some((read) => read === undefined)) return undefined
  return {
    orderedTextItems: orderedTextItems as LegacyCompletedTextItem[],
    reads: reads as LegacyCompletedReadObservation[],
  }
}

function finalContent(
  state: AgentRunStateV2,
  terminal: AgentRunEventEnvelope,
): string | undefined {
  const finalItemId = eventPayload(terminal).finalItemId
  const finalItem = state.committedItems.find((item) => item.itemId === finalItemId)
  if (finalItem?.type !== 'message' || finalItem.role !== 'assistant'
      || finalItem.providerRef !== undefined
      || finalItem.content.length === 0
      || finalItem.content.some((block) => block.type !== 'text')) return undefined
  return finalItem.content.map((block) => block.type === 'text' ? block.text : '').join('')
}

function unsupportedOutcomeFields(): readonly LegacyResultFieldDecision[] {
  return [
    'content', 'messages', 'usage.totalInputTokens', 'usage.totalOutputTokens',
    'usage.llmCalls', 'hitIterationLimit', 'stopReason', 'toolStats', 'stuckError',
    'learnings', 'memoryFrame', 'compressionLog', 'suspended',
  ].map((name) => field(
    name as LegacyGenerateResultField,
    'unsupported',
    'runner-outcome-not-legacy-result',
  ))
}

export function projectLegacyCompletedRunnerResult(
  input: LegacyCompletedResultProjectionInput,
): LegacyCompletedResultProjection {
  try {
    assertDurableJson(input)
  } catch {
    return reject('input-not-json-safe')
  }
  const eligibility = evaluateRunnerProviderFreeExecutionProfile(
    input.profile,
    input.expectedBehaviorDigest,
  )
  if (eligibility.status !== 'eligible') return reject('profile-ineligible')
  if (eligibility.profileDigest !== input.expectedProfileDigest) return reject('profile-digest-mismatch')
  if (!object(input.result) || !assertStateShape(input.result.state)
      || !Array.isArray(input.result.events)) return reject('result-malformed')
  const state = input.result.state
  if (state.schema !== AGENT_RUN_STATE_SCHEMA) return reject('state-schema-mismatch')
  if (state.agent.behaviorDigest !== input.expectedBehaviorDigest
      || input.profile.behaviorDigest !== state.agent.behaviorDigest) {
    return reject('behavior-digest-mismatch')
  }
  const structuredClaim = input.profile.claims.find(
    (claim) => claim.obligation === 'structured-output-when-requested',
  )
  const structuredBinding = object(structuredClaim?.binding)
    ? structuredClaim.binding.requested
    : undefined
  if (typeof structuredBinding !== 'boolean'
      || structuredBinding !== (state.structuredOutput !== undefined)) {
    return reject('profile-state-binding-mismatch')
  }
  const malformed = input.result.events.some((event) => !assertEventShape(event))
  if (malformed) return reject('event-malformed')
  const events = input.result.events as readonly AgentRunEventEnvelope[]
  const custody = validateEventCustody(state, events)
  if (custody.length > 0) return reject(...custody)

  const runnerOutcome = outcome(state, events)
  const terminal = events.at(-1)
  const expectedTerminal = state.status === 'completed' ? 'run.completed'
    : state.status === 'failed' ? 'run.failed'
      : state.status === 'cancelled' ? 'run.cancelled'
        : state.status === 'suspended' ? 'run.suspended' : undefined
  if (expectedTerminal !== undefined && terminal?.type !== expectedTerminal) {
    return reject('terminal-event-invalid')
  }

  let fields: readonly LegacyResultFieldDecision[] = unsupportedOutcomeFields()
  let exactSubset: LegacyCompletedResultExactSubset | undefined
  if (runnerOutcome === 'completed' && terminal !== undefined) {
    const completed = completedModelEvents(events)
    if (completed === undefined) return reject('model-lifecycle-invalid')
    const observed = transcript(state)
    if (observed === undefined) return reject('item-custody-invalid')
    const usage = measuredUsage(state, events, completed)
    const content = state.structuredOutput === undefined ? finalContent(state, terminal) : undefined
    const hasTools = state.invocations.length > 0
      || state.committedItems.some((item) => item.type === 'tool-call' || item.type === 'tool-result')
    fields = [
      content === undefined
        ? field('content', 'different', state.structuredOutput === undefined
          ? 'final-content-representation-unsupported' : 'structured-output-content-different')
        : field('content', 'exact', 'exact-retained-value', content),
      field('messages', 'different', 'legacy-message-envelope-unrepresented'),
      usage === undefined
        ? field('usage.totalInputTokens', 'unsupported', 'usage-measurement-incomplete')
        : field('usage.totalInputTokens', 'exact', 'exact-retained-value', usage.input),
      usage === undefined
        ? field('usage.totalOutputTokens', 'unsupported', 'usage-measurement-incomplete')
        : field('usage.totalOutputTokens', 'exact', 'exact-retained-value', usage.output),
      field('usage.llmCalls', 'exact', 'exact-retained-value', completed.length),
      field('hitIterationLimit', 'exact', 'exact-retained-value', false),
      field('stopReason', 'exact', 'exact-retained-value', 'complete'),
      hasTools
        ? field('toolStats', 'unsupported', 'legacy-tool-timing-unrepresented')
        : field('toolStats', 'exact', 'exact-retained-value', []),
      field('stuckError', 'exact', 'terminal-completion-excludes-field'),
      field('learnings', 'exact', 'disabled-obligation-absent'),
      state.context.state === 'absent'
        ? field('memoryFrame', 'exact', 'disabled-obligation-absent')
        : field('memoryFrame', 'unsupported', 'runner-context-not-legacy-memory'),
      field('compressionLog', 'exact', 'disabled-obligation-absent'),
      field('suspended', 'exact', 'terminal-completion-excludes-field'),
    ]
    if (content !== undefined && usage !== undefined) {
      exactSubset = {
        content,
        ...observed,
        usage: {
          totalInputTokens: usage.input,
          totalOutputTokens: usage.output,
          llmCalls: completed.length,
        },
        hitIterationLimit: false,
        stopReason: 'complete',
      }
    }
  }

  const body = {
    schema: LEGACY_COMPLETED_RESULT_PROJECTION_SCHEMA,
    projectorId: LEGACY_COMPLETED_RESULT_PROJECTOR_ID,
    profileId: input.profile.profileId,
    profileDigest: input.profile.profileDigest,
    behaviorDigest: state.agent.behaviorDigest,
    source: {
      runId: state.runId,
      stateRevision: state.revision,
      terminalEventSequence: terminal?.sequence ?? -1,
    },
    outcome: runnerOutcome,
    fields,
    ...(exactSubset === undefined ? {} : { exactSubset }),
    fullGenerateResultCompatible: false as const,
  }
  const report: LegacyCompletedResultProjectionReport = {
    ...body,
    reportDigest: digestRunnerJson(body),
  }
  return { status: 'projected', report }
}
