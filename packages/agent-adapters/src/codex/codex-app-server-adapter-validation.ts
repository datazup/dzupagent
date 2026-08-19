import { isAbsolute } from 'node:path'

import {
  PROVIDER_SESSION_OPERATION_SCHEMA,
  PROVIDER_SESSION_REFERENCE_SCHEMA,
  type ProviderSessionAttemptBinding,
  type ProviderSessionInterruptTurnRequest,
} from '@dzupagent/runtime-contracts/provider-session'

import type { AgentInput } from '../types.js'
import {
  MAX_PROMPT_LENGTH,
  MAX_REFERENCE_LENGTH,
  REQUIRED_BASE_CAPABILITIES,
  adapterError,
  staleTurnError,
  type ActiveRun,
  type CodexAppServerAdapterOptions,
} from './codex-app-server-adapter-contracts.js'
import { assertExactCodexAppServerAdmission } from './codex-app-server-admission.js'

export function assertAppServerAdmission(options: CodexAppServerAdapterOptions): void {
  assertExactCodexAppServerAdmission(
    options,
    REQUIRED_BASE_CAPABILITIES,
    {
      binding: 'Codex app-server requires an admitted exact base-capability binding',
      executable: 'Codex app-server requires a resolved qualified executable identity',
    },
  )
}

export function assertInput(input: AgentInput): void {
  if (!boundedText(input.prompt, MAX_PROMPT_LENGTH)) {
    throw adapterError(
      'CODEX_APP_SERVER_PROMPT_INVALID',
      'Codex app-server prompt must be non-empty and bounded',
    )
  }
  const cwd = input.workingDirectory
  if (cwd !== undefined && (!isAbsolute(cwd) || cwd.length > 4_096)) {
    throw adapterError(
      'CODEX_APP_SERVER_CWD_INVALID',
      'Codex app-server working directory is invalid',
    )
  }
}

/**
 * Every inbound frame is checked against the one thread and turn this run owns.
 * A single client connection can outlive an interrupted turn, so an event that
 * names a different turn is not merely unexpected -- accepting it would let a
 * retired turn contribute to the result of the live one.
 *
 * `nestedTurn` selects where the identifier lives: notifications that carry a
 * full turn payload nest it under `turn.id`, the rest use a flat `turnId`.
 */
export function assertRunEventIdentity(
  params: Readonly<Record<string, unknown>>,
  run: ActiveRun,
  nestedTurn: boolean,
): void {
  if (stringValue(params['threadId']) !== run.threadId) throw staleTurnError()
  const turnId = nestedTurn
    ? stringValue(objectValue(params['turn'])['id'])
    : stringValue(params['turnId'])
  if (turnId !== run.turnId) throw staleTurnError()
}

export function assertInterruptRequest(
  request: ProviderSessionInterruptTurnRequest,
  binding: ProviderSessionAttemptBinding,
): void {
  if (
    request.schema !== PROVIDER_SESSION_OPERATION_SCHEMA
    || request.kind !== 'interrupt-turn'
    || request.attemptBindingId !== binding.bindingId
    || !boundedText(request.operationId, MAX_REFERENCE_LENGTH)
    || request.session.schema !== PROVIDER_SESSION_REFERENCE_SCHEMA
    || request.session.kind !== 'session'
    || !boundedText(request.session.opaqueId, MAX_REFERENCE_LENGTH)
    || request.turn.schema !== PROVIDER_SESSION_REFERENCE_SCHEMA
    || request.turn.kind !== 'turn'
    || !boundedText(request.turn.opaqueId, MAX_REFERENCE_LENGTH)
  ) {
    throw new Error('Invalid provider-session interrupt-turn request')
  }
}

/**
 * `turn/interrupt` acknowledges with an empty object and nothing else. The check
 * is exact rather than truthy because a provider that answers with a payload has
 * not agreed to the interrupt semantics the adapter is relying on.
 */
export function assertExactInterruptResponse(value: unknown): void {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 0
  ) {
    throw adapterError(
      'CODEX_APP_SERVER_INTERRUPT_RESPONSE_INVALID',
      'Codex app-server returned an invalid turn/interrupt response',
    )
  }
}

export function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

export function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
