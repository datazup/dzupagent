import { describe, expect, it, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { BaseStore } from '@langchain/langgraph'
import { RecoveryCopilot } from '../recovery/recovery-copilot.js'
import type {
  FailureContext,
  RecoveryPlan,
} from '../recovery/recovery-types.js'
import { attemptRecovery } from '../pipeline/pipeline-runtime/node-side-effects.js'
import type { PipelineRuntimeConfig } from '../pipeline/pipeline-runtime-types.js'
import {
  RecoveryFeedback,
  type RecoveryLesson,
} from '../self-correction/recovery-feedback.js'
import { LearningCandidateService } from '../self-correction/learning-candidate-service.js'

interface TestStore extends BaseStore {
  readonly rows: Map<string, Record<string, unknown>>
}

function makeStore(): TestStore {
  const rows = new Map<string, Record<string, unknown>>()

  return {
    rows,
    async put(namespace: string[], key: string, value: Record<string, unknown>) {
      rows.set(`${namespace.join('/')}/${key}`, value)
    },
    async get(namespace: string[], key: string) {
      const value = rows.get(`${namespace.join('/')}/${key}`)
      return value === undefined ? null : { namespace, key, value }
    },
    async delete(namespace: string[], key: string) {
      rows.delete(`${namespace.join('/')}/${key}`)
    },
    async search(namespace: string[]) {
      const prefix = `${namespace.join('/')}/`
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({
          namespace,
          key: key.slice(prefix.length),
          value,
        }))
    },
    async batch() { return [] },
    async start() {},
    async stop() {},
  } as unknown as TestStore
}

function makeLesson(
  id: string,
  tenantId: string,
  overrides: Partial<RecoveryLesson> = {},
): RecoveryLesson {
  return {
    id,
    errorType: 'build_failure',
    errorFingerprint: 'shared-fingerprint',
    nodeId: 'shared-node',
    strategy: 'retry',
    outcome: 'success',
    summary: `${tenantId} recovered`,
    timestamp: new Date('2026-08-18T08:00:00.000Z'),
    tenantId,
    ...overrides,
  }
}

function makeFailure(
  tenantId: string | undefined,
  runId: string,
): FailureContext {
  return {
    type: 'build_failure',
    error: 'Build failed with TypeScript error',
    runId,
    nodeId: 'shared-node',
    timestamp: new Date('2026-08-18T08:00:00.000Z'),
    previousAttempts: 0,
    ...(tenantId !== undefined ? { tenantId } : {}),
  }
}

function makeCopilot(feedback: RecoveryFeedback): RecoveryCopilot {
  return new RecoveryCopilot({
    eventBus: createEventBus(),
    feedback,
    actionHandler: vi.fn().mockResolvedValue('recovered'),
  })
}

function auditEntry(runId: string) {
  return {
    runId,
    nodeId: 'shared-node',
    event: 'policy_applied' as const,
    actor: 'system' as const,
    detail: 'tenant-scoped audit',
    timestamp: new Date('2026-08-18T08:01:00.000Z'),
  }
}

function pipelineConfig(
  recover: (context: FailureContext) => Promise<{ success: boolean; summary: string }>,
  tenantScope?: { mode: 'legacy-default' } | { mode: 'scoped'; tenantId: string },
): PipelineRuntimeConfig {
  return {
    definition: {} as PipelineRuntimeConfig['definition'],
    nodeExecutor: async (nodeId) => ({ nodeId, output: null, durationMs: 0 }),
    recoveryCopilot: {
      copilot: { recover } as unknown as RecoveryCopilot,
      ...(tenantScope !== undefined ? { tenantScope } : {}),
    },
  }
}

const recoveryCounter = {
  get: () => 0,
  increment: () => 1,
}

describe('T2-6A recovery tenant ownership', () => {
  it('stamps the production lesson and retrieves only the requesting tenant staged lessons', async () => {
    const feedback = new RecoveryFeedback()
    const copilot = makeCopilot(feedback)

    await copilot.recover(makeFailure('tenant-a', 'run-a'))
    await copilot.recover(makeFailure('tenant-b', 'run-b'))

    const tenantA = feedback.listPendingCandidates('tenant-a')
    expect(tenantA).toHaveLength(1)
    expect(tenantA[0]?.lesson.tenantId).toBe('tenant-a')

    const lessons = await feedback.retrieveSimilar(
      'build_failure',
      'shared-node',
      5,
      'tenant-a',
    )
    expect(lessons.map((lesson) => lesson.tenantId)).toEqual(['tenant-a'])
  })

  it('filters durable lessons and preserves the exact tenant through promotion and hydration', async () => {
    const store = makeStore()
    const feedback = new RecoveryFeedback({ store })
    const tenantAId = await feedback.recordOutcome(makeLesson('lesson-a', 'tenant-a'))
    const tenantBId = await feedback.recordOutcome(makeLesson('lesson-b', 'tenant-b'))

    await expect(
      feedback.promoteCandidateDetailed(tenantAId, 'reviewer-a', 'tenant-a'),
    ).resolves.toEqual({ accepted: true, persisted: true })
    await expect(
      feedback.promoteCandidateDetailed(tenantBId, 'reviewer-b', 'tenant-b'),
    ).resolves.toEqual({ accepted: true, persisted: true })

    const reloaded = new RecoveryFeedback({ store })
    const lessons = await reloaded.retrieveSimilar(
      'build_failure',
      'shared-node',
      5,
      'tenant-a',
    )

    expect(lessons).toHaveLength(1)
    expect(lessons[0]?.id).toBe('lesson-a')
    expect(lessons[0]?.tenantId).toBe('tenant-a')
  })

  it('enforces tenant ownership inside candidate list and get operations', async () => {
    const feedback = new RecoveryFeedback()
    const tenantAId = await feedback.recordOutcome(makeLesson('lesson-a', 'tenant-a'))
    const tenantBId = await feedback.recordOutcome(makeLesson('lesson-b', 'tenant-b'))

    expect(feedback.listPendingCandidates('tenant-a').map(({ id }) => id)).toEqual([
      tenantAId,
    ])
    expect(feedback.getCandidate(tenantAId, 'tenant-a')?.id).toBe(tenantAId)
    expect(feedback.getCandidate(tenantBId, 'tenant-a')).toBeUndefined()
  })

  it('rejects a cross-tenant promotion without state, audit, or durable writes', async () => {
    const store = makeStore()
    const feedback = new RecoveryFeedback({ store })
    const candidateId = await feedback.recordOutcome(makeLesson('lesson-b', 'tenant-b'))
    const before = feedback.getCandidate(candidateId, 'tenant-b')!
    const auditLength = before.auditTrail.length

    await expect(
      feedback.promoteCandidateDetailed(candidateId, 'reviewer-a', 'tenant-a'),
    ).resolves.toEqual({ accepted: false, persisted: false })

    const after = feedback.getCandidate(candidateId, 'tenant-b')!
    expect(after.status).toBe('pending')
    expect(after.auditTrail).toHaveLength(auditLength)
    expect(store.rows.size).toBe(0)
  })

  it('rejects a cross-tenant rejection without state or audit mutation', async () => {
    const feedback = new RecoveryFeedback()
    const candidateId = await feedback.recordOutcome(makeLesson('lesson-b', 'tenant-b'))
    const before = feedback.getCandidate(candidateId, 'tenant-b')!
    const auditLength = before.auditTrail.length

    expect(feedback.rejectCandidate(candidateId, 'reviewer-a', 'tenant-a')).toBe(false)

    const after = feedback.getCandidate(candidateId, 'tenant-b')!
    expect(after.status).toBe('pending')
    expect(after.auditTrail).toHaveLength(auditLength)
  })

  it('rejects a cross-tenant audit append without mutating the candidate', async () => {
    const feedback = new RecoveryFeedback()
    const candidateId = await feedback.recordOutcome(makeLesson('lesson-b', 'tenant-b'))
    const before = feedback.getCandidate(candidateId, 'tenant-b')!
    const auditLength = before.auditTrail.length

    feedback.appendCandidateAuditEntry(candidateId, auditEntry('run-a'), 'tenant-a')

    expect(feedback.getCandidate(candidateId, 'tenant-b')?.auditTrail).toHaveLength(
      auditLength,
    )
  })

  it('rejects cross-tenant validation before counters, audit, or auto-action change', async () => {
    const feedback = new RecoveryFeedback({
      promotionPolicy: { minScore: 80, minSuccessRuns: 1, maxFailureRuns: 1 },
    })
    const candidateId = await feedback.recordOutcome(makeLesson('lesson-b', 'tenant-b'))
    const before = feedback.getCandidate(candidateId, 'tenant-b')!
    const auditLength = before.auditTrail.length

    await expect(
      feedback.recordValidationOutcome(
        { candidateId, runId: 'run-a', score: 100 },
        'tenant-a',
      ),
    ).resolves.toEqual({
      candidateId,
      status: 'pending',
      autoActioned: false,
      successRunCount: 0,
      failureRunCount: 0,
      avgValidationScore: 0,
    })

    const after = feedback.getCandidate(candidateId, 'tenant-b')!
    expect(after.status).toBe('pending')
    expect(after.successRunCount).toBeUndefined()
    expect(after.auditTrail).toHaveLength(auditLength)
  })

  it('passes tenant identity through the candidate service to backend enforcement', async () => {
    const feedback = new RecoveryFeedback()
    const service = new LearningCandidateService(feedback)
    const candidateId = await feedback.recordOutcome(makeLesson('lesson-a', 'tenant-a'))
    const getCandidate = vi.spyOn(feedback, 'getCandidate')
    const promoteCandidate = vi.spyOn(feedback, 'promoteCandidateDetailed')

    expect(service.get(candidateId, 'tenant-a')?.id).toBe(candidateId)
    await service.promote(candidateId, 'reviewer-a', 'tenant-a')

    expect(getCandidate).toHaveBeenCalledWith(candidateId, 'tenant-a')
    expect(promoteCandidate).toHaveBeenCalledWith(
      candidateId,
      'reviewer-a',
      'tenant-a',
    )
  })

  it('calculates durable success rates inside one tenant only', async () => {
    const store = makeStore()
    const feedback = new RecoveryFeedback({ store })
    const tenantAId = await feedback.recordOutcome(makeLesson('lesson-a', 'tenant-a'))
    const tenantBId = await feedback.recordOutcome(makeLesson('lesson-b', 'tenant-b', {
      outcome: 'failure',
    }))
    await feedback.promoteCandidateDetailed(tenantAId, 'reviewer-a', 'tenant-a')
    await feedback.promoteCandidateDetailed(tenantBId, 'reviewer-b', 'tenant-b')

    await expect(feedback.getSuccessRate('build_failure', 'tenant-a')).resolves.toEqual({
      total: 1,
      successes: 1,
      rate: 1,
    })
  })

  it('propagates a configured scoped tenant into the pipeline failure context', async () => {
    const recover = vi.fn().mockResolvedValue({ success: false, summary: 'not recovered' })

    await attemptRecovery(
      pipelineConfig(recover, { mode: 'scoped', tenantId: 'tenant-a' }),
      () => {},
      recoveryCounter,
      'shared-node',
      'agent',
      'Build failed',
      'run-a',
    )

    expect(recover).toHaveBeenCalledOnce()
    expect(recover.mock.calls[0]?.[0]).toMatchObject({ tenantId: 'tenant-a' })
  })

  it('fails closed before recovery when scoped pipeline tenant identity is blank', async () => {
    const recover = vi.fn().mockResolvedValue({ success: true, summary: 'recovered' })

    await expect(
      attemptRecovery(
        pipelineConfig(recover, { mode: 'scoped', tenantId: '   ' }),
        () => {},
        recoveryCounter,
        'shared-node',
        'agent',
        'Build failed',
        'run-blank',
      ),
    ).rejects.toThrow(/tenantId.*non-empty/i)
    expect(recover).not.toHaveBeenCalled()
  })

  it('retains explicit legacy-default pipeline compatibility', async () => {
    const recover = vi.fn().mockResolvedValue({ success: false, summary: 'not recovered' })

    await attemptRecovery(
      pipelineConfig(recover, { mode: 'legacy-default' }),
      () => {},
      recoveryCounter,
      'shared-node',
      'agent',
      'Build failed',
      'run-default',
    )

    expect(recover.mock.calls[0]?.[0]).toMatchObject({ tenantId: 'default' })
  })

  it('rejects a blank direct failure tenant before execution or persistence', async () => {
    const feedback = new RecoveryFeedback()
    const actionHandler = vi.fn().mockResolvedValue('recovered')
    const copilot = new RecoveryCopilot({
      eventBus: createEventBus(),
      feedback,
      actionHandler,
    })

    await expect(copilot.recover(makeFailure('  ', 'run-blank'))).rejects.toThrow(
      /tenantId.*non-empty/i,
    )
    expect(actionHandler).not.toHaveBeenCalled()
    expect(feedback.listPendingCandidates()).toEqual([])
  })

  it('keeps direct callers without a tenant in the default tenant', async () => {
    const feedback = new RecoveryFeedback()
    const copilot = makeCopilot(feedback)

    const result = await copilot.recover(makeFailure(undefined, 'run-default'))

    expect(result.plan.failureContext.tenantId).toBe('default')
    expect(feedback.listPendingCandidates('default')).toHaveLength(1)
    expect(feedback.listPendingCandidates('default')[0]?.lesson.tenantId).toBe('default')
  })

  it('keeps the action handler plan tenant identical to the normalized failure tenant', async () => {
    const feedback = new RecoveryFeedback()
    const plans: RecoveryPlan[] = []
    const copilot = new RecoveryCopilot({
      eventBus: createEventBus(),
      feedback,
      actionHandler: vi.fn(async (_action, plan) => {
        plans.push(plan)
        return 'recovered'
      }),
    })

    await copilot.recover(makeFailure('  tenant-a  ', 'run-trimmed'))

    expect(plans[0]?.failureContext.tenantId).toBe('tenant-a')
    expect(feedback.listPendingCandidates('tenant-a')).toHaveLength(1)
  })
})
