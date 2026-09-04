import {
  ADAPTER_METHOD_BY_CAPABILITY,
  validateAdapterConformance,
  type AdapterInvocation,
  type AdapterOperationResult,
  type SessionControlAdapter,
  type SessionControlAdapterMethod,
} from './adapter.js'
import { COMMAND_EVIDENCE_KINDS, type CommandEvidence } from './command-ledger.js'
import {
  admitSessionControlCommand,
  type CommandAdmissionResult,
  type CommandAuthorityDecision,
  type SessionControlCommand,
  type SessionControlSessionView,
} from './commands.js'
import { isOpaqueReference } from './validation.js'

export interface DispatchSessionCommandInput {
  readonly command: SessionControlCommand
  readonly session: SessionControlSessionView
  readonly adapter: SessionControlAdapter
  readonly authority: CommandAuthorityDecision | undefined
  readonly now: string
}

export type DispatchSessionCommandResult =
  | CommandAdmissionResult
  | { readonly status: 'accepted' }
  | {
      readonly status: 'provider_waiting'
      readonly evidence?: CommandEvidence
      readonly interactionRef?: string
    }
  | { readonly status: 'applied'; readonly evidence: CommandEvidence }
  | { readonly status: 'failed'; readonly reason: string }

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

function isCommandEvidence(value: unknown): value is CommandEvidence {
  return (
    isRecord(value) &&
    Object.keys(value).every((field) => field === 'kind' || field === 'ref') &&
    COMMAND_EVIDENCE_KINDS.includes(value.kind as never) &&
    isOpaqueReference(value.ref)
  )
}

function validateAdapterResult(value: unknown): AdapterOperationResult | null {
  if (!isRecord(value)) return null
  const allowed = new Set(['status', 'evidence', 'interactionRef', 'failureCode'])
  if (!Object.keys(value).every((field) => allowed.has(field))) return null
  if (
    value.status !== 'accepted' &&
    value.status !== 'provider_waiting' &&
    value.status !== 'applied' &&
    value.status !== 'interaction_required' &&
    value.status !== 'failed'
  ) {
    return null
  }
  if (value.evidence !== undefined && !isCommandEvidence(value.evidence)) return null
  if (value.interactionRef !== undefined && !isOpaqueReference(value.interactionRef)) return null
  if (
    value.failureCode !== undefined &&
    (typeof value.failureCode !== 'string' || !SAFE_FAILURE_CODE.test(value.failureCode))
  ) {
    return null
  }
  return value as unknown as AdapterOperationResult
}

function invocationFor(command: SessionControlCommand): AdapterInvocation {
  return {
    commandId: command.commandId,
    sessionRef: command.sessionRef,
    expectedGeneration: command.expectedGeneration,
    deadline: command.deadline,
    idempotencyKey: command.idempotencyKey,
    correlationRef: command.correlationRef,
    payload: command.payload,
  }
}

function projectAdapterResult(result: AdapterOperationResult): DispatchSessionCommandResult {
  switch (result.status) {
    case 'accepted':
      return { status: 'accepted' }
    case 'provider_waiting':
      return {
        status: 'provider_waiting',
        ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
      }
    case 'interaction_required':
      if (result.interactionRef === undefined) {
        return { status: 'failed', reason: 'interaction_reference_required' }
      }
      return { status: 'provider_waiting', interactionRef: result.interactionRef }
    case 'applied':
      if (
        result.evidence === undefined ||
        !APPLICATION_EVIDENCE_KINDS.has(result.evidence.kind)
      ) {
        return { status: 'failed', reason: 'application_evidence_required' }
      }
      return { status: 'applied', evidence: result.evidence }
    case 'failed':
      return { status: 'failed', reason: result.failureCode ?? 'adapter_failed' }
  }
}

export async function dispatchSessionCommand(
  input: DispatchSessionCommandInput,
): Promise<DispatchSessionCommandResult> {
  const admission = admitSessionControlCommand({
    command: input.command,
    session: input.session,
    manifest: input.adapter.manifest,
    authority: input.authority,
    now: input.now,
  })
  if (admission.status !== 'accepted') return admission

  if (!validateAdapterConformance(input.adapter).ok) {
    return { status: 'failed', reason: 'adapter_nonconformant' }
  }
  const methodName = ADAPTER_METHOD_BY_CAPABILITY[admission.capability]
  const method = input.adapter[methodName] as SessionControlAdapterMethod | undefined
  if (method === undefined) return { status: 'failed', reason: 'adapter_nonconformant' }

  try {
    const rawResult: unknown = await method(invocationFor(input.command))
    const result = validateAdapterResult(rawResult)
    if (result === null) return { status: 'failed', reason: 'invalid_adapter_result' }
    return projectAdapterResult(result)
  } catch {
    return { status: 'failed', reason: 'adapter_error' }
  }
}
