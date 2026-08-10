import type { BaseMessage } from '@langchain/core/messages'
import type { AgentRunnerInput } from './runner-ports.js'
import type { AgentRunnerResult } from './in-memory-agent-runner.js'
import type { RunControl } from './run-control.js'
import type { LegacyRunnerExecutionProfile } from './legacy-runner-execution-profile.js'
import { digestRunnerJson } from './runner-values.js'

export const AGENT_RUNNER_NO_TOOL_DELEGATION_ADMISSION_SCHEMA =
  'dzupagent.agentRunnerNoToolDelegationAdmission/v1' as const
export const AGENT_RUNNER_NO_TOOL_DELEGATION_SOURCE_SCHEMA =
  'dzupagent.agentRunnerNoToolDelegationSource/v1' as const

export type AgentRunnerNoToolPreDispatchPolicy = 'fail-closed' | 'fallback-to-legacy'

export interface AgentRunnerNoToolDelegationSource {
  readonly schema: typeof AGENT_RUNNER_NO_TOOL_DELEGATION_SOURCE_SCHEMA
  readonly bridgeId: string
  readonly runId: string
  readonly agentId: string
  readonly behaviorDigest: string
  readonly profileDigest: string
  readonly inputDigest: string
  readonly preparedMessageDigest: string
  readonly sourceDigest: string
}

export interface AgentRunnerNoToolDelegationAdmission {
  readonly schema: typeof AGENT_RUNNER_NO_TOOL_DELEGATION_ADMISSION_SCHEMA
  readonly decision: 'delegate'
  readonly policy: AgentRunnerNoToolPreDispatchPolicy
  readonly source: AgentRunnerNoToolDelegationSource
  readonly observedMessageCount: number
  readonly observedMessageTokens: number
  readonly maxModelTurns: number
  readonly maxToolAttempts: number
  readonly admissionDigest: string
}

export interface AgentRunnerNoToolDelegationRequest {
  /** JSON-safe admission evidence recorded before the bridge is called. */
  readonly admission: AgentRunnerNoToolDelegationAdmission
  /** JSON-safe canonical input. The bridge must not add tools or structured output. */
  readonly input: AgentRunnerInput
  /** Exact dispatch-time array snapshot. The bridge must treat it as immutable. */
  readonly preparedMessages: readonly BaseMessage[]
  /** Exact profile bound to the admission and result projector. */
  readonly profile: LegacyRunnerExecutionProfile
  /** Safe-point control owned by the calling Agent instance. */
  readonly control: RunControl
  /** Optional caller cancellation signal. It is process-local and never persisted. */
  readonly signal?: AbortSignal
}

interface AgentRunnerNoToolDelegationOutcomeBase {
  readonly source: AgentRunnerNoToolDelegationSource
}

export type AgentRunnerNoToolDelegationOutcome =
  | (AgentRunnerNoToolDelegationOutcomeBase & {
      readonly status: 'completed'
      readonly result: AgentRunnerResult
      /** Exact adapter-owned assistant message used to construct the runner item. */
      readonly finalAssistant: BaseMessage
    })
  | (AgentRunnerNoToolDelegationOutcomeBase & {
      /** The bridge guarantees that AgentRunner/model dispatch did not begin. */
      readonly status: 'rejected-before-dispatch'
      readonly code: string
    })
  | (AgentRunnerNoToolDelegationOutcomeBase & {
      readonly status: 'failed-after-dispatch'
      readonly code: string
    })
  | (AgentRunnerNoToolDelegationOutcomeBase & {
      readonly status: 'outcome-unknown'
      readonly code: string
    })

/**
 * Process-local host bridge for the experimental no-tool `generate()` subset.
 *
 * Provider clients, callbacks, credentials, raw payloads, and unrestricted
 * metadata stay behind this object. Only the JSON-safe request profile/input
 * and the resulting runner state/envelope evidence may be persisted.
 */
export interface AgentRunnerNoToolDelegationBridge {
  readonly bridgeId: string
  dispatch(
    request: AgentRunnerNoToolDelegationRequest,
  ): Promise<AgentRunnerNoToolDelegationOutcome>
}

export type AgentRunnerNoToolDelegationErrorPhase =
  | 'admission'
  | 'before-dispatch'
  | 'after-dispatch'
  | 'outcome-unknown'

export type AgentRunnerNoToolDelegationReplay =
  | 'not-dispatched'
  | 'forbidden-after-dispatch'
  | 'forbidden-unknown-outcome'

/** Fixed, non-sensitive failure surfaced by the opt-in bridge coordinator. */
export class AgentRunnerNoToolDelegationError extends Error {
  readonly code: string
  readonly phase: AgentRunnerNoToolDelegationErrorPhase
  readonly replay: AgentRunnerNoToolDelegationReplay
  readonly admission?: AgentRunnerNoToolDelegationAdmission

  constructor(input: {
    readonly code: string
    readonly phase: AgentRunnerNoToolDelegationErrorPhase
    readonly replay: AgentRunnerNoToolDelegationReplay
    readonly admission?: AgentRunnerNoToolDelegationAdmission
  }) {
    super(`AgentRunner no-tool delegation failed: ${input.code}`)
    this.name = 'AgentRunnerNoToolDelegationError'
    this.code = input.code
    this.phase = input.phase
    this.replay = input.replay
    if (input.admission !== undefined) this.admission = input.admission
  }
}

function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('|') === [...expected].sort().join('|')
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u.test(value)
}

export function validateAgentRunnerNoToolDelegationSource(
  value: unknown,
): value is AgentRunnerNoToolDelegationSource {
  if (!object(value) || !exactKeys(value, [
    'schema', 'bridgeId', 'runId', 'agentId', 'behaviorDigest', 'profileDigest',
    'inputDigest', 'preparedMessageDigest', 'sourceDigest',
  ])) return false
  if (value.schema !== AGENT_RUNNER_NO_TOOL_DELEGATION_SOURCE_SCHEMA
      || !validIdentity(value.bridgeId)
      || !validIdentity(value.runId)
      || !validIdentity(value.agentId)
      || typeof value.behaviorDigest !== 'string'
      || typeof value.profileDigest !== 'string'
      || typeof value.inputDigest !== 'string'
      || typeof value.preparedMessageDigest !== 'string'
      || typeof value.sourceDigest !== 'string') return false
  const { sourceDigest: _sourceDigest, ...body } = value
  return value.sourceDigest === digestRunnerJson(body)
}

export function validateAgentRunnerNoToolDelegationAdmission(
  value: unknown,
): value is AgentRunnerNoToolDelegationAdmission {
  if (!object(value) || !exactKeys(value, [
    'schema', 'decision', 'policy', 'source', 'observedMessageCount',
    'observedMessageTokens', 'maxModelTurns', 'maxToolAttempts', 'admissionDigest',
  ])) return false
  if (value.schema !== AGENT_RUNNER_NO_TOOL_DELEGATION_ADMISSION_SCHEMA
      || value.decision !== 'delegate'
      || !['fail-closed', 'fallback-to-legacy'].includes(String(value.policy))
      || !validateAgentRunnerNoToolDelegationSource(value.source)
      || !Number.isSafeInteger(value.observedMessageCount)
      || Number(value.observedMessageCount) < 0
      || !Number.isSafeInteger(value.observedMessageTokens)
      || Number(value.observedMessageTokens) < 0
      || !Number.isSafeInteger(value.maxModelTurns)
      || Number(value.maxModelTurns) < 1
      || !Number.isSafeInteger(value.maxToolAttempts)
      || Number(value.maxToolAttempts) < 1
      || typeof value.admissionDigest !== 'string') return false
  const { admissionDigest: _admissionDigest, ...body } = value
  return value.admissionDigest === digestRunnerJson(body)
}
