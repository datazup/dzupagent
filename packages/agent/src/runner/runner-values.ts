import { createHash } from 'node:crypto'

import type {
  AiExecutionCancellationAcknowledgement,
  AiExecutionCancellationRequest,
  AiExecutionInteractionAcknowledgement,
  AiExecutionInteractionSubmission,
} from '@dzupagent/adapter-types'
import {
  AI_EXECUTION_RECEIPT_V2_SCHEMA,
  AI_RESOLVED_TARGET_SCHEMA,
  validateAiExecutionBinding,
  validateAiExecutionRequest,
  validateAiExecutionTranscript,
  type AiExecutionBinding,
  type AiExecutionDiagnostic,
  type AiExecutionEvent,
  type AiExecutionReceiptV2,
  type AiExecutionRequest,
  type AiJsonValue,
  type AiResolvedTargetSnapshot,
  type AiUsageTruthV2,
} from '@dzupagent/runtime-contracts/ai-execution'
import {
  materializeAiRouteDecisionBinding,
  validateAiExecutionBindingDigest,
  validateAiExecutionReceiptCustody,
  validateAiResolvedTargetSnapshotDigest,
} from '@dzupagent/runtime-contracts/ai-execution/node'
import {
  validateExecutionRouteDecision,
  type ExecutionRouteDecision,
  type ExecutionResult,
} from '@dzupagent/runtime-contracts'
import type {
  AgentInteractionDecisionInput,
  AgentPendingInteraction,
  AgentRunJsonValue,
  AgentRunStateV2,
} from '@dzupagent/agent-types/run'

import type { AgentRunnerInput, AgentRunnerResult } from './runner-ports.js'

export interface AgentRunnerInlineProjection {
  readonly input: AgentRunnerInput
  readonly target: AiResolvedTargetSnapshot
  readonly routeDecision: ExecutionRouteDecision
  /** Immutable catalog, route, prompt, persona, model, and target admission. */
  readonly binding: AiExecutionBinding
}

/** @internal */
export type AgentRunnerHostEventPayload =
  | { readonly type: 'started' }
  | { readonly type: 'usage'; readonly usage: AiUsageTruthV2 }
  | { readonly type: 'interaction.required'; readonly interactionRef: string }
  | { readonly type: 'completed'; readonly status: 'succeeded' | 'failed' | 'cancelled' }

/** @internal */
export type AgentRunnerInlinePhase = 'active' | 'suspended' | 'terminal'

/** @internal */
export type AgentRunnerInteractionSubmissionRecord = {
  readonly digest: string
  readonly acknowledgement: AiExecutionInteractionAcknowledgement
}

const FORBIDDEN_DURABLE_KEYS = new Set([
  'apikey', 'authorization', 'cookie', 'credential', 'credentials', 'password',
  'privatekey', 'providerclient', 'rawproviderpayload', 'refreshtoken', 'secret',
  'sessioncookie',
])

export type DurableJsonFailureCode =
  | 'cycle'
  | 'forbidden-key'
  | 'host-path'
  | 'non-finite-number'
  | 'non-json-object'
  | 'unsupported-value'

export class AgentRunnerSerializationError extends TypeError {
  readonly code: DurableJsonFailureCode
  readonly location: string

  constructor(code: DurableJsonFailureCode, location: string) {
    super(`Runner durable JSON rejected ${code} at ${location}`)
    this.name = 'AgentRunnerSerializationError'
    this.code = code
    this.location = location
  }
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, '').toLowerCase()
}

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith('/') || /^[a-z]:[\\/]/iu.test(value) || value.startsWith('\\\\')
}

function assertDurableValue(value: unknown, location: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && isAbsoluteHostPath(value)) {
      throw new AgentRunnerSerializationError('host-path', location)
    }
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AgentRunnerSerializationError('non-finite-number', location)
    return
  }
  if (typeof value !== 'object') throw new AgentRunnerSerializationError('unsupported-value', location)
  if (ancestors.has(value)) throw new AgentRunnerSerializationError('cycle', location)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => assertDurableValue(entry, `${location}[${index}]`, ancestors))
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AgentRunnerSerializationError('non-json-object', location)
    }
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_DURABLE_KEYS.has(normalizedKey(key))) {
        throw new AgentRunnerSerializationError('forbidden-key', `${location}.${key}`)
      }
      assertDurableValue(entry, `${location}.${key}`, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

export function assertDurableJson(value: unknown): void {
  assertDurableValue(value, '$', new Set())
}

export function cloneDurableJson<T>(value: T): T {
  assertDurableJson(value)
  return JSON.parse(JSON.stringify(value)) as T
}

function stableJson(value: AgentRunJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Readonly<Record<string, AgentRunJsonValue>>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key] ?? null)}`).join(',')}}`
}

/** @internal */
export function digestRunnerJson(value: unknown): string {
  assertDurableJson(value)
  return `sha256:${createHash('sha256').update(stableJson(value as AgentRunJsonValue)).digest('hex')}`
}

/** @internal */
export class AgentRunnerInlineError extends TypeError {
  readonly code: string
  readonly diagnostics: readonly AiExecutionDiagnostic[]

  constructor(code: string, diagnostics: readonly AiExecutionDiagnostic[]) {
    super(`Inline AgentRunner rejected ${code}`)
    this.name = 'AgentRunnerInlineError'
    this.code = code
    this.diagnostics = diagnostics
  }
}

function diagnostic(code: AiExecutionDiagnostic['code'], path: string, message: string) {
  return { code, path, message } satisfies AiExecutionDiagnostic
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('|') === [...keys].sort().join('|')
}

function inlineToolGrantIds(value: unknown): readonly string[] | undefined {
  if (!object(value) || !Array.isArray(value.grants)) return undefined
  if (value.mode === 'none') return value.grants.length === 0 ? [] : undefined
  if (value.mode !== 'explicit') return undefined
  const toolIds: string[] = []
  for (const grant of value.grants) {
    if (!object(grant) || !exactKeys(grant, ['toolRef']) ||
        typeof grant.toolRef !== 'string' || grant.toolRef.length === 0) return undefined
    toolIds.push(grant.toolRef)
  }
  return toolIds
}

/** @internal */
export function validateAgentRunnerInlineProjection(
  request: AiExecutionRequest,
  runnerToolIds: readonly string[],
  project: () => AgentRunnerInlineProjection,
): AgentRunnerInlineProjection {
  const diagnostics = [...validateAiExecutionRequest(request).diagnostics]
  if (diagnostics.length > 0) throw new AgentRunnerInlineError('invalid-request', diagnostics)
  const execution = request.execution
  const operation = request.operation
  if (operation.kind !== 'agent.run' || execution.kind !== 'agent') {
    diagnostics.push(diagnostic('AI_EXECUTION_KIND_INCOMPATIBLE', 'execution.kind',
      'Inline AgentRunner accepts only an agent.run operation on an agent execution.'))
  } else if (operation.input.agentRef !== execution.identity?.agentId) {
    diagnostics.push(diagnostic('AI_IDENTITY_MISMATCH', 'operation.input.agentRef',
      'Operation and canonical execution agent identities must match.'))
  }
  if (execution.attempt !== 1 || execution.route?.requestId !== execution.requestId) {
    diagnostics.push(diagnostic('AI_IDENTITY_MISMATCH', 'execution',
      'Inline execution requires attempt one and a route bound to the request.'))
  }
  const allowedEffects: readonly unknown[] = [undefined, 'read', 'compute', 'llm']
  if (execution.tools?.mode === 'host-default' ||
      !allowedEffects.includes(execution.effects?.effectClass)) {
    diagnostics.push(diagnostic('AI_INVALID_VALUE', 'execution.effects',
      'Inline AgentRunner requires resolved tools and a provider-free read/compute/llm effect.'))
  }
  const grantedToolIds = inlineToolGrantIds(execution.tools)
  const configuredToolIds = [...runnerToolIds].sort()
  const sortedGrantIds = grantedToolIds === undefined ? undefined : [...grantedToolIds].sort()
  if (grantedToolIds === undefined || new Set(grantedToolIds).size !== grantedToolIds.length ||
      sortedGrantIds?.length !== configuredToolIds.length ||
      sortedGrantIds.some((toolId, index) => toolId !== configuredToolIds[index])) {
    diagnostics.push(diagnostic('AI_INVALID_VALUE', 'execution.tools',
      'Canonical tool grants must exactly match the runner tools; operation-level grants are unsupported.'))
  }
  const expectedFormat = operation.output.modality === 'unknown' ? undefined : operation.output.modality
  if (expectedFormat !== undefined && execution.output?.format !== expectedFormat) {
    diagnostics.push(diagnostic('AI_OPERATION_KIND_MISMATCH', 'execution.output.format',
      'Canonical and agent operation output modalities must match.'))
  }
  if (diagnostics.length > 0) throw new AgentRunnerInlineError('invalid-request', diagnostics)
  const projection = project()
  const projectionDiagnostics: AiExecutionDiagnostic[] = []
  try {
    assertDurableJson(projection.input)
    assertDurableJson(projection.target)
    assertDurableJson(projection.routeDecision)
    assertDurableJson(projection.binding)
  } catch {
    projectionDiagnostics.push(diagnostic('AI_INVALID_VALUE', 'projection',
      'Host projection must be credential-free durable JSON.'))
  }
  if (projection.input.agentId !== (execution.kind === 'agent' ? execution.identity.agentId : '') ||
      projection.input.behaviorDigest.length === 0 || projection.input.sessionId === '') {
    projectionDiagnostics.push(diagnostic('AI_IDENTITY_MISMATCH', 'projection.input',
      'Projected runner identity, behavior digest, and optional session must be valid.'))
  }
  projectionDiagnostics.push(...validateExecutionRouteDecision(execution.route, projection.routeDecision)
    .diagnostics.map((item) => diagnostic('AI_INVALID_VALUE', `projection.routeDecision.${item.path}`, item.message)))
  if (projection.routeDecision.selectedCandidateId === null ||
      projection.routeDecision.selectedCandidateId !== projection.target.routeCandidateId ||
      projection.target.schema !== AI_RESOLVED_TARGET_SCHEMA ||
      projection.target.operation !== 'agent.run' || projection.target.executionStyle !== 'inline' ||
      (request.target.kind === 'target-id' && request.target.targetId !== projection.target.targetId)) {
    projectionDiagnostics.push(diagnostic('AI_ROUTE_TARGET_MISMATCH', 'projection.target',
      'Resolved inline target must match the host route decision and requested operation.'))
  }
  projectionDiagnostics.push(...validateAiResolvedTargetSnapshotDigest(projection.target).diagnostics)
  projectionDiagnostics.push(
    ...validateAiExecutionBinding(projection.binding).diagnostics,
    ...validateAiExecutionBindingDigest(projection.binding).diagnostics,
  )
  const { reasoningSummary, ...routeDecision } = projection.routeDecision
  void reasoningSummary
  const routeBinding = routeDecision.selectedCandidateId === null
    ? undefined
    : materializeAiRouteDecisionBinding({ ...routeDecision, selectedCandidateId: routeDecision.selectedCandidateId })
  if (routeBinding === undefined ||
      digestRunnerJson(routeBinding) !== digestRunnerJson(projection.binding.routeDecision) ||
      projection.binding.target.snapshotDigest !== projection.target.snapshotDigest ||
      projection.binding.prompt.renderedPayloadDigest !== digestRunnerJson(projection.input) ||
      !projection.binding.offer.capabilities.includes('agent.run/v1')) {
    projectionDiagnostics.push(diagnostic('AI_EXECUTION_BINDING_MISMATCH', 'projection.binding',
      'Binding must match the exact route, target, rendered runner payload, and agent.run capability.'))
  }
  if (projectionDiagnostics.length > 0) {
    throw new AgentRunnerInlineError('invalid-projection', projectionDiagnostics)
  }
  return cloneDurableJson({ ...projection, routeDecision })
}

/** @internal */
export function parseAgentRunnerInlineDecision(
  submission: AiExecutionInteractionSubmission,
  interaction: AgentPendingInteraction,
  interactionRef: string,
): AgentInteractionDecisionInput {
  const payload = submission.payload
  if (!object(payload) || !exactKeys(payload, [
    'actor', 'authority', 'decision', 'schema',
  ])) throw new AgentRunnerInlineError('invalid-interaction', [])
  const actor = payload.actor
  const authority = payload.authority
  if (!object(actor) || !object(authority) || !exactKeys(actor, ['principalId', 'principalType']) ||
      !exactKeys(authority, ['reference', 'revision', 'status']) ||
      payload.schema !== 'dzupagent.inlineInteractionDecision/v1' ||
      !['approved', 'rejected'].includes(String(payload.decision)) ||
      authority.status !== 'authorized' || typeof authority.reference !== 'string' ||
      authority.reference !== interaction.decisionPolicyRef ||
      authority.revision !== interaction.decisionPolicyRevision ||
      !['user', 'service', 'agent', 'host'].includes(String(actor.principalType)) ||
      typeof actor.principalId !== 'string' || actor.principalId.length === 0 ||
      submission.interactionRef !== interactionRef) {
    throw new AgentRunnerInlineError('invalid-interaction', [])
  }
  return {
    interactionId: interaction.interactionId,
    generation: interaction.generation,
    requestDigest: interaction.requestDigest,
    stateRevision: interaction.stateRevision,
    decision: payload.decision as 'approved' | 'rejected',
    decisionPolicyRef: interaction.decisionPolicyRef,
    decisionPolicyRevision: interaction.decisionPolicyRevision,
    actor: {
      principalId: actor.principalId,
      principalType: actor.principalType as AgentInteractionDecisionInput['actor']['principalType'],
    },
  }
}

/** @internal */
export class BoundedAgentRunnerEventQueue implements AsyncIterable<AiExecutionEvent> {
  readonly #values: AiExecutionEvent[] = []
  readonly #waiters: Array<{ resolve: (value: IteratorResult<AiExecutionEvent>) => void; reject: (error: unknown) => void }> = []
  #done = false
  #error: unknown

  [Symbol.asyncIterator](): AsyncIterator<AiExecutionEvent> {
    if (this.#taken) throw new AgentRunnerInlineError('event-consumer-conflict', [])
    this.#taken = true
    return { next: () => this.#next() }
  }

  #taken = false

  push(event: AiExecutionEvent): void {
    if (this.#done) throw new AgentRunnerInlineError('event-queue-closed', [])
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) waiter.resolve({ done: false, value: cloneDurableJson(event) })
    else if (this.#values.length >= 32) throw new AgentRunnerInlineError('event-buffer-overflow', [])
    else this.#values.push(cloneDurableJson(event))
  }

  close(): void {
    this.#done = true
    this.#waiters.splice(0).forEach(({ resolve }) => resolve({ done: true, value: undefined }))
  }

  fail(error: unknown): void {
    this.#error = error
    this.#done = true
    this.#values.length = 0
    this.#waiters.splice(0).forEach(({ reject }) => reject(error))
  }

  async #next(): Promise<IteratorResult<AiExecutionEvent>> {
    const value = this.#values.shift()
    if (value !== undefined) return { done: false, value }
    if (this.#error !== undefined) throw this.#error
    if (this.#done) return { done: true, value: undefined }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
  }
}

/** @internal */
export function createAgentRunnerCancellationRejection(
  request: AiExecutionCancellationRequest,
  executionId: string,
  acknowledgedAt: string,
  reason: string,
): AiExecutionCancellationAcknowledgement {
  return { cancellationId: request.cancellationId, executionId, status: 'rejected', acknowledgedAt, reason }
}

/** @internal */
export function createAgentRunnerInteractionRejection(
  submission: AiExecutionInteractionSubmission,
  executionId: string,
  acknowledgedAt: string,
  reason: string,
): AiExecutionInteractionAcknowledgement {
  return {
    executionId, interactionRef: submission.interactionRef,
    submissionId: submission.submissionId, status: 'rejected', acknowledgedAt, reason,
  }
}

/** @internal */
export function agentRunnerInlineErrorCode(
  error: unknown,
  result?: AgentRunnerResult,
  fallback = 'projection-failed',
): string {
  const failed = result?.events.findLast((event) => event.type === 'run.failed')
  const payload = failed?.payload
  const candidate = object(payload) && typeof payload.code === 'string'
    ? payload.code : error instanceof AgentRunnerInlineError ? error.code : fallback
  return /^[a-z0-9][a-z0-9._-]{0,79}$/u.test(candidate) ? candidate : 'inline-runner-failed'
}

/** @internal */
export function createAgentRunnerInteractionRef(
  executionId: string,
  result: AgentRunnerResult,
  interaction: AgentPendingInteraction,
): string {
  return `interaction:${digestRunnerJson({
    executionId, runId: result.state.runId, interactionId: interaction.interactionId,
    generation: interaction.generation, requestDigest: interaction.requestDigest,
  })}`
}

/** @internal */
export function projectAgentRunnerUsage(state: AgentRunStateV2 | undefined): AiUsageTruthV2 {
  const records = state?.usage.records ?? []
  if (records.length === 0 || records.some((record) =>
    record.inputTokens === undefined || record.outputTokens === undefined)) {
    return { measurement: 'unknown', cost: { status: 'unknown', reason: 'no-tariff' } }
  }
  const sum = (field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') =>
    records.reduce((total, record) => total + (record[field] ?? 0), 0)
  return {
    measurement: 'known',
    tokens: {
      input: sum('inputTokens'), output: sum('outputTokens'),
      ...(records.some(({ cacheReadTokens }) => cacheReadTokens !== undefined)
        ? { cachedInput: sum('cacheReadTokens') } : {}),
      ...(records.some(({ cacheWriteTokens }) => cacheWriteTokens !== undefined)
        ? { cacheWrite: sum('cacheWriteTokens') } : {}),
    },
    cost: { status: 'unknown', reason: 'no-tariff' },
  }
}

function outputFor(request: AiExecutionRequest, result: AgentRunnerResult): unknown {
  const message = [...result.state.committedItems].reverse().find((item) =>
    item.type === 'message' && item.role === 'assistant')
  if (message?.type !== 'message') throw new AgentRunnerInlineError('output-projection-failed', [])
  if (request.operation.kind !== 'agent.run' || request.operation.output.modality === 'unknown') return message
  const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
  if (request.operation.output.modality === 'text') return text
  const extension = message.content.length === 1 && message.content[0]?.type === 'extension'
    ? message.content[0].value : undefined
  const output = extension ?? JSON.parse(text) as AiJsonValue
  assertDurableJson(output)
  return output
}

/** @internal */
export function createAgentRunnerInlineReceipt(input: {
  readonly request: AiExecutionRequest
  readonly projection: AgentRunnerInlineProjection
  readonly result?: AgentRunnerResult
  readonly events: readonly AiExecutionEvent[]
  readonly status: 'succeeded' | 'failed' | 'cancelled'
  readonly errorCode?: string
  readonly startedAt: string
  readonly completedAt: string
  readonly frameworkStarted: boolean
}): AiExecutionReceiptV2 {
  const usage = projectAgentRunnerUsage(input.result?.state)
  const canonicalUsage = usage.measurement === 'known'
    ? { inputTokens: usage.tokens.input, outputTokens: usage.tokens.output } : undefined
  const base = {
    schema: 'dzupagent.executionResult/v1' as const,
    requestId: input.request.execution.requestId,
    correlationId: input.request.execution.correlationId,
    routeDecision: input.projection.routeDecision,
    evidence: [], artifacts: [],
    ...(canonicalUsage === undefined ? {} : { usage: canonicalUsage }),
  }
  let result: ExecutionResult
  if (input.status === 'succeeded') {
    if (input.result === undefined) throw new AgentRunnerInlineError('result-missing', [])
    result = { ...base, status: 'succeeded', output: outputFor(input.request, input.result) }
  } else {
    result = { ...base, status: input.status, errorCode: input.errorCode ?? 'inline-runner-failed',
      errorMessage: `Inline AgentRunner ${input.status}` }
  }
  const receipt: AiExecutionReceiptV2 = {
    schema: AI_EXECUTION_RECEIPT_V2_SCHEMA,
    requestId: input.request.execution.requestId,
    correlationId: input.request.execution.correlationId,
    operation: 'agent.run', requestedTarget: input.request.target,
    binding: input.projection.binding,
    target: input.projection.target,
    attempts: [{
      attempt: 1, binding: input.projection.binding, target: input.projection.target,
      dispatch: { status: input.frameworkStarted ? 'terminal' : 'not-dispatched' },
      usage, startedAt: input.startedAt, completedAt: input.completedAt,
    }],
    result, usage, terminalEventSequence: input.events.at(-1)?.sequence ?? 0,
    completedAt: input.completedAt,
  }
  const diagnostics = [
    ...validateAiExecutionTranscript(receipt, input.events).diagnostics,
    ...validateAiExecutionReceiptCustody(receipt).diagnostics,
  ]
  if (diagnostics.length > 0) throw new AgentRunnerInlineError('receipt-invalid', diagnostics)
  assertDurableJson(receipt)
  return cloneDurableJson(receipt)
}
