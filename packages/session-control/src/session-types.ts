import type {
  SESSION_CONTROL_SCHEMAS,
  ExecutionProfile,
  InteractionClass,
  JsonObject,
  NormalizedSessionEventType,
  OpaqueReference,
  SessionStatus,
  Sha256Digest,
  ValidationIssue,
} from './contracts.js'
import type { SessionControlMode } from './commands.js'

export const SESSION_ORIGINS = ['managed', 'attached', 'discovered_external'] as const
export type SessionOrigin = (typeof SESSION_ORIGINS)[number]

export const SESSION_EVENT_SOURCES = [
  'provider_adapter',
  'control_plane',
  'worker',
  'host',
] as const
export type SessionEventSource = (typeof SESSION_EVENT_SOURCES)[number]

export interface ProviderAttemptSnapshot {
  readonly attemptRef: OpaqueReference
  readonly status: SessionStatus
}

export interface PendingInteraction {
  readonly interactionRef: OpaqueReference
  readonly interactionClass: InteractionClass
}

export interface SessionEventReceipt {
  readonly eventId: OpaqueReference
  readonly eventDigest: Sha256Digest
  readonly sequence: number
}

export interface SessionSnapshot {
  readonly schema: typeof SESSION_CONTROL_SCHEMAS.sessionSnapshot
  readonly sessionRef: OpaqueReference
  readonly profile: ExecutionProfile
  readonly origin: SessionOrigin
  readonly controlMode: SessionControlMode
  readonly generation: number
  readonly eventSequence: number
  readonly status: SessionStatus
  readonly attempts: readonly ProviderAttemptSnapshot[]
  readonly pendingInteraction?: PendingInteraction
  readonly pendingDependencyRef?: OpaqueReference
  readonly lastHandoffRef?: OpaqueReference
  readonly lastEventReceipt?: SessionEventReceipt
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CreateSessionSnapshotInput {
  readonly sessionRef: OpaqueReference
  readonly profile: ExecutionProfile
  readonly origin: SessionOrigin
  readonly status: SessionStatus
  readonly controlMode?: SessionControlMode
  readonly recordedAt: string
}

export interface NormalizedSessionEvent {
  readonly schema: typeof SESSION_CONTROL_SCHEMAS.sessionEvent
  readonly eventId: OpaqueReference
  readonly eventDigest: Sha256Digest
  readonly sessionRef: OpaqueReference
  readonly sequence: number
  readonly occurredAt: string
  readonly recordedAt: string
  readonly source: SessionEventSource
  readonly type: NormalizedSessionEventType
  readonly payload: JsonObject
}

export type CreateSessionSnapshotResult =
  | { readonly ok: true; readonly snapshot: SessionSnapshot }
  | { readonly ok: false; readonly issue: ValidationIssue }

export type SessionReducerResult =
  | { readonly ok: true; readonly snapshot: SessionSnapshot; readonly replayed: boolean }
  | { readonly ok: false; readonly issue: ValidationIssue }
