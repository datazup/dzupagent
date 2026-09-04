import {
  SESSION_CONTROL_SCHEMAS,
  type OpaqueReference,
  type Sha256Digest,
  type ValidationIssue,
} from './contracts.js'
import {
  TERMINAL_COMMAND_STATUSES,
  validateSessionControlCommand,
  type SessionControlCommand,
  type SessionControlCommandAction,
  type SessionControlCommandStatus,
} from './commands.js'
import { isFiniteIsoTimestamp, isOpaqueReference } from './validation.js'

export const COMMAND_EVIDENCE_KINDS = [
  'provider_event',
  'normalized_event',
  'subsequent_read',
  'transport_acknowledgement',
] as const
export type CommandEvidenceKind = (typeof COMMAND_EVIDENCE_KINDS)[number]

export interface CommandEvidence {
  readonly kind: CommandEvidenceKind
  readonly ref: OpaqueReference
}

export interface CommandRecord {
  readonly schema: typeof SESSION_CONTROL_SCHEMAS.commandRecord
  readonly commandId: OpaqueReference
  readonly commandDigest: Sha256Digest
  readonly idempotencyKey: Sha256Digest
  readonly sessionRef: OpaqueReference
  readonly action: SessionControlCommandAction
  readonly expectedGeneration: number
  readonly correlationRef: OpaqueReference
  readonly status: SessionControlCommandStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly evidence?: CommandEvidence
  readonly failureCode?: string
}

export interface CommandRecordMutation {
  readonly status: SessionControlCommandStatus
  readonly recordedAt: string
  readonly evidence?: CommandEvidence
  readonly failureCode?: string
}

export type CommandRecordResult =
  | { readonly ok: true; readonly record: CommandRecord }
  | { readonly ok: false; readonly issue: ValidationIssue }

const APPLICATION_EVIDENCE = new Set<CommandEvidenceKind>([
  'provider_event',
  'normalized_event',
  'subsequent_read',
])
const SAFE_FAILURE_CODE = /^[a-z][a-z0-9._-]{2,127}$/

export function isTerminalCommandStatus(status: SessionControlCommandStatus): boolean {
  return TERMINAL_COMMAND_STATUSES.includes(status as never)
}

function validateMutation(mutation: CommandRecordMutation): ValidationIssue | null {
  if (!isFiniteIsoTimestamp(mutation.recordedAt)) {
    return { path: 'recordedAt', code: 'invalid_timestamp', message: 'record time must be finite ISO time' }
  }
  if (mutation.evidence !== undefined) {
    if (
      !COMMAND_EVIDENCE_KINDS.includes(mutation.evidence.kind as never) ||
      !isOpaqueReference(mutation.evidence.ref)
    ) {
      return { path: 'evidence', code: 'invalid_evidence', message: 'invalid command evidence' }
    }
  }
  if (
    mutation.status === 'applied' &&
    (mutation.evidence === undefined || !APPLICATION_EVIDENCE.has(mutation.evidence.kind))
  ) {
    return {
      path: 'evidence',
      code: 'application_evidence_required',
      message: 'applied requires provider, normalized-event, or subsequent-read evidence',
    }
  }
  if (
    mutation.status === 'failed' &&
    (typeof mutation.failureCode !== 'string' || !SAFE_FAILURE_CODE.test(mutation.failureCode))
  ) {
    return { path: 'failureCode', code: 'failure_code_required', message: 'failed requires a safe code' }
  }
  return null
}

export function createCommandRecord(
  command: SessionControlCommand,
  initial: CommandRecordMutation,
): CommandRecordResult {
  const commandResult = validateSessionControlCommand(command)
  if (!commandResult.ok) {
    return {
      ok: false,
      issue: { path: '$', code: 'invalid_command', message: 'cannot record an invalid command' },
    }
  }
  const issue = validateMutation(initial)
  if (issue !== null) return { ok: false, issue }

  return {
    ok: true,
    record: {
      schema: SESSION_CONTROL_SCHEMAS.commandRecord,
      commandId: command.commandId,
      commandDigest: command.commandDigest,
      idempotencyKey: command.idempotencyKey,
      sessionRef: command.sessionRef,
      action: command.action,
      expectedGeneration: command.expectedGeneration,
      correlationRef: command.correlationRef,
      status: initial.status,
      createdAt: initial.recordedAt,
      updatedAt: initial.recordedAt,
      ...(initial.evidence === undefined ? {} : { evidence: initial.evidence }),
      ...(initial.failureCode === undefined ? {} : { failureCode: initial.failureCode }),
    },
  }
}

const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly SessionControlCommandStatus[]>> = {
  accepted: ['provider_waiting', 'applied', 'failed'],
  provider_waiting: ['applied', 'failed'],
}

export function transitionCommandRecord(
  record: CommandRecord,
  transition: CommandRecordMutation,
): CommandRecordResult {
  if (isTerminalCommandStatus(record.status)) {
    return {
      ok: false,
      issue: {
        path: 'status',
        code: 'terminal_record_immutable',
        message: 'terminal command records are immutable',
      },
    }
  }
  if (!(ALLOWED_TRANSITIONS[record.status] ?? []).includes(transition.status)) {
    return {
      ok: false,
      issue: { path: 'status', code: 'invalid_transition', message: 'invalid command transition' },
    }
  }
  const issue = validateMutation(transition)
  if (issue !== null) return { ok: false, issue }
  if (Date.parse(transition.recordedAt) < Date.parse(record.updatedAt)) {
    return {
      ok: false,
      issue: { path: 'recordedAt', code: 'time_regression', message: 'record time moved backwards' },
    }
  }

  return {
    ok: true,
    record: {
      ...record,
      status: transition.status,
      updatedAt: transition.recordedAt,
      ...(transition.evidence === undefined ? {} : { evidence: transition.evidence }),
      ...(transition.failureCode === undefined ? {} : { failureCode: transition.failureCode }),
    },
  }
}
