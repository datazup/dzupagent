import {
  ADAPTER_METHOD_BY_CAPABILITY,
  validateAdapterConformance,
  validateAdapterOperationResult,
  type AdapterInvocation,
  type AdapterOperationResult,
  type SessionControlAdapter,
  type SessionControlAdapterMethod,
} from './adapter.js'
import type { CommandEvidence } from './contracts.js'
import {
  admitSessionControlCommand,
  type CommandAdmissionResult,
  type CommandAuthorityDecision,
  type SessionControlCommand,
} from './commands.js'
import type { SessionControlSessionView } from './session-types.js'

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
      return { status: 'provider_waiting', interactionRef: result.interactionRef }
    case 'applied':
      return { status: 'applied', evidence: result.evidence }
    case 'failed':
      return { status: 'failed', reason: result.failureCode }
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
    const rawResult: unknown = await method.call(input.adapter, invocationFor(input.command))
    const result = validateAdapterOperationResult(rawResult)
    if (!result.ok) return { status: 'failed', reason: result.failureCode }
    return projectAdapterResult(result.value)
  } catch {
    return { status: 'failed', reason: 'adapter_error' }
  }
}
