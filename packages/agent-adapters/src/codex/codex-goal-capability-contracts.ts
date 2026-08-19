/**
 * Declarations and observation vocabulary for the Codex goal/app-server
 * capability probe.
 *
 * This is the leaf of the goal-capability layering: it imports nothing local,
 * which is what lets the schema, protocol, and corpus layers share the same
 * vocabulary without a file-level cycle. Every public type here is re-exported
 * from `codex-goal-capability.ts`, which remains the only supported import
 * path; the constants are internal to the layering.
 */

import type {
  ProviderSessionBackendKind,
  ProviderSessionCapability,
} from '@dzupagent/runtime-contracts/provider-session'

import type { ResolvedProbeExecutable } from '../introspection/index.js'

export type CodexGoalCapabilityBackendKind = Extract<
  ProviderSessionBackendKind,
  'app-server' | 'cli' | 'sdk'
>

export type CodexGoalCapabilityObservationFailure =
  | 'version-observation-failed'
  | 'schema-help-observation-failed'
  | 'protocol-generation-failed'
  | 'protocol-observation-timeout'
  | 'protocol-observation-output-limit'
  | 'protocol-observation-process-failure'
  | 'protocol-schema-file-limit'
  | 'protocol-schema-invalid'

export interface CodexGoalProtocolObservation {
  /** Codex version for which the schema generator ran. */
  readonly generatedForVersion: string
  /** Sanitized logical reference; never a host filesystem path. */
  readonly schemaRef: string
  /** Exact digest over sorted relative path, NUL, and raw file bytes. */
  readonly schemaDigest: string
  /** Runtime-local parsed documents. These are never copied into the descriptor. */
  readonly documents: Readonly<Record<string, unknown>>
}

/** Phase-3 name for the complete App Server schema observation. */
export type CodexAppServerProtocolObservation = CodexGoalProtocolObservation

export interface CodexGoalCapabilityMaterializationInput {
  readonly backendKind: CodexGoalCapabilityBackendKind
  readonly installedVersion?: string | undefined
  /** SHA-256 of the observed executable bytes; no host path enters the descriptor. */
  readonly executableArtifactDigest?: string | undefined
  readonly protocol?: CodexGoalProtocolObservation | undefined
  readonly observedAt: string
  readonly providerId?: string | undefined
  readonly expectedVersion?: string | undefined
  readonly expectedSchemaDigest?: string | undefined
  readonly observationFailure?: CodexGoalCapabilityObservationFailure | undefined
}

/** Phase-3 name retained alongside the phase-2 goal-only API aliases. */
export type CodexAppServerCapabilityMaterializationInput =
  CodexGoalCapabilityMaterializationInput

export interface ObserveInstalledCodexGoalCapabilityOptions {
  readonly executable: ResolvedProbeExecutable
  /** Absolute, repository-owned working directory for provider-free probing. */
  readonly cwd: string
  readonly sourceEnv?: Readonly<Record<string, string | undefined>> | undefined
  readonly observedAt?: string | undefined
  readonly expectedVersion?: string | undefined
  readonly expectedSchemaDigest?: string | undefined
  /** Tightens the framework probe ceiling; never expands it. */
  readonly timeoutMs?: number | undefined
}

export type ObserveInstalledCodexAppServerCapabilityOptions =
  ObserveInstalledCodexGoalCapabilityOptions

/**
 * Per-capability denial reasons. An absent entry means the capability was
 * observed intact; `undefined` is never a denial.
 */
export type CapabilityReasonMap =
  Partial<Readonly<Record<ProviderSessionCapability, string | undefined>>>

export const PROVIDER_ID = 'codex'
export const MAX_SCHEMA_FILES = 512
export const MAX_SCHEMA_FILE_BYTES = 1_000_000
export const MAX_SCHEMA_TOTAL_BYTES = 8_000_000
export const MAX_SCHEMA_DEPTH = 8
export const DEFAULT_OBSERVATION_TIMEOUT_MS = 10_000
export const INTERACTION_REQUESTS = [
  ['item/commandExecution/requestApproval', 'CommandExecutionRequestApprovalParams'],
  ['item/fileChange/requestApproval', 'FileChangeRequestApprovalParams'],
  ['item/tool/requestUserInput', 'ToolRequestUserInputParams'],
] as const
export const GOAL_METHODS = [
  ['thread/goal/get', 'ThreadGoalGetParams'],
  ['thread/goal/set', 'ThreadGoalSetParams'],
  ['thread/goal/clear', 'ThreadGoalClearParams'],
] as const
export const GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
] as const
export const REQUIRED_DOCUMENTS = [
  'ClientRequest.json',
  'ClientNotification.json',
  'ServerNotification.json',
  'ServerRequest.json',
  'CommandExecutionRequestApprovalParams.json',
  'FileChangeRequestApprovalParams.json',
  'ToolRequestUserInputParams.json',
  'v1/InitializeParams.json',
  'v1/InitializeResponse.json',
  'v2/ThreadStartParams.json',
  'v2/ThreadStartResponse.json',
  'v2/ThreadResumeParams.json',
  'v2/ThreadResumeResponse.json',
  'v2/ThreadStartedNotification.json',
  'v2/TurnStartParams.json',
  'v2/TurnStartResponse.json',
  'v2/TurnInterruptParams.json',
  'v2/TurnInterruptResponse.json',
  'v2/TurnStartedNotification.json',
  'v2/TurnCompletedNotification.json',
  'v2/AgentMessageDeltaNotification.json',
  'v2/ThreadTokenUsageUpdatedNotification.json',
  'v2/ThreadGoalGetParams.json',
  'v2/ThreadGoalGetResponse.json',
  'v2/ThreadGoalSetParams.json',
  'v2/ThreadGoalSetResponse.json',
  'v2/ThreadGoalClearParams.json',
  'v2/ThreadGoalClearResponse.json',
] as const
