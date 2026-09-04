import {
  validateAdapterOperationResult,
  type AdapterOperationResult,
} from './adapter.js'
import {
  evaluateCapabilityDeclaration,
  validateCapabilityManifest,
  type SessionControlCapabilityManifest,
} from './capabilities.js'
import {
  SESSION_CONTROL_SCHEMAS,
  TERMINAL_SESSION_STATUSES,
  type ExecutionProfile,
  type JsonObject,
  type OpaqueReference,
  type SessionControlCapability,
  type SessionStatus,
  type Sha256Digest,
  type ValidationIssue,
  type ValidationResult,
} from './contracts.js'
import {
  isFiniteIsoTimestamp,
  isJsonValue,
  isOpaqueReference,
  isSha256Digest,
  validateExecutionProfile,
} from './validation.js'
import {
  validateSessionControlSessionView,
  type SessionControlSessionView,
} from './session-types.js'

export const SESSION_CONTROL_COMMAND_ACTIONS = [
  'send_message',
  'steer_active_turn',
  'respond_interaction',
  'pause',
  'resume',
  'interrupt',
  'fork',
] as const
export type SessionControlCommandAction = (typeof SESSION_CONTROL_COMMAND_ACTIONS)[number]

export const SESSION_CONTROL_COMMAND_STATUSES = [
  'accepted',
  'provider_waiting',
  'applied',
  'rejected_stale',
  'rejected_authority',
  'unsupported',
  'failed',
] as const
export type SessionControlCommandStatus = (typeof SESSION_CONTROL_COMMAND_STATUSES)[number]

export const TERMINAL_COMMAND_STATUSES = [
  'applied',
  'rejected_stale',
  'rejected_authority',
  'unsupported',
  'failed',
] as const
export type TerminalCommandStatus = (typeof TERMINAL_COMMAND_STATUSES)[number]

export interface SessionControlCommand {
  readonly schema: typeof SESSION_CONTROL_SCHEMAS.command
  readonly commandId: OpaqueReference
  readonly commandDigest: Sha256Digest
  readonly sessionRef: OpaqueReference
  readonly action: SessionControlCommandAction
  readonly expectedGeneration: number
  readonly deadline: string
  readonly idempotencyKey: Sha256Digest
  readonly correlationRef: OpaqueReference
  readonly payload: JsonObject
}

export interface CommandAuthorityDecision {
  readonly decision: 'allow' | 'deny'
  readonly decisionRef: OpaqueReference
}

export interface CommandAdmissionInput {
  readonly command: SessionControlCommand
  readonly session: SessionControlSessionView
  readonly manifest: SessionControlCapabilityManifest
  readonly authority: CommandAuthorityDecision | undefined
  readonly now: string
}

export type CommandAdmissionResult =
  | {
      readonly status: 'accepted'
      readonly capability: SessionControlCapability
      readonly authorityDecisionRef: OpaqueReference
    }
  | {
      readonly status: Exclude<SessionControlCommandStatus, 'accepted' | 'provider_waiting' | 'applied'>
      readonly reason: string
      readonly authorityDecisionRef?: OpaqueReference
      readonly issues?: readonly ValidationIssue[]
    }

const CAPABILITY_BY_ACTION: Readonly<
  Record<SessionControlCommandAction, SessionControlCapability>
> = {
  send_message: 'send_message',
  steer_active_turn: 'steer_active_turn',
  respond_interaction: 'respond_interaction',
  pause: 'pause',
  resume: 'resume',
  interrupt: 'interrupt',
  fork: 'fork',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function checkExactFields(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const allowed = new Set([...required, ...optional])
  for (const field of required) {
    if (!Object.hasOwn(input, field)) {
      issues.push({ path: field, code: 'field_required', message: 'required field is missing' })
    }
  }
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      issues.push({ path: field, code: 'unexpected_field', message: 'unexpected field' })
    }
  }
  return issues
}

function validatePayload(action: SessionControlCommandAction, value: unknown): ValidationIssue[] {
  if (!isRecord(value) || !isJsonValue(value)) {
    return [{ path: 'payload', code: 'invalid_payload', message: 'payload must be portable JSON' }]
  }

  let issues: ValidationIssue[]
  switch (action) {
    case 'send_message':
    case 'steer_active_turn':
      issues = checkExactFields(value, ['message'])
      if (typeof value.message !== 'string' || value.message.length === 0 || value.message.length > 100_000) {
        issues.push({ path: 'message', code: 'invalid_message', message: 'message must be non-empty' })
      }
      break
    case 'respond_interaction':
      issues = checkExactFields(value, ['interactionRef', 'answer'])
      if (!isOpaqueReference(value.interactionRef)) {
        issues.push({
          path: 'interactionRef',
          code: 'invalid_reference',
          message: 'invalid interaction reference',
        })
      }
      if (!Object.hasOwn(value, 'answer') || !isJsonValue(value.answer)) {
        issues.push({ path: 'answer', code: 'invalid_answer', message: 'answer must be portable JSON' })
      }
      break
    case 'pause':
    case 'interrupt':
      issues = checkExactFields(value, ['reasonRef'])
      if (!isOpaqueReference(value.reasonRef)) {
        issues.push({ path: 'reasonRef', code: 'invalid_reference', message: 'invalid reason reference' })
      }
      break
    case 'resume':
      issues = checkExactFields(value, [], ['continuationRef'])
      if (value.continuationRef !== undefined && !isOpaqueReference(value.continuationRef)) {
        issues.push({
          path: 'continuationRef',
          code: 'invalid_reference',
          message: 'invalid continuation reference',
        })
      }
      break
    case 'fork':
      issues = checkExactFields(value, ['targetSessionRef'], ['fromEventRef'])
      if (!isOpaqueReference(value.targetSessionRef)) {
        issues.push({
          path: 'targetSessionRef',
          code: 'invalid_reference',
          message: 'invalid target session reference',
        })
      }
      if (value.fromEventRef !== undefined && !isOpaqueReference(value.fromEventRef)) {
        issues.push({
          path: 'fromEventRef',
          code: 'invalid_reference',
          message: 'invalid event reference',
        })
      }
      break
  }

  return issues.map((issue) => ({ ...issue, path: `payload.${issue.path}` }))
}

export function validateSessionControlCommand(
  input: unknown,
): ValidationResult<SessionControlCommand> {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [{ path: '$', code: 'invalid_type', message: 'command must be an object' }],
    }
  }

  const issues = checkExactFields(input, [
    'schema',
    'commandId',
    'commandDigest',
    'sessionRef',
    'action',
    'expectedGeneration',
    'deadline',
    'idempotencyKey',
    'correlationRef',
    'payload',
  ])
  if (input.schema !== SESSION_CONTROL_SCHEMAS.command) {
    issues.push({ path: 'schema', code: 'invalid_schema', message: 'unsupported command schema' })
  }
  if (!isOpaqueReference(input.commandId)) {
    issues.push({ path: 'commandId', code: 'invalid_reference', message: 'invalid command reference' })
  }
  if (!isSha256Digest(input.commandDigest)) {
    issues.push({ path: 'commandDigest', code: 'invalid_digest', message: 'invalid command digest' })
  }
  if (!isOpaqueReference(input.sessionRef)) {
    issues.push({ path: 'sessionRef', code: 'invalid_reference', message: 'invalid session reference' })
  }
  if (!SESSION_CONTROL_COMMAND_ACTIONS.includes(input.action as never)) {
    issues.push({ path: 'action', code: 'invalid_action', message: 'invalid command action' })
  }
  if (!Number.isSafeInteger(input.expectedGeneration) || Number(input.expectedGeneration) < 0) {
    issues.push({
      path: 'expectedGeneration',
      code: 'invalid_generation',
      message: 'generation must be a non-negative safe integer',
    })
  }
  if (!isFiniteIsoTimestamp(input.deadline)) {
    issues.push({ path: 'deadline', code: 'invalid_deadline', message: 'deadline must be finite ISO time' })
  }
  if (!isSha256Digest(input.idempotencyKey)) {
    issues.push({ path: 'idempotencyKey', code: 'invalid_digest', message: 'invalid idempotency key' })
  }
  if (!isOpaqueReference(input.correlationRef)) {
    issues.push({
      path: 'correlationRef',
      code: 'invalid_reference',
      message: 'invalid correlation reference',
    })
  }
  if (SESSION_CONTROL_COMMAND_ACTIONS.includes(input.action as never)) {
    issues.push(...validatePayload(input.action as SessionControlCommandAction, input.payload))
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: input as unknown as SessionControlCommand }
}

const ALLOWED_SESSION_STATUSES_BY_ACTION: Readonly<
  Record<SessionControlCommandAction, readonly SessionStatus[]>
> = {
  send_message: ['idle'],
  steer_active_turn: ['running'],
  respond_interaction: ['waiting_for_input', 'waiting_for_approval'],
  pause: [
    'idle',
    'running',
    'waiting_for_input',
    'waiting_for_approval',
    'waiting_for_dependency',
    'blocked',
  ],
  resume: ['paused', 'unreachable'],
  interrupt: [
    'running',
    'waiting_for_input',
    'waiting_for_approval',
    'waiting_for_dependency',
    'blocked',
  ],
  fork: ['idle', 'paused', 'blocked'],
}

function actionIsCompatible(
  command: SessionControlCommand,
  session: SessionControlSessionView,
): string | null {
  if (!ALLOWED_SESSION_STATUSES_BY_ACTION[command.action].includes(session.status)) {
    return 'action_not_allowed_in_state'
  }
  if (command.action === 'respond_interaction') {
    return command.payload.interactionRef === session.pendingInteractionRef
      ? null
      : 'interaction_mismatch'
  }
  return null
}

export function admitSessionControlCommand(input: CommandAdmissionInput): CommandAdmissionResult {
  const commandResult = validateSessionControlCommand(input.command)
  if (!commandResult.ok) {
    return { status: 'failed', reason: 'invalid_command', issues: commandResult.issues }
  }
  if (!isFiniteIsoTimestamp(input.now)) return { status: 'failed', reason: 'invalid_now' }
  const sessionResult = validateSessionControlSessionView(input.session)
  if (!sessionResult.ok) {
    return { status: 'failed', reason: 'invalid_session_view', issues: sessionResult.issues }
  }
  if (input.command.sessionRef !== input.session.sessionRef) {
    return { status: 'rejected_stale', reason: 'session_mismatch' }
  }
  if (Date.parse(input.now) >= Date.parse(input.command.deadline)) {
    return { status: 'rejected_stale', reason: 'deadline_expired' }
  }
  if (input.command.expectedGeneration !== input.session.generation) {
    return { status: 'rejected_stale', reason: 'generation_mismatch' }
  }
  if (TERMINAL_SESSION_STATUSES.includes(input.session.status as never)) {
    return { status: 'rejected_stale', reason: 'session_terminal' }
  }
  if (input.session.controlMode === 'read_only') {
    return { status: 'rejected_authority', reason: 'session_read_only' }
  }

  const manifestResult = validateCapabilityManifest(input.manifest)
  if (!manifestResult.ok) {
    return { status: 'failed', reason: 'invalid_manifest', issues: manifestResult.issues }
  }
  const capability = CAPABILITY_BY_ACTION[input.command.action]
  const evaluation = evaluateCapabilityDeclaration(input.manifest.capabilities[capability])
  if (evaluation.status === 'unsupported') {
    return { status: 'unsupported', reason: 'capability_unsupported' }
  }
  if (evaluation.status === 'unqualified') {
    return { status: 'unsupported', reason: 'capability_unqualified' }
  }
  if (evaluation.status === 'temporarily_unavailable') {
    return { status: 'failed', reason: 'capability_temporarily_unavailable' }
  }

  const incompatibility = actionIsCompatible(input.command, input.session)
  if (incompatibility !== null) return { status: 'rejected_stale', reason: incompatibility }

  if (input.authority === undefined || !isOpaqueReference(input.authority.decisionRef)) {
    return { status: 'rejected_authority', reason: 'authority_decision_required' }
  }
  if (input.authority.decision !== 'allow') {
    return {
      status: 'rejected_authority',
      reason: 'authority_denied',
      authorityDecisionRef: input.authority.decisionRef,
    }
  }
  return {
    status: 'accepted',
    capability,
    authorityDecisionRef: input.authority.decisionRef,
  }
}

export type InlineExecutionResult =
  | {
      readonly status: 'applied'
      readonly evidence: Extract<AdapterOperationResult, { status: 'applied' }>['evidence']
      readonly automaticContinuation: false
    }
  | {
      readonly status: 'interaction_required'
      readonly interactionRef: OpaqueReference
      readonly automaticContinuation: false
    }
  | { readonly status: 'failed'; readonly failureCode: string; readonly automaticContinuation: false }

export function projectInlineAdapterResult(
  profile: ExecutionProfile,
  result: AdapterOperationResult,
): InlineExecutionResult {
  const profileResult = validateExecutionProfile(profile)
  if (!profileResult.ok) {
    return { status: 'failed', failureCode: 'invalid_execution_profile', automaticContinuation: false }
  }
  if (profile.executionStyle !== 'inline') {
    return { status: 'failed', failureCode: 'inline_profile_required', automaticContinuation: false }
  }
  const resultValidation = validateAdapterOperationResult(result)
  if (!resultValidation.ok) {
    return {
      status: 'failed',
      failureCode: resultValidation.failureCode,
      automaticContinuation: false,
    }
  }
  const validated = resultValidation.value
  if (validated.status === 'accepted' || validated.status === 'provider_waiting') {
    return { status: 'failed', failureCode: 'inline_nonterminal_result', automaticContinuation: false }
  }
  return { ...validated, automaticContinuation: false }
}
