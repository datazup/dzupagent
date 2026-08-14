import { isAbsolute, normalize } from 'node:path'

import type { AdapterConfig } from '../types.js'

interface ThreadExpectations {
  readonly version: string
  readonly threadId?: string | undefined
  readonly cwd?: string | undefined
  readonly model?: string | undefined
  readonly sandboxMode?: AdapterConfig['sandboxMode'] | undefined
}

export interface ValidatedThreadResponse {
  readonly threadId: string
}

export interface ValidatedTurn {
  readonly turnId: string
  readonly status: 'completed' | 'failed' | 'inProgress' | 'interrupted'
}

const MAX_REFERENCE_LENGTH = 512
const MAX_PATH_LENGTH = 4_096
const MAX_TEXT_LENGTH = 16_384
const TURN_STATUSES = new Set(['completed', 'failed', 'inProgress', 'interrupted'])
const APPROVAL_POLICIES = new Set(['never', 'on-request', 'untrusted'])
const APPROVAL_REVIEWERS = new Set(['auto_review', 'guardian_subagent', 'user'])
const SESSION_SOURCES = new Set(['appServer', 'cli', 'exec', 'unknown', 'vscode'])

export function assertThreadResponse(
  value: unknown,
  expectations: ThreadExpectations,
): ValidatedThreadResponse {
  const response = record(value)
  const thread = response && record(response['thread'])
  if (!response
    || !hasOwn(response, 'approvalPolicy', 'approvalsReviewer', 'cwd', 'model', 'modelProvider', 'sandbox', 'thread')
    || !validApprovalPolicy(response['approvalPolicy'])
    || !APPROVAL_REVIEWERS.has(string(response['approvalsReviewer']))
    || !absolutePath(response['cwd'])
    || !boundedString(response['model'], MAX_TEXT_LENGTH)
    || !boundedString(response['modelProvider'], MAX_REFERENCE_LENGTH)
    || !validSandbox(response['sandbox'])
    || !thread
    || !validThread(thread, expectations.version)
    || thread['cwd'] !== response['cwd']
    || thread['modelProvider'] !== response['modelProvider']
    || (expectations.threadId !== undefined && thread['id'] !== expectations.threadId)
    || (expectations.cwd !== undefined
      && normalize(String(response['cwd'])) !== normalize(expectations.cwd))
    || (expectations.model !== undefined && response['model'] !== expectations.model)
    || (expectations.sandboxMode !== undefined
      && sandboxType(response['sandbox']) !== expectedSandboxType(expectations.sandboxMode))) {
    throw protocolError(
      'CODEX_APP_SERVER_THREAD_INVALID',
      'Codex app-server returned an invalid or drifted thread response',
    )
  }
  return { threadId: String(thread['id']) }
}

export function assertThreadStartedNotification(
  value: unknown,
  version: string,
): string {
  const params = record(value)
  const thread = params && record(params['thread'])
  if (!params || !hasOwn(params, 'thread') || !thread || !validThread(thread, version)) {
    throw protocolError(
      'CODEX_APP_SERVER_THREAD_INVALID',
      'Codex app-server emitted an invalid thread/started notification',
    )
  }
  return String(thread['id'])
}

export function assertTurnResponse(value: unknown): ValidatedTurn {
  const response = record(value)
  const turn = response && record(response['turn'])
  if (!response || !hasOwn(response, 'turn') || !turn || !validTurn(turn)) {
    throw turnInvalid('Codex app-server returned an invalid turn/start response')
  }
  const validated = validatedTurn(turn)
  if (validated.status !== 'inProgress') {
    throw turnInvalid('Codex app-server returned a non-active turn/start response')
  }
  return validated
}

export function assertTurnNotification(
  value: unknown,
  phase: 'started' | 'completed',
): ValidatedTurn & { readonly threadId: string } {
  const params = record(value)
  const turn = params && record(params['turn'])
  if (!params
    || !hasOwn(params, 'threadId', 'turn')
    || !boundedString(params['threadId'], MAX_REFERENCE_LENGTH)
    || !turn
    || !validTurn(turn)) {
    throw turnInvalid(`Codex app-server emitted an invalid turn/${phase} notification`)
  }
  const validated = validatedTurn(turn)
  if ((phase === 'started' && validated.status !== 'inProgress')
    || (phase === 'completed' && validated.status === 'inProgress')) {
    throw turnInvalid(`Codex app-server emitted an invalid turn/${phase} status`)
  }
  return { ...validated, threadId: String(params['threadId']) }
}

function validThread(value: Readonly<Record<string, unknown>>, version: string): boolean {
  return hasOwn(
    value,
    'cliVersion',
    'createdAt',
    'cwd',
    'ephemeral',
    'id',
    'modelProvider',
    'preview',
    'sessionId',
    'source',
    'status',
    'turns',
    'updatedAt',
  )
    && value['cliVersion'] === version
    && nonNegativeInteger(value['createdAt'])
    && absolutePath(value['cwd'])
    && typeof value['ephemeral'] === 'boolean'
    && boundedString(value['id'], MAX_REFERENCE_LENGTH)
    && boundedString(value['modelProvider'], MAX_REFERENCE_LENGTH)
    && typeof value['preview'] === 'string'
    && value['preview'].length <= MAX_TEXT_LENGTH
    && boundedString(value['sessionId'], MAX_REFERENCE_LENGTH)
    && validSessionSource(value['source'])
    && validThreadStatus(value['status'])
    && Array.isArray(value['turns'])
    && nonNegativeInteger(value['updatedAt'])
}

function validTurn(value: Readonly<Record<string, unknown>>): boolean {
  return hasOwn(value, 'id', 'items', 'status')
    && boundedString(value['id'], MAX_REFERENCE_LENGTH)
    && Array.isArray(value['items'])
    && TURN_STATUSES.has(string(value['status']))
}

function validatedTurn(value: Readonly<Record<string, unknown>>): ValidatedTurn {
  return {
    turnId: String(value['id']),
    status: String(value['status']) as ValidatedTurn['status'],
  }
}

function validApprovalPolicy(value: unknown): boolean {
  if (APPROVAL_POLICIES.has(string(value))) return true
  const policy = record(value)
  const granular = policy && record(policy['granular'])
  return Boolean(policy
    && granular
    && hasOwn(granular, 'mcp_elicitations', 'rules', 'sandbox_approval')
    && typeof granular['mcp_elicitations'] === 'boolean'
    && typeof granular['rules'] === 'boolean'
    && typeof granular['sandbox_approval'] === 'boolean'
    && optionalBoolean(granular['request_permissions'])
    && optionalBoolean(granular['skill_approval']))
}

function validSandbox(value: unknown): boolean {
  const sandbox = record(value)
  if (!sandbox) return false
  const type = string(sandbox['type'])
  if (type === 'dangerFullAccess') return true
  if (type === 'readOnly') return optionalBoolean(sandbox['networkAccess'])
  if (type === 'externalSandbox') {
    return sandbox['networkAccess'] === undefined
      || boundedString(sandbox['networkAccess'], MAX_REFERENCE_LENGTH)
  }
  if (type !== 'workspaceWrite'
    || !optionalBoolean(sandbox['excludeSlashTmp'])
    || !optionalBoolean(sandbox['excludeTmpdirEnvVar'])
    || !optionalBoolean(sandbox['networkAccess'])) return false
  return sandbox['writableRoots'] === undefined
    || (Array.isArray(sandbox['writableRoots'])
      && sandbox['writableRoots'].every((root) => absolutePath(root)))
}

function sandboxType(value: unknown): string {
  return string(record(value)?.['type'])
}

function expectedSandboxType(mode: AdapterConfig['sandboxMode']): string {
  if (mode === 'read-only') return 'readOnly'
  if (mode === 'full-access') return 'dangerFullAccess'
  return 'workspaceWrite'
}

function validSessionSource(value: unknown): boolean {
  if (SESSION_SOURCES.has(string(value))) return true
  const source = record(value)
  return Boolean(source
    && ((boundedString(source['custom'], MAX_REFERENCE_LENGTH))
      || record(source['subAgent'])))
}

function validThreadStatus(value: unknown): boolean {
  const status = record(value)
  if (!status) return false
  const type = string(status['type'])
  return type === 'notLoaded'
    || type === 'idle'
    || type === 'systemError'
    || (type === 'active' && Array.isArray(status['activeFlags']))
}

function absolutePath(value: unknown): value is string {
  return boundedString(value, MAX_PATH_LENGTH) && isAbsolute(value)
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function hasOwn(
  value: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): boolean {
  return keys.every((key) => Object.hasOwn(value, key))
}

function turnInvalid(message: string): Error & { readonly code: string } {
  return protocolError('CODEX_APP_SERVER_TURN_INVALID', message)
}

function protocolError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code })
}
