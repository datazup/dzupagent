import type { CoordinationSha256Digest, CoordinationExecutionProviderId, CoordinationExecutionBackend } from '@dzupagent/adapter-types'

export const COORDINATION_ATTEMPT_CORRELATION_SCHEMA =
  'dzupagent.coordinationAttemptCorrelation/v2' as const

export interface CoordinationAttemptCorrelation {
  readonly schema: typeof COORDINATION_ATTEMPT_CORRELATION_SCHEMA
  readonly planDigest: CoordinationSha256Digest
  readonly requestDigest: CoordinationSha256Digest
  readonly assignmentDigest: CoordinationSha256Digest
  readonly canonicalSeal: CoordinationSha256Digest
  readonly assignmentId: string
  readonly attemptId: string
  /** The coordination session the assignment enrolled. */
  readonly sessionId: string
  /** The execution binding that issued the plan's execution fact. */
  readonly bindingId: string
  /** Opaque provider-session reference the attempt opens. */
  readonly sessionRef: string
  readonly providerId: CoordinationExecutionProviderId
  readonly backend: CoordinationExecutionBackend
  /** The plan's agent host; `null` is the provider's own host. Never merged into `providerId`. */
  readonly agentHost: string | null
  readonly tariffRef: string
}

