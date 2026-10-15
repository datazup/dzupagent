import type { AIMessage, ToolMessage } from '@langchain/core/messages'
import type { AgentRunnerNoToolDelegationAdmission, AgentRunnerNoToolDelegationRequest,
  AgentRunnerNoToolDelegationSource, AgentRunnerNoToolPreDispatchPolicy } from './no-tool-generate-delegation.js'
import type { AgentRunnerReadOnlyToolPort, AgentRunnerResult } from './runner-ports.js'
import { digestRunnerJson } from './runner-values.js'

export interface AgentRunnerReadToolBinding {
  readonly toolId: string
  readonly toolRevision: string
  readonly effectClass: 'read'
  readonly maxCalls: 1
  readonly timingPolicy: 'host-elapsed-ms/v1'
}

export interface AgentRunnerReadToolDelegationSource extends Omit<AgentRunnerNoToolDelegationSource, 'schema'> {
  readonly schema: 'dzupagent.agentRunnerReadToolDelegationSource/v1'
  readonly readTool: AgentRunnerReadToolBinding
}

export interface AgentRunnerReadToolDelegationAdmission extends Omit<AgentRunnerNoToolDelegationAdmission, 'schema' | 'source'> {
  readonly schema: 'dzupagent.agentRunnerReadToolDelegationAdmission/v1'
  readonly source: AgentRunnerReadToolDelegationSource
}

export interface AgentRunnerReadToolDelegationRequest extends Omit<AgentRunnerNoToolDelegationRequest, 'admission'> {
  readonly admission: AgentRunnerReadToolDelegationAdmission
  /** Single-use caller-owned port; bridges must use it, never replay the legacy tool. */
  readonly readTool: AgentRunnerReadOnlyToolPort
}

export type AgentRunnerReadToolDelegationOutcome =
  | { readonly status: 'completed'; readonly source: AgentRunnerReadToolDelegationSource
      readonly result: AgentRunnerResult; readonly assistantCall: AIMessage
      readonly toolMessage: ToolMessage; readonly finalAssistant: AIMessage }
  | { readonly status: 'rejected-before-dispatch' | 'failed-after-dispatch' | 'outcome-unknown'
      readonly source: AgentRunnerReadToolDelegationSource; readonly code: string }

/** Host assertion of a configured read tool, with no provider/client state persisted. */
export interface AgentRunnerReadToolDelegationBridge {
  readonly bridgeId: string
  readonly binding: AgentRunnerReadToolBinding
  dispatch(request: AgentRunnerReadToolDelegationRequest): Promise<AgentRunnerReadToolDelegationOutcome>
}

export class AgentRunnerReadToolDelegationError extends Error {
  constructor(
    readonly code: string,
    readonly phase: 'admission' | 'before-dispatch' | 'after-dispatch' | 'outcome-unknown',
    readonly replay: 'not-dispatched' | 'forbidden-after-dispatch' | 'forbidden-unknown-outcome',
    readonly admission?: AgentRunnerReadToolDelegationAdmission,
    /** Original failure, kept off the public message. */
    options?: { readonly cause?: unknown },
  ) {
    super(
      `AgentRunner read-tool delegation failed: ${code}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'AgentRunnerReadToolDelegationError'
  }
}

export function readToolDataRecord(value: unknown, fields?: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertySymbols(value).length === 0
    && (fields === undefined || Object.getOwnPropertyNames(value).sort().join('|') === [...fields].sort().join('|'))
    && Object.getOwnPropertyNames(value).every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field)
      return descriptor?.enumerable === true && 'value' in descriptor
    })
}

export function readToolIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u.test(value)
}

export function validateAgentRunnerReadToolBinding(value: unknown): value is AgentRunnerReadToolBinding {
  return readToolDataRecord(value, ['toolId', 'toolRevision', 'effectClass', 'maxCalls', 'timingPolicy'])
    && readToolIdentity(value.toolId) && readToolIdentity(value.toolRevision)
    && value.effectClass === 'read' && value.maxCalls === 1 && value.timingPolicy === 'host-elapsed-ms/v1'
}

export function validateAgentRunnerReadToolDelegationSource(value: unknown): value is AgentRunnerReadToolDelegationSource {
  if (!readToolDataRecord(value, ['schema', 'bridgeId', 'runId', 'agentId', 'behaviorDigest',
    'profileDigest', 'inputDigest', 'preparedMessageDigest', 'readTool', 'sourceDigest'])
    || value.schema !== 'dzupagent.agentRunnerReadToolDelegationSource/v1'
    || !readToolIdentity(value.bridgeId) || !readToolIdentity(value.runId) || !readToolIdentity(value.agentId)
    || !validateAgentRunnerReadToolBinding(value.readTool)
    || ['behaviorDigest', 'profileDigest', 'inputDigest', 'preparedMessageDigest', 'sourceDigest']
      .some((field) => typeof value[field] !== 'string' || value[field] === '')) return false
  const { sourceDigest, ...body } = value
  return sourceDigest === digestRunnerJson(body)
}

export function validateAgentRunnerReadToolDelegationAdmission(value: unknown): value is AgentRunnerReadToolDelegationAdmission {
  if (!readToolDataRecord(value, ['schema', 'decision', 'policy', 'source', 'observedMessageCount',
    'observedMessageTokens', 'maxModelTurns', 'maxToolAttempts', 'admissionDigest'])
    || value.schema !== 'dzupagent.agentRunnerReadToolDelegationAdmission/v1' || value.decision !== 'delegate'
    || (value.policy !== 'fail-closed' && value.policy !== 'fallback-to-legacy')
    || !validateAgentRunnerReadToolDelegationSource(value.source)
    || !Number.isSafeInteger(value.maxModelTurns) || Number(value.maxModelTurns) < 2
    || value.maxToolAttempts !== 1 || !Number.isSafeInteger(value.observedMessageCount)
    || Number(value.observedMessageCount) < 0 || !Number.isSafeInteger(value.observedMessageTokens)
    || Number(value.observedMessageTokens) < 0) return false
  const { admissionDigest, ...body } = value
  return admissionDigest === digestRunnerJson(body)
}

export type AgentRunnerReadToolPreDispatchPolicy = AgentRunnerNoToolPreDispatchPolicy

