export const EXECUTION_STYLES = ['inline', 'durable'] as const
export type ExecutionStyle = (typeof EXECUTION_STYLES)[number]

export const CONTINUITY_MODES = [
  'none',
  'provider_native',
  'control_plane_managed',
] as const
export type ContinuityMode = (typeof CONTINUITY_MODES)[number]

export const COORDINATION_MODES = ['none', 'supervised'] as const
export type CoordinationMode = (typeof COORDINATION_MODES)[number]

export const SESSION_CONTROL_CAPABILITIES = [
  'observe',
  'start',
  'send_message',
  'steer_active_turn',
  'respond_interaction',
  'pause',
  'resume',
  'interrupt',
  'fork',
  'tail_events',
  'lookup_after_restart',
  'native_session_resume',
] as const
export type SessionControlCapability = (typeof SESSION_CONTROL_CAPABILITIES)[number]

export const SESSION_STATUSES = [
  'discovered',
  'idle',
  'running',
  'waiting_for_input',
  'waiting_for_approval',
  'waiting_for_dependency',
  'blocked',
  'paused',
  'unreachable',
  'completed',
  'failed',
  'cancelled',
  'unknown',
] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

export const TERMINAL_SESSION_STATUSES = ['completed', 'failed', 'cancelled'] as const
export type TerminalSessionStatus = (typeof TERMINAL_SESSION_STATUSES)[number]

export const NORMALIZED_SESSION_EVENT_TYPES = [
  'session.status_changed',
  'provider_attempt.registered',
  'provider_attempt.status_changed',
  'turn.started',
  'turn.progress',
  'interaction.requested',
  'interaction.resolved',
  'dependency.wait_registered',
  'dependency.ready',
  'command.acknowledged',
  'handoff.available',
  'ownership.released',
  'turn.completed',
  'session.terminal',
] as const
export type NormalizedSessionEventType = (typeof NORMALIZED_SESSION_EVENT_TYPES)[number]

export const INTERACTION_CLASSES = [
  'informational_clarification',
  'plan_routing_choice',
  'repository_mutation',
  'permission_or_credential',
  'dependency_wait',
  'provider_specific',
  'unsupported_native_control',
] as const
export type InteractionClass = (typeof INTERACTION_CLASSES)[number]

export const SESSION_CONTROL_SCHEMAS = {
  executionProfile: 'dzupagent.session-control.execution-profile/v1',
  capabilityManifest: 'dzupagent.session-control.capability-manifest/v1',
  sessionSnapshot: 'dzupagent.session-control.session-snapshot/v1',
  sessionEvent: 'dzupagent.session-control.session-event/v1',
  command: 'dzupagent.session-control.command/v1',
  commandRecord: 'dzupagent.session-control.command-record/v1',
  conformanceFixture: 'dzupagent.session-control.conformance-fixture/v1',
} as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

declare const opaqueReferenceBrand: unique symbol
export type OpaqueReference = string & { readonly [opaqueReferenceBrand]: true }

declare const sha256DigestBrand: unique symbol
export type Sha256Digest = string & { readonly [sha256DigestBrand]: true }

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

export interface ExecutionProfile {
  readonly schema: typeof SESSION_CONTROL_SCHEMAS.executionProfile
  readonly executionStyle: ExecutionStyle
  readonly continuity: ContinuityMode
  readonly coordination: CoordinationMode
}

export interface ExecutionPlan {
  readonly createDurableSession: boolean
  readonly requiresSupervisor: boolean
  readonly requiresReviewer: false
  readonly requiresSummarization: false
  readonly automaticFallback: false
  readonly interactionHandling: 'return_to_caller' | 'session_event'
}

export interface ValidationIssue {
  readonly path: string
  readonly code: string
  readonly message: string
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }
