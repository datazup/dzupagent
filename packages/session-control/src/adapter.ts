import {
  SESSION_CONTROL_CAPABILITIES,
  type CommandEvidence,
  type ExecutionProfile,
  type JsonObject,
  type OpaqueReference,
  type Sha256Digest,
  type SessionControlCapability,
  type ValidationIssue,
} from './contracts.js'
import {
  evaluateCapabilityDeclaration,
  validateCapabilityManifest,
  type SessionControlCapabilityManifest,
} from './capabilities.js'
import {
  validateNormalizedSessionEvent,
  validateSessionSnapshot,
  type NormalizedSessionEvent,
  type SessionSnapshot,
} from './session-types.js'
import { isOpaqueReference } from './validation.js'

export interface AdapterInvocation {
  readonly correlationRef: OpaqueReference
  readonly sessionRef: OpaqueReference
  readonly commandId: OpaqueReference
  readonly expectedGeneration: number
  readonly deadline: string
  readonly idempotencyKey: Sha256Digest
  readonly payload: JsonObject
}

export interface StartSessionAdapterInvocation {
  readonly correlationRef: OpaqueReference
  readonly profile: ExecutionProfile
  readonly deadline: string
  readonly idempotencyKey: Sha256Digest
  readonly payload: JsonObject
}

export interface ObserveSessionAdapterInvocation {
  readonly correlationRef: OpaqueReference
  readonly sessionRef: OpaqueReference
}

export interface TailSessionEventsAdapterInvocation extends ObserveSessionAdapterInvocation {
  readonly afterSequence: number
}

export interface LookupSessionAfterRestartAdapterInvocation {
  readonly correlationRef: OpaqueReference
  readonly lookupRef: OpaqueReference
}

export interface NativeSessionResumeAdapterInvocation extends ObserveSessionAdapterInvocation {
  readonly continuationRef?: OpaqueReference
}

export type AdapterOperationResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'provider_waiting'; readonly evidence?: CommandEvidence }
  | { readonly status: 'applied'; readonly evidence: CommandEvidence }
  | { readonly status: 'interaction_required'; readonly interactionRef: OpaqueReference }
  | { readonly status: 'failed'; readonly failureCode: string }

type AdapterFailureOrInteraction = Extract<
  AdapterOperationResult,
  { status: 'failed' | 'interaction_required' }
>

export type StartSessionAdapterResult =
  | {
      readonly status: 'applied'
      readonly sessionRef: OpaqueReference
      readonly evidence: CommandEvidence
    }
  | AdapterFailureOrInteraction

export type ObserveSessionAdapterResult =
  | {
      readonly status: 'applied'
      readonly snapshot: SessionSnapshot
      readonly evidence: CommandEvidence
    }
  | AdapterFailureOrInteraction

export type TailSessionEventsAdapterResult =
  | {
      readonly status: 'applied'
      readonly events: readonly NormalizedSessionEvent[]
      readonly nextSequence: number
      readonly evidence: CommandEvidence
    }
  | AdapterFailureOrInteraction

export type LookupSessionAfterRestartAdapterResult =
  | {
      readonly status: 'applied'
      readonly snapshot: SessionSnapshot | null
      readonly evidence: CommandEvidence
    }
  | AdapterFailureOrInteraction

export type AdapterCapabilityOperationResult =
  | AdapterOperationResult
  | StartSessionAdapterResult
  | ObserveSessionAdapterResult
  | TailSessionEventsAdapterResult
  | LookupSessionAfterRestartAdapterResult

export type AdapterOperationResultValidation<
  Result extends AdapterCapabilityOperationResult = AdapterCapabilityOperationResult,
> =
  | { readonly ok: true; readonly value: Result }
  | { readonly ok: false; readonly failureCode: string }

const ADAPTER_EVIDENCE_KINDS = [
  'provider_event',
  'normalized_event',
  'subsequent_read',
  'transport_acknowledgement',
] as const
const APPLICATION_EVIDENCE_KINDS = new Set([
  'provider_event',
  'normalized_event',
  'subsequent_read',
])
const SAFE_FAILURE_CODE = /^[a-z][a-z0-9._-]{2,127}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => allowed.has(field))
}

function isCommandEvidence(value: unknown): value is CommandEvidence {
  return (
    isRecord(value) &&
    hasExactFields(value, ['kind', 'ref']) &&
    ADAPTER_EVIDENCE_KINDS.includes(value.kind as never) &&
    isOpaqueReference(value.ref)
  )
}

type AppliedResult<T extends AdapterCapabilityOperationResult> = Extract<T, { status: 'applied' }>
type CandidateResult = Record<string, unknown> & { readonly status: string }

function isAcceptedResult(
  input: CandidateResult,
): input is CandidateResult & Extract<AdapterOperationResult, { status: 'accepted' }> {
  return input.status === 'accepted' && hasExactFields(input, ['status'])
}

function isProviderWaitingResult(
  input: CandidateResult,
): input is CandidateResult & Extract<AdapterOperationResult, { status: 'provider_waiting' }> {
  return (
    input.status === 'provider_waiting' &&
    hasExactFields(input, ['status'], ['evidence']) &&
    (input.evidence === undefined || isCommandEvidence(input.evidence))
  )
}

function isAppliedResult(
  input: CandidateResult,
): input is CandidateResult & AppliedResult<AdapterOperationResult> {
  return (
    input.status === 'applied' &&
    hasExactFields(input, ['status', 'evidence']) &&
    isCommandEvidence(input.evidence)
  )
}

function isInteractionRequiredResult(
  input: CandidateResult,
): input is CandidateResult & AdapterFailureOrInteraction & { status: 'interaction_required' } {
  return (
    input.status === 'interaction_required' &&
    hasExactFields(input, ['status', 'interactionRef']) &&
    isOpaqueReference(input.interactionRef)
  )
}

function isFailedResult(
  input: CandidateResult,
): input is CandidateResult & AdapterFailureOrInteraction & { status: 'failed' } {
  return (
    input.status === 'failed' &&
    hasExactFields(input, ['status', 'failureCode']) &&
    typeof input.failureCode === 'string' &&
    SAFE_FAILURE_CODE.test(input.failureCode)
  )
}

function isCandidateResult(input: unknown): input is CandidateResult {
  return isRecord(input) && typeof input.status === 'string'
}

function validateCommandAdapterResult(
  input: unknown,
): AdapterOperationResultValidation<AdapterOperationResult> {
  if (!isCandidateResult(input)) {
    return { ok: false, failureCode: 'invalid_adapter_result' }
  }
  switch (input.status) {
    case 'accepted':
      return isAcceptedResult(input)
        ? { ok: true, value: input }
        : { ok: false, failureCode: 'invalid_adapter_result' }
    case 'provider_waiting':
      return isProviderWaitingResult(input)
        ? { ok: true, value: input }
        : { ok: false, failureCode: 'invalid_adapter_result' }
    case 'applied':
      return isAppliedResult(input) && APPLICATION_EVIDENCE_KINDS.has(input.evidence.kind)
        ? { ok: true, value: input }
        : { ok: false, failureCode: 'application_evidence_required' }
    case 'interaction_required':
      return isInteractionRequiredResult(input)
        ? { ok: true, value: input }
        : { ok: false, failureCode: 'interaction_reference_required' }
    case 'failed':
      return isFailedResult(input)
        ? { ok: true, value: input }
        : { ok: false, failureCode: 'invalid_adapter_result' }
    default:
      return { ok: false, failureCode: 'invalid_adapter_result' }
  }
}

function isCoherentTailEventBatch(
  events: unknown,
  nextSequence: unknown,
): events is readonly NormalizedSessionEvent[] {
  if (!Array.isArray(events) || !Number.isSafeInteger(nextSequence) || Number(nextSequence) < 0) {
    return false
  }

  let prior: NormalizedSessionEvent | undefined
  const eventIds = new Set<string>()
  for (const entry of events) {
    const validated = validateNormalizedSessionEvent(entry)
    if (!validated.ok || eventIds.has(validated.value.eventId)) return false
    const event = validated.value
    if (
      prior !== undefined &&
      (event.sessionRef !== prior.sessionRef ||
        event.sequence !== prior.sequence + 1 ||
        Date.parse(event.recordedAt) < Date.parse(prior.recordedAt))
    ) {
      return false
    }
    eventIds.add(event.eventId)
    prior = event
  }

  return prior === undefined || Number(nextSequence) === prior.sequence + 1
}

type AppliedCandidate = CandidateResult & { readonly status: 'applied'; readonly evidence: CommandEvidence }

function isAppliedCandidate(input: CandidateResult): input is AppliedCandidate {
  return input.status === 'applied' && isCommandEvidence(input.evidence)
}

function isStartAppliedResult(
  input: AppliedCandidate,
): input is AppliedCandidate & AppliedResult<StartSessionAdapterResult> {
  return hasExactFields(input, ['status', 'sessionRef', 'evidence']) && isOpaqueReference(input.sessionRef)
}

function isTailAppliedResult(
  input: AppliedCandidate,
): input is AppliedCandidate & AppliedResult<TailSessionEventsAdapterResult> {
  return (
    hasExactFields(input, ['status', 'events', 'nextSequence', 'evidence']) &&
    isCoherentTailEventBatch(input.events, input.nextSequence)
  )
}

function isLookupMissResult(
  input: AppliedCandidate,
): input is AppliedCandidate & AppliedResult<LookupSessionAfterRestartAdapterResult> & { snapshot: null } {
  return input.snapshot === null
}

function isSnapshotAppliedResult(
  input: AppliedCandidate,
): input is AppliedCandidate & AppliedResult<ObserveSessionAdapterResult> {
  return validateSessionSnapshot(input.snapshot).ok
}

function validateSpecializedResult(
  input: unknown,
  capability: 'start' | 'observe' | 'tail_events' | 'lookup_after_restart',
): AdapterOperationResultValidation {
  if (!isCandidateResult(input)) {
    return { ok: false, failureCode: 'invalid_adapter_result' }
  }
  if (input.status !== 'applied') {
    const common = validateCommandAdapterResult(input)
    if (common.ok && (common.value.status === 'failed' || common.value.status === 'interaction_required')) {
      return common
    }
    return { ok: false, failureCode: 'invalid_adapter_result' }
  }
  if (!isAppliedCandidate(input) || !APPLICATION_EVIDENCE_KINDS.has(input.evidence.kind)) {
    return { ok: false, failureCode: 'application_evidence_required' }
  }
  const applied = input
  if (capability === 'start') {
    return isStartAppliedResult(applied)
      ? { ok: true, value: applied }
      : { ok: false, failureCode: 'session_reference_required' }
  }
  if (capability === 'tail_events') {
    return isTailAppliedResult(applied)
      ? { ok: true, value: applied }
      : { ok: false, failureCode: 'invalid_event_batch' }
  }
  if (!hasExactFields(applied, ['status', 'snapshot', 'evidence'])) {
    return { ok: false, failureCode: 'invalid_adapter_result' }
  }
  if (capability === 'lookup_after_restart' && isLookupMissResult(applied)) {
    return { ok: true, value: applied }
  }
  return isSnapshotAppliedResult(applied)
    ? { ok: true, value: applied }
    : { ok: false, failureCode: 'invalid_session_snapshot' }
}

export function validateAdapterOperationResult(
  input: unknown,
): AdapterOperationResultValidation<AdapterOperationResult>
export function validateAdapterOperationResult(
  input: unknown,
  capability: SessionControlCapability,
): AdapterOperationResultValidation
export function validateAdapterOperationResult(
  input: unknown,
  capability?: SessionControlCapability,
): AdapterOperationResultValidation {
  if (
    capability === 'start' ||
    capability === 'observe' ||
    capability === 'tail_events' ||
    capability === 'lookup_after_restart'
  ) {
    return validateSpecializedResult(input, capability)
  }
  return validateCommandAdapterResult(input)
}

export type SessionControlAdapterMethod = (
  this: SessionControlAdapter,
  invocation: AdapterInvocation,
) => Promise<AdapterOperationResult>

export type StartSessionAdapterMethod = (
  this: SessionControlAdapter,
  invocation: StartSessionAdapterInvocation,
) => Promise<StartSessionAdapterResult>

export type ObserveSessionAdapterMethod = (
  this: SessionControlAdapter,
  invocation: ObserveSessionAdapterInvocation,
) => Promise<ObserveSessionAdapterResult>

export type TailSessionEventsAdapterMethod = (
  this: SessionControlAdapter,
  invocation: TailSessionEventsAdapterInvocation,
) => Promise<TailSessionEventsAdapterResult>

export type LookupSessionAfterRestartAdapterMethod = (
  this: SessionControlAdapter,
  invocation: LookupSessionAfterRestartAdapterInvocation,
) => Promise<LookupSessionAfterRestartAdapterResult>

export type NativeSessionResumeAdapterMethod = (
  this: SessionControlAdapter,
  invocation: NativeSessionResumeAdapterInvocation,
) => Promise<AdapterOperationResult>

export interface SessionControlAdapter {
  readonly manifest: SessionControlCapabilityManifest
  readonly observe?: ObserveSessionAdapterMethod
  readonly start?: StartSessionAdapterMethod
  readonly sendMessage?: SessionControlAdapterMethod
  readonly steerActiveTurn?: SessionControlAdapterMethod
  readonly respondInteraction?: SessionControlAdapterMethod
  readonly pause?: SessionControlAdapterMethod
  readonly resume?: SessionControlAdapterMethod
  readonly interrupt?: SessionControlAdapterMethod
  readonly fork?: SessionControlAdapterMethod
  readonly tailEvents?: TailSessionEventsAdapterMethod
  readonly lookupAfterRestart?: LookupSessionAfterRestartAdapterMethod
  readonly nativeSessionResume?: NativeSessionResumeAdapterMethod
}

export const ADAPTER_METHOD_BY_CAPABILITY = {
  observe: 'observe',
  start: 'start',
  send_message: 'sendMessage',
  steer_active_turn: 'steerActiveTurn',
  respond_interaction: 'respondInteraction',
  pause: 'pause',
  resume: 'resume',
  interrupt: 'interrupt',
  fork: 'fork',
  tail_events: 'tailEvents',
  lookup_after_restart: 'lookupAfterRestart',
  native_session_resume: 'nativeSessionResume',
} as const satisfies Record<SessionControlCapability, keyof SessionControlAdapter>

export interface AdapterConformanceIssue extends ValidationIssue {
  readonly capability?: SessionControlCapability
  readonly method?: string
}

export type AdapterConformanceResult =
  | { readonly ok: true; readonly value: SessionControlAdapter }
  | { readonly ok: false; readonly issues: readonly AdapterConformanceIssue[] }

export function validateAdapterConformance(
  adapter: SessionControlAdapter,
): AdapterConformanceResult {
  const manifestResult = validateCapabilityManifest(adapter.manifest)
  if (!manifestResult.ok) return { ok: false, issues: manifestResult.issues }

  const issues: AdapterConformanceIssue[] = []
  for (const capability of SESSION_CONTROL_CAPABILITIES) {
    const declaration = adapter.manifest.capabilities[capability]
    if (!evaluateCapabilityDeclaration(declaration).callable) continue
    const method = ADAPTER_METHOD_BY_CAPABILITY[capability]
    if (typeof adapter[method] !== 'function') {
      issues.push({
        path: method,
        code: 'declared_method_missing',
        message: 'native qualified capability requires its exact adapter method',
        capability,
        method,
      })
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: adapter }
}

export function isAdapterCapabilityCallable(
  adapter: SessionControlAdapter,
  capability: SessionControlCapability,
): boolean {
  const declaration = adapter.manifest.capabilities[capability]
  const method = ADAPTER_METHOD_BY_CAPABILITY[capability]
  return evaluateCapabilityDeclaration(declaration).callable && typeof adapter[method] === 'function'
}
