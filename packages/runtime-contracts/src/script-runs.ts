export type ManagedRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'

export type ManagedRunEventLevel = 'debug' | 'info' | 'warn' | 'error'

export type ManagedRunEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'artifact.recorded'
  | 'validation.recorded'
  | 'review.decision_recorded'
  | 'approval.decision_recorded'
  | (string & {})

export type ManagedArtifactType =
  | 'plan'
  | 'report'
  | 'patch'
  | 'log'
  | 'diff'
  | 'spec'
  | 'brief'
  | 'validation'
  | 'approval'
  | 'review'
  | 'manifest'
  | 'harness'
  | 'event-log'
  | 'screenshot'
  | (string & {})

export interface ManagedRunCorrelation {
  auditRunId?: string
  planningRunId?: string
  packetId?: string
  executionRunId?: string
  correlationId?: string
}

export interface ManagedArtifactRef extends ManagedRunCorrelation {
  id: string
  runId?: string
  artifactType: ManagedArtifactType
  name: string
  scriptPath: string
  absolutePath?: string
  mimeType?: string
  checksum?: string
  checksumAlgorithm?: 'sha256' | (string & {})
  sizeBytes?: number
  producedBy?: string
  createdAt: number
  metadata?: Record<string, unknown>
}

export type ValidationStatus = 'passed' | 'failed' | 'skipped' | 'timed_out' | 'blocked'

export interface ValidationRecord extends ManagedRunCorrelation {
  id: string
  runId: string
  command: string
  cwd?: string
  status: ValidationStatus
  exitCode?: number
  startedAt: number
  completedAt?: number
  durationMs?: number
  stdout?: ManagedArtifactRef
  stderr?: ManagedArtifactRef
  artifacts?: ManagedArtifactRef[]
  summary?: string
  metadata?: Record<string, unknown>
}

export type ReviewDecision =
  | 'approved'
  | 'needs_human'
  | 'blocked_by_policy'
  | 'rejected'
  | 'changes_requested'
  | 'deferred'

export interface ReviewDecisionRecord extends ManagedRunCorrelation {
  id: string
  runId: string
  decision: ReviewDecision
  reviewer?: string
  reviewedAt: number
  reason?: string
  policyIds?: string[]
  artifacts?: ManagedArtifactRef[]
  metadata?: Record<string, unknown>
}

export type ApprovalDecision =
  | 'approved'
  | 'denied'
  | 'needs_human'
  | 'expired'
  | 'not_required'

export interface ApprovalDecisionRecord extends ManagedRunCorrelation {
  id: string
  runId: string
  decision: ApprovalDecision
  approver?: string
  decidedAt: number
  reason?: string
  requestedBy?: string
  expiresAt?: number
  artifacts?: ManagedArtifactRef[]
  metadata?: Record<string, unknown>
}

export interface ManagedRunEvent extends ManagedRunCorrelation {
  id: string
  runId: string
  type: ManagedRunEventType
  timestamp: number
  level?: ManagedRunEventLevel
  message?: string
  parentEventId?: string
  artifact?: ManagedArtifactRef
  validation?: ValidationRecord
  reviewDecision?: ReviewDecisionRecord
  approvalDecision?: ApprovalDecisionRecord
  metadata?: Record<string, unknown>
}

export interface ManagedRunSummary extends ManagedRunCorrelation {
  runId: string
  status: ManagedRunStatus
  startedAt: number
  completedAt?: number
  durationMs?: number
  eventCount: number
  artifactCount: number
  validationCounts?: Partial<Record<ValidationStatus, number>>
  reviewDecisionCounts?: Partial<Record<ReviewDecision, number>>
  approvalDecisionCounts?: Partial<Record<ApprovalDecision, number>>
  artifacts?: ManagedArtifactRef[]
  errorMessage?: string
  metadata?: Record<string, unknown>
}
