/**
 * Coordination attempt continuity (MVP-04-CP06).
 *
 * Decides how a runtime alignment update reaches a running attempt, proves its
 * delivery, and verifies a continuation that restarts a fenced attempt from
 * its checkpoint.
 *
 * Rules:
 * - An update that changes source, scope, authority or the provider binding
 *   always restarts the attempt, even when the provider could be steered.
 * - Otherwise the update goes through the native channel the plan's binding
 *   declares (`steer` or `interaction`); without one, it restarts.
 * - Silence is not acknowledgement: only `{ kind: 'steer', accepted: true }`
 *   or `respondInteraction(...) === true` acknowledges. A missing method, a
 *   throw or any other answer requires a restart. There is no retry, no other
 *   channel and no emulation: an update is never re-sent as a prompt.
 * - A continuation opens a new binding and session. It carries the
 *   predecessor's checkpoint as a `predecessor_checkpoint` context item,
 *   whose `handoffDigest` must hold under the producer rule, and never a
 *   provider transcript. It is a new attempt, or the same attempt sealed at
 *   a higher generation than that checkpoint (MVP-04 case 10); the result
 *   names the lineage and both generations.
 * - Results carry no instruction, provider text or error message.
 *
 * Admission: workspace-docs doc-coord-mvp04-cp06-admit-20260924-r1/ADMISSION.md §3;
 * same-attempt lineage: doc-coord-mvp05-cp05f-admit-20260925-r1/ADMISSION.md §4.
 */
import type {
  CoordinationAssignmentDiagnostic,
  CoordinationAttemptExecutionPlan,
  CoordinationExecutionProviderId,
  CoordinationPlanContextItem,
  CoordinationSha256Digest,
} from '@dzupagent/adapter-types'
import type { ProviderSessionAdapter } from '@dzupagent/adapter-types/provider-session'
import {
  PROVIDER_SESSION_OPERATION_SCHEMA,
  PROVIDER_SESSION_REFERENCE_SCHEMA,
  type ProviderSessionRef,
  type ProviderSessionSteerRequest,
} from '@dzupagent/runtime-contracts/provider-session'

import {
  compareCoordinationTimestamps,
  coordinationCanonicalDigest,
  coordinationSelfDigest,
  isCoordinationTimestamp,
} from './coordination-assignment-decoder.js'
import { renderCoordinationAgentExecutionRequest } from './coordination-attempt-execution.js'
import {
  COORDINATION_ATTEMPT_CORRELATION_SCHEMA,
  type CoordinationAttemptCorrelation,
} from './coordination-attempt-runner.js'

export const COORDINATION_ALIGNMENT_UPDATE_SCHEMA = 'dzupagent.coordinationAlignmentUpdate/v1' as const
export const COORDINATION_ALIGNMENT_DECISION_SCHEMA = 'dzupagent.coordinationAlignmentDecision/v1' as const
export const COORDINATION_ALIGNMENT_DELIVERY_SCHEMA = 'dzupagent.coordinationAlignmentDelivery/v1' as const
export const COORDINATION_CONTINUATION_SCHEMA = 'dzupagent.coordinationContinuation/v2' as const

/** The producer's checkpoint schemas (`dzupagent-orchestration` `coordination-execution.ts`). */
export const COORDINATION_CHECKPOINT_HANDOFF_SCHEMAS = Object.freeze([
  'datazup.coordination.checkpoint-handoff/v1',
  'datazup.coordination.checkpoint-handoff/v2',
] as const)

export const COORDINATION_ALIGNMENT_CHANGES = Object.freeze([
  'source',
  'scope',
  'authority',
  'provider-binding',
] as const)

export type CoordinationAlignmentChange = (typeof COORDINATION_ALIGNMENT_CHANGES)[number]
export type CoordinationAlignmentKind = 'steer' | 'interaction-response'
export type CoordinationAlignmentChannel = 'native-steer' | 'native-interaction' | 'restart'

export type CoordinationAlignmentRestartReason =
  | 'ALIGNMENT_CHANGES_BINDING_FACTS'
  | 'NATIVE_STEER_UNSUPPORTED'
  | 'NATIVE_INTERACTION_UNSUPPORTED'

/** A runtime update the controller wants one running attempt to take in. */
export interface CoordinationAlignmentUpdate {
  readonly schema: typeof COORDINATION_ALIGNMENT_UPDATE_SCHEMA
  readonly updateId: string
  readonly attemptId: string
  readonly kind: CoordinationAlignmentKind
  /** Binding facts the update changes. Any change forces a restart. */
  readonly changes: readonly CoordinationAlignmentChange[]
  /** What the provider is told. Never stored in a decision or delivery. */
  readonly instruction: string
  /** The pending interaction; present exactly for `interaction-response`. */
  readonly interactionId?: string
}

export interface CoordinationAlignmentDecision {
  readonly schema: typeof COORDINATION_ALIGNMENT_DECISION_SCHEMA
  readonly planDigest: CoordinationSha256Digest
  readonly attemptId: string
  /** The execution binding that issued the plan's execution fact. */
  readonly bindingId: string
  /** The provider-session attempt binding a native call must be made on. */
  readonly providerSessionBindingId: string
  readonly providerId: CoordinationExecutionProviderId
  readonly updateId: string
  readonly updateDigest: CoordinationSha256Digest
  readonly kind: CoordinationAlignmentKind
  readonly channel: CoordinationAlignmentChannel
  readonly reasonCode: CoordinationAlignmentRestartReason | null
  readonly interactionId: string | null
  /** Self-digest of the decision without this field. */
  readonly decisionDigest: CoordinationSha256Digest
}

export type CoordinationAlignmentDecisionResult =
  | { readonly ok: true; readonly decision: CoordinationAlignmentDecision }
  | { readonly ok: false; readonly refusals: readonly CoordinationAssignmentDiagnostic[] }

/** Where a native delivery goes. Only the member the channel needs is read. */
export interface CoordinationAlignmentTarget {
  readonly session?: ProviderSessionAdapter | undefined
  readonly providerSession?: ProviderSessionRef | undefined
  readonly interactions?: {
    respondInteraction?(interactionId: string, answer: string): boolean
  } | undefined
}

export type CoordinationAlignmentDeliveryStatus = 'acknowledged' | 'restart-required'

export interface CoordinationAlignmentDelivery {
  readonly schema: typeof COORDINATION_ALIGNMENT_DELIVERY_SCHEMA
  readonly decisionDigest: CoordinationSha256Digest
  readonly updateId: string
  readonly channel: CoordinationAlignmentChannel
  readonly status: CoordinationAlignmentDeliveryStatus
  readonly reasonCode: CoordinationAlignmentRestartReason | 'ALIGNMENT_UNACKNOWLEDGED' | null
  /** Self-digest of the delivery without this field. */
  readonly deliveryDigest: CoordinationSha256Digest
}

export type CoordinationAlignmentDeliveryResult =
  | { readonly ok: true; readonly delivery: CoordinationAlignmentDelivery }
  | { readonly ok: false; readonly refusals: readonly CoordinationAssignmentDiagnostic[] }

export type CoordinationContinuationKind = 'restart' | 'provider-replacement'
/** A new attempt, or the fenced attempt itself sealed at a higher generation than its checkpoint. */
export type CoordinationContinuationLineage = 'new-attempt' | 'same-attempt'

export interface CoordinationContinuation {
  readonly schema: typeof COORDINATION_CONTINUATION_SCHEMA
  readonly kind: CoordinationContinuationKind
  readonly lineage: CoordinationContinuationLineage
  readonly checkpointId: string
  readonly handoffDigest: CoordinationSha256Digest
  /** The checkpoint's source; a restart after a source change differs from the continuation's. */
  readonly checkpointSourceBindingDigest: CoordinationSha256Digest
  readonly predecessorAttemptId: string
  readonly predecessorBindingId: string
  readonly predecessorProviderId: CoordinationExecutionProviderId
  /** The checkpoint's `generation`: the fenced attempt's sealed generation. */
  readonly predecessorGeneration: number
  readonly attemptId: string
  readonly bindingId: string
  readonly providerId: CoordinationExecutionProviderId
  /** The continuation plan's sealed generation (`assignment.provenance.generation`). */
  readonly generation: number
  readonly planDigest: CoordinationSha256Digest
  /** Self-digest of the continuation without this field. */
  readonly continuationDigest: CoordinationSha256Digest
}

export type CoordinationContinuationResult =
  | { readonly ok: true; readonly continuation: CoordinationContinuation }
  | { readonly ok: false; readonly refusals: readonly CoordinationAssignmentDiagnostic[] }

export interface VerifyCoordinationContinuationInput {
  /** The fenced attempt's correlation, as the host retained it. */
  readonly predecessor: CoordinationAttemptCorrelation
  /** A composer-issued plan for the new attempt. */
  readonly continuation: CoordinationAttemptExecutionPlan
}

const MAX_INSTRUCTION_LENGTH = 4096
const MAX_ID_LENGTH = 256
const UPDATE_KEYS = new Set(['schema', 'updateId', 'attemptId', 'kind', 'changes', 'instruction', 'interactionId'])
const CHECKPOINT_KEYS = [
  'schema',
  'checkpointId',
  'assignmentId',
  'assignmentDigest',
  'attemptId',
  'generation',
  'sourceBindingDigest',
  'candidate',
  'actualPathSetDigest',
  'actualPathSetArtifact',
  'evidence',
  'blockerRefs',
  'remainingWorkRefs',
  'nextAction',
  'observedStreamSequence',
  'nextStreamSequence',
  'progressState',
  'safeToResume',
  'createdAt',
  'handoffDigest',
] as const
const CORRELATION_STRING_KEYS = [
  'planDigest',
  'requestDigest',
  'assignmentDigest',
  'canonicalSeal',
  'assignmentId',
  'attemptId',
  'sessionId',
  'bindingId',
  'sessionRef',
  'providerId',
  'backend',
  'tariffRef',
] as const
const SHA256 = /^sha256:[0-9a-f]{64}$/

const issuedDecisions = new WeakSet<object>()

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Choose the channel for one update to one running attempt. Pure; never
 * throws for invalid input.
 */
export function decideCoordinationAlignment(
  plan: CoordinationAttemptExecutionPlan,
  update: CoordinationAlignmentUpdate,
): CoordinationAlignmentDecisionResult {
  const rendered = renderCoordinationAgentExecutionRequest(plan)
  if (!rendered.ok) return { ok: false, refusals: rendered.refusals }
  const checked = validUpdate(update)
  if (!checked) {
    return refused('COORD_ALIGNMENT_UPDATE_INVALID', '$update', 'Alignment update must be a closed v1 update.')
  }
  if (checked.attemptId !== plan.assignment.attemptId) {
    return refused('COORD_ALIGNMENT_ATTEMPT_MISMATCH', '$update.attemptId', 'Update is for a different attempt.')
  }

  const native = new Set<string>(plan.execution.nativeCapabilities)
  let channel: CoordinationAlignmentChannel
  let reasonCode: CoordinationAlignmentRestartReason | null = null
  if (checked.changes.length > 0) {
    channel = 'restart'
    reasonCode = 'ALIGNMENT_CHANGES_BINDING_FACTS'
  } else if (checked.kind === 'steer') {
    channel = native.has('steer') ? 'native-steer' : 'restart'
    if (channel === 'restart') reasonCode = 'NATIVE_STEER_UNSUPPORTED'
  } else {
    channel = native.has('interaction') ? 'native-interaction' : 'restart'
    if (channel === 'restart') reasonCode = 'NATIVE_INTERACTION_UNSUPPORTED'
  }

  const body: Record<string, unknown> = {
    schema: COORDINATION_ALIGNMENT_DECISION_SCHEMA,
    planDigest: plan.planDigest,
    attemptId: plan.assignment.attemptId,
    bindingId: plan.execution.provenance.issuerRef,
    providerSessionBindingId: plan.execution.provenance.scope,
    providerId: plan.execution.providerId,
    updateId: checked.updateId,
    updateDigest: coordinationCanonicalDigest(checked),
    kind: checked.kind,
    channel,
    reasonCode,
    interactionId: checked.interactionId ?? null,
  }
  body['decisionDigest'] = coordinationSelfDigest(body, 'decisionDigest')
  const decision = Object.freeze(body) as unknown as CoordinationAlignmentDecision
  issuedDecisions.add(decision)
  return Object.freeze({ ok: true as const, decision })
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Deliver one decided update through its native channel, at most once, and
 * report whether delivery was acknowledged. A restart decision calls nothing.
 */
export async function deliverCoordinationAlignment(
  decision: CoordinationAlignmentDecision,
  update: CoordinationAlignmentUpdate,
  target: CoordinationAlignmentTarget,
): Promise<CoordinationAlignmentDeliveryResult> {
  if (!isRecord(decision) || !issuedDecisions.has(decision)) {
    return refused('COORD_ALIGNMENT_DECISION_NOT_ISSUED', '$decision', 'Delivery requires a decision returned by decideCoordinationAlignment.')
  }
  const checked = validUpdate(update)
  if (!checked || coordinationCanonicalDigest(checked) !== decision.updateDigest) {
    return refused('COORD_ALIGNMENT_UPDATE_MISMATCH', '$update', 'Update is not the one the decision was made for.')
  }
  if (decision.channel === 'restart') return delivered(decision, 'restart-required', decision.reasonCode)

  if (decision.channel === 'native-steer') {
    const session = isRecord(target) ? target.session : undefined
    const providerSession = isRecord(target) ? target.providerSession : undefined
    if (!boundTo(session, decision) || !isSessionRef(providerSession)) {
      return refused('COORD_ALIGNMENT_TARGET_MISMATCH', '$target.session', 'Steer target is not bound to this attempt.')
    }
    const request: ProviderSessionSteerRequest = {
      schema: PROVIDER_SESSION_OPERATION_SCHEMA,
      operationId: decision.updateId,
      attemptBindingId: decision.providerSessionBindingId,
      kind: 'steer',
      session: providerSession,
      instruction: checked.instruction,
    }
    let acknowledged = false
    try {
      const steer = session.steer
      if (typeof steer === 'function') {
        const result: unknown = await steer.call(session, request)
        acknowledged = isRecord(result) && result['kind'] === 'steer' && result['accepted'] === true
      }
    } catch {
      acknowledged = false
    }
    return acknowledged
      ? delivered(decision, 'acknowledged', null)
      : delivered(decision, 'restart-required', 'ALIGNMENT_UNACKNOWLEDGED')
  }

  const interactions = isRecord(target) ? target.interactions : undefined
  let acknowledged = false
  try {
    const respond = isRecord(interactions) ? interactions['respondInteraction'] : undefined
    if (typeof respond === 'function' && decision.interactionId !== null) {
      acknowledged = respond.call(interactions, decision.interactionId, checked.instruction) === true
    }
  } catch {
    acknowledged = false
  }
  return acknowledged
    ? delivered(decision, 'acknowledged', null)
    : delivered(decision, 'restart-required', 'ALIGNMENT_UNACKNOWLEDGED')
}

// ---------------------------------------------------------------------------
// Continuation
// ---------------------------------------------------------------------------

/**
 * Verify that a composed plan legitimately continues a fenced attempt from its
 * checkpoint: a new attempt on a new binding, carrying the predecessor's
 * checkpoint and no provider transcript. Pure; never throws for invalid input.
 */
export function verifyCoordinationContinuation(
  input: VerifyCoordinationContinuationInput,
): CoordinationContinuationResult {
  if (!isRecord(input)) {
    return refused('COORD_CONTINUATION_PREDECESSOR_INVALID', '$', 'Continuation input must be an object.')
  }
  const { predecessor, continuation } = input
  const rendered = renderCoordinationAgentExecutionRequest(continuation)
  if (!rendered.ok) return { ok: false, refusals: rendered.refusals }
  if (!validCorrelation(predecessor)) {
    return refused('COORD_CONTINUATION_PREDECESSOR_INVALID', '$predecessor', 'Predecessor must be an attempt correlation.')
  }

  const items = continuation.context.items.filter((item) => item.role === 'predecessor_checkpoint')
  if (items.length !== 1) {
    return refused('COORD_CONTINUATION_CHECKPOINT_MISSING', '$continuation.context.items', 'Continuation must carry exactly one predecessor checkpoint.')
  }
  const checkpoint = parseCheckpoint(items[0] as CoordinationPlanContextItem)
  if (!checkpoint) {
    return refused('COORD_CONTINUATION_CHECKPOINT_INVALID', '$continuation.context.items.predecessor_checkpoint', 'Predecessor checkpoint is not a valid checkpoint handoff.')
  }
  if (
    checkpoint['attemptId'] !== predecessor.attemptId
    || checkpoint['assignmentId'] !== predecessor.assignmentId
    || checkpoint['assignmentDigest'] !== predecessor.assignmentDigest
  ) {
    return refused('COORD_CONTINUATION_CHECKPOINT_MISMATCH', '$continuation.context.items.predecessor_checkpoint', 'Checkpoint belongs to a different attempt.')
  }
  const nextAction = checkpoint['nextAction'] as Record<string, unknown>
  if (
    checkpoint['safeToResume'] !== true
    || checkpoint['progressState'] !== 'progressing'
    || (nextAction['kind'] !== 'continue' && nextAction['kind'] !== 'reobserve')
  ) {
    return refused('COORD_CONTINUATION_NOT_SAFE', '$continuation.context.items.predecessor_checkpoint', 'Checkpoint is not safe to resume from.')
  }
  if (compareCoordinationTimestamps(checkpoint['createdAt'] as string, continuation.composedAt) > 0) {
    return refused('COORD_CONTINUATION_CHECKPOINT_FUTURE', '$continuation.composedAt', 'Checkpoint is newer than the continuation plan.')
  }
  const predecessorGeneration = checkpoint['generation'] as number
  const generation = continuation.assignment.provenance.generation
  if (!isGeneration(generation)) {
    // Unreachable through the composer, which seals an integer generation; kept for the type.
    return refused('COORD_CONTINUATION_GENERATION_INVALID', '$continuation.assignment.provenance.generation', 'A continuation plan seals an integer generation.')
  }
  const sameAttempt = continuation.assignment.attemptId === predecessor.attemptId
  if (sameAttempt && generation <= predecessorGeneration) {
    return refused('COORD_CONTINUATION_REUSES_ATTEMPT', '$continuation.assignment.provenance.generation', 'A continuation of the same attempt is sealed at a higher generation than its checkpoint.')
  }
  const bindingId = continuation.execution.provenance.issuerRef
  if (bindingId === predecessor.bindingId || continuation.execution.sessionRef === predecessor.sessionRef) {
    return refused('COORD_CONTINUATION_REUSES_BINDING', '$continuation.execution', 'A continuation opens a new binding and session.')
  }
  if (continuation.context.items.some((item) => item.role === 'provider_transcript')) {
    return refused('COORD_CONTINUATION_TRANSCRIPT_CARRIED', '$continuation.context.items', 'A provider transcript is never carried into a continuation.')
  }

  const replaced =
    continuation.execution.providerId !== predecessor.providerId
    || continuation.execution.backend !== predecessor.backend
    || continuation.execution.agentHost !== predecessor.agentHost
  const body: Record<string, unknown> = {
    schema: COORDINATION_CONTINUATION_SCHEMA,
    kind: replaced ? 'provider-replacement' : 'restart',
    lineage: sameAttempt ? 'same-attempt' : 'new-attempt',
    checkpointId: checkpoint['checkpointId'],
    handoffDigest: checkpoint['handoffDigest'],
    checkpointSourceBindingDigest: checkpoint['sourceBindingDigest'],
    predecessorAttemptId: predecessor.attemptId,
    predecessorBindingId: predecessor.bindingId,
    predecessorProviderId: predecessor.providerId,
    predecessorGeneration,
    attemptId: continuation.assignment.attemptId,
    bindingId,
    providerId: continuation.execution.providerId,
    generation,
    planDigest: continuation.planDigest,
  }
  body['continuationDigest'] = coordinationSelfDigest(body, 'continuationDigest')
  return Object.freeze({
    ok: true as const,
    continuation: Object.freeze(body) as unknown as CoordinationContinuation,
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validUpdate(value: unknown): CoordinationAlignmentUpdate | undefined {
  if (!isPlainRecord(value)) return undefined
  if (Object.keys(value).some((key) => !UPDATE_KEYS.has(key))) return undefined
  const { schema, updateId, attemptId, kind, changes, instruction, interactionId } = value
  if (schema !== COORDINATION_ALIGNMENT_UPDATE_SCHEMA) return undefined
  if (!isId(updateId) || !isId(attemptId)) return undefined
  if (kind !== 'steer' && kind !== 'interaction-response') return undefined
  if (typeof instruction !== 'string' || instruction.length === 0 || instruction.length > MAX_INSTRUCTION_LENGTH) return undefined
  if (!Array.isArray(changes)) return undefined
  const allowed = new Set<string>(COORDINATION_ALIGNMENT_CHANGES)
  if (changes.some((change) => typeof change !== 'string' || !allowed.has(change))) return undefined
  if (new Set(changes).size !== changes.length) return undefined
  if (kind === 'interaction-response' ? !isId(interactionId) : interactionId !== undefined) return undefined
  return {
    schema,
    updateId,
    attemptId,
    kind,
    changes: [...changes] as CoordinationAlignmentChange[],
    instruction,
    ...(kind === 'interaction-response' ? { interactionId: interactionId as string } : {}),
  }
}

function boundTo(
  session: unknown,
  decision: CoordinationAlignmentDecision,
): session is ProviderSessionAdapter {
  if (!isRecord(session)) return false
  const binding = session['attemptBinding']
  if (!isRecord(binding)) return false
  const descriptor = binding['descriptor']
  return (
    binding['bindingId'] === decision.providerSessionBindingId
    && binding['executionAttemptId'] === decision.attemptId
    && isRecord(descriptor)
    && descriptor['providerId'] === decision.providerId
  )
}

function isSessionRef(value: unknown): value is ProviderSessionRef {
  return (
    isPlainRecord(value)
    && value['schema'] === PROVIDER_SESSION_REFERENCE_SCHEMA
    && value['kind'] === 'session'
    && isId(value['opaqueId'])
  )
}

function validCorrelation(value: unknown): value is CoordinationAttemptCorrelation {
  if (!isRecord(value) || value['schema'] !== COORDINATION_ATTEMPT_CORRELATION_SCHEMA) return false
  if (!CORRELATION_STRING_KEYS.every((key) => isId(value[key]))) return false
  const agentHost = value['agentHost']
  return agentHost === null || isId(agentHost)
}

/** Parse and check a checkpoint handoff; the producer's closed key set and self-digest. */
function parseCheckpoint(item: CoordinationPlanContextItem): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(item.content)
  } catch {
    return undefined
  }
  if (!isPlainRecord(parsed)) return undefined
  const keys = Object.keys(parsed)
  if (keys.length !== CHECKPOINT_KEYS.length || !CHECKPOINT_KEYS.every((key) => Object.hasOwn(parsed, key))) {
    return undefined
  }
  const checkpoint = parsed
  if (!(COORDINATION_CHECKPOINT_HANDOFF_SCHEMAS as readonly unknown[]).includes(checkpoint['schema'])) return undefined
  for (const key of ['checkpointId', 'assignmentId', 'attemptId'] as const) {
    if (!isId(checkpoint[key])) return undefined
  }
  for (const key of ['assignmentDigest', 'sourceBindingDigest', 'handoffDigest'] as const) {
    if (typeof checkpoint[key] !== 'string' || !SHA256.test(checkpoint[key] as string)) return undefined
  }
  if (!isCoordinationTimestamp(checkpoint['createdAt'])) return undefined
  if (typeof checkpoint['safeToResume'] !== 'boolean' || !isRecord(checkpoint['nextAction'])) return undefined
  if (!isGeneration(checkpoint['generation'])) return undefined
  try {
    if (coordinationSelfDigest(checkpoint, 'handoffDigest') !== checkpoint['handoffDigest']) return undefined
  } catch {
    return undefined
  }
  return checkpoint
}

function delivered(
  decision: CoordinationAlignmentDecision,
  status: CoordinationAlignmentDeliveryStatus,
  reasonCode: CoordinationAlignmentDelivery['reasonCode'],
): CoordinationAlignmentDeliveryResult {
  const body: Record<string, unknown> = {
    schema: COORDINATION_ALIGNMENT_DELIVERY_SCHEMA,
    decisionDigest: decision.decisionDigest,
    updateId: decision.updateId,
    channel: decision.channel,
    status,
    reasonCode,
  }
  body['deliveryDigest'] = coordinationSelfDigest(body, 'deliveryDigest')
  return Object.freeze({
    ok: true as const,
    delivery: Object.freeze(body) as unknown as CoordinationAlignmentDelivery,
  })
}

function refused(code: string, path: string, message: string): { readonly ok: false; readonly refusals: readonly CoordinationAssignmentDiagnostic[] } {
  return Object.freeze({
    ok: false as const,
    refusals: Object.freeze([Object.freeze({ code, path, message })]),
  })
}

/** A sealed generation: a non-negative safe integer. */
function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}
