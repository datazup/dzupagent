import { describe, expect, it } from 'vitest'
import type {
  ApprovalDecisionRecord,
  ManagedArtifactRef,
  ManagedRunEvent,
  ManagedRunSummary,
  ReviewDecisionRecord,
  ValidationRecord,
} from '../index.js'

describe('runtime-contracts script-run seam', () => {
  it('keeps managed artifacts and run events constructable', () => {
    const artifact: ManagedArtifactRef = {
      id: 'artifact-1',
      runId: 'run-1',
      artifactType: 'validation',
      name: 'VALIDATION.md',
      scriptPath: 'implementation/P001/VALIDATION.md',
      checksum: 'abc123',
      checksumAlgorithm: 'sha256',
      sizeBytes: 128,
      producedBy: 'yarn workspace @dzupagent/runtime-contracts test',
      createdAt: 1_000,
      auditRunId: 'audit-1',
      planningRunId: 'planning-1',
      packetId: 'P001',
      correlationId: 'corr-1',
    }

    const event: ManagedRunEvent = {
      id: 'event-1',
      runId: 'run-1',
      type: 'artifact.recorded',
      timestamp: 1_001,
      level: 'info',
      artifact,
      packetId: 'P001',
      correlationId: 'corr-1',
    }

    expect(event.artifact?.artifactType).toBe('validation')
    expect(event.artifact?.scriptPath).toBe('implementation/P001/VALIDATION.md')
  })

  it('keeps validation, review, approval, and summary records constructable', () => {
    const validation: ValidationRecord = {
      id: 'validation-1',
      runId: 'run-1',
      command: 'yarn test',
      status: 'passed',
      exitCode: 0,
      startedAt: 1_000,
      completedAt: 1_500,
      durationMs: 500,
      packetId: 'P001',
    }

    const review: ReviewDecisionRecord = {
      id: 'review-1',
      runId: 'run-1',
      decision: 'needs_human',
      reviewedAt: 1_600,
      reason: 'public API change',
      policyIds: ['PUBLIC_API_CHANGE'],
      packetId: 'P001',
    }

    const approval: ApprovalDecisionRecord = {
      id: 'approval-1',
      runId: 'run-1',
      decision: 'approved',
      approver: 'human',
      decidedAt: 1_700,
      packetId: 'P001',
    }

    const summary: ManagedRunSummary = {
      runId: 'run-1',
      status: 'completed',
      startedAt: 1_000,
      completedAt: 2_000,
      durationMs: 1_000,
      eventCount: 4,
      artifactCount: 1,
      validationCounts: { passed: 1 },
      reviewDecisionCounts: { needs_human: 1 },
      approvalDecisionCounts: { approved: 1 },
    }

    expect(validation.status).toBe('passed')
    expect(review.decision).toBe('needs_human')
    expect(approval.decision).toBe('approved')
    expect(summary.validationCounts?.passed).toBe(1)
  })
})
