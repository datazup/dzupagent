import { createInMemoryMemoryOutbox } from '../workers/index.js'
import { digestWorkerValue } from '../workers/snapshot.js'
import type { MemoryConsolidationPort } from '../workers/types.js'
import type { MemoryBenchmarkProfileV1 } from './benchmark-profile-v1.js'
import {
  createMemoryConformanceSuiteV1,
  type InternalMemoryConformanceCaseV1,
  type MemoryConformanceSuiteV1,
} from './conformance-core-v1.js'
import {
  WORKER_TIMES,
  workerAdmissionResult,
  workerClaimInput,
  workerCompletingPort,
  workerExecutionResult,
  workerPrepareInput,
  workerReconcileInput,
  workerReconciliationResult,
  workerRunInput,
} from './worker-conformance-fixtures-v1.js'

export function createMemoryWorkerConformanceSuite(
  profile: MemoryBenchmarkProfileV1,
): MemoryConformanceSuiteV1 {
  return createMemoryConformanceSuiteV1({
    suiteId: 'memory-worker-conformance',
    suiteVersion: 'v1',
    domain: 'worker',
    fixtureSetId: 'invented-memory-worker-fixtures',
    fixtureVersion: 'v1',
    profile,
    cases: workerCases(),
  })
}

function workerCases(): readonly InternalMemoryConformanceCaseV1[] {
  return [
    passCase('worker-reference-only-envelope', 'reference-only-contract', () => {
      const outbox = createInMemoryMemoryOutbox()
      try {
        outbox.prepare({ ...workerPrepareInput(), content: 'invented-memory-text' })
        return false
      } catch {
        return true
      }
    }),
    passCase('worker-scoped-idempotency', 'scoped-idempotency', () => {
      const outbox = createInMemoryMemoryOutbox()
      const first = outbox.prepare(workerPrepareInput())
      const replay = [outbox.enqueue(first).status, outbox.enqueue(first).status]
      const secondScope = { tenantId: 'invented-tenant-2', namespace: 'semantic' }
      const second = outbox.prepare(workerPrepareInput({
        job: { ...workerPrepareInput().job as object, scope: secondScope },
      }))
      return replay.join(',') === 'enqueued,replayed'
        && outbox.enqueue(second).status === 'enqueued'
        && outbox.inspect().entries.length === 2
    }),
    passCase('worker-duplicate-envelope-identity-conflict', 'envelope-identity', () => {
      const outbox = createInMemoryMemoryOutbox()
      outbox.enqueue(outbox.prepare(workerPrepareInput()))
      const conflict = outbox.prepare(workerPrepareInput({
        idempotencyKey: 'idempotency-002',
        job: { ...workerPrepareInput().job as object, sourceRevision: 3 },
      }))
      const result = outbox.enqueue(conflict)
      return result.status === 'rejected'
        && result.reasonCode === 'envelope-identity-conflict'
        && outbox.inspect().entries.length === 1
    }),
    asyncCase('worker-current-admission-required', 'current-admission', async () => {
      const { outbox, lease } = claimedOutbox()
      let executeCalls = 0
      const port: MemoryConsolidationPort = {
        admit: async request => workerAdmissionResult(request, 'denied'),
        execute: async () => { executeCalls += 1 },
        reconcile: async () => undefined,
      }
      const result = await outbox.runClaimed(workerRunInput(lease), port)
      return result.status === 'dead-lettered' && executeCalls === 0
    }),
    asyncMetricCase('worker-candidate-only-output', 'candidate-review-boundary', async () => {
      const { outbox, lease } = claimedOutbox()
      const result = await outbox.runClaimed(workerRunInput(lease), workerCompletingPort())
      const passed = result.status === 'completed'
        && result.candidateRefs.length === 1
        && result.candidateReview === 'required'
        && result.canonicalPromotion === 'not-performed'
        && result.effectAuthority === 'none'
      return { passed, metrics: workerMetrics({ accepted: 1, queueDepth: 1 }) }
    }),
    asyncMetricCase('worker-deterministic-retry', 'finite-retry', async () => {
      const { outbox, lease } = claimedOutbox()
      const port: MemoryConsolidationPort = {
        admit: async request => workerAdmissionResult(request),
        execute: async request => workerExecutionResult(request, 'retryable'),
        reconcile: async () => undefined,
      }
      const result = await outbox.runClaimed(workerRunInput(lease), port)
      const entry = outbox.inspect().entries[0]
      const passed = result.status === 'retry-scheduled'
        && entry?.state === 'pending'
        && entry.nextAvailableAt === '2026-08-11T12:00:04.000Z'
      return { passed, metrics: workerMetrics({ retries: 1, queueDepth: 1 }) }
    }),
    asyncCase('worker-timeout-is-ambiguous', 'ambiguous-delivery', async () => {
      const { outbox, envelope, lease } = claimedOutbox()
      const port: MemoryConsolidationPort = {
        admit: async request => workerAdmissionResult(request),
        execute: async () => await new Promise(() => undefined),
        reconcile: async () => undefined,
      }
      const result = await outbox.runClaimed({ ...workerRunInput(lease), deadlineMs: 1 }, port)
      const wasAmbiguous = result.status === 'ambiguous'
        && result.providerCostState === 'unknown'
        && outbox.inspect().counts.pending === 0
      const reconcilePort: MemoryConsolidationPort = {
        admit: async request => workerAdmissionResult(request),
        execute: async () => undefined,
        reconcile: async request => workerReconciliationResult(request, 'proven-complete'),
      }
      const reconciled = await outbox.reconcile(
        workerReconcileInput(envelope, result.generation),
        reconcilePort,
      )
      return wasAmbiguous
        && reconciled.status === 'reconciled'
        && reconciled.providerCostState === 'known'
    }),
    asyncMetricCase('worker-reconcile-before-retry', 'reconciliation-gate', async () => {
      const { outbox, envelope, lease } = claimedOutbox()
      const ambiguousPort: MemoryConsolidationPort = {
        admit: async request => workerAdmissionResult(request),
        execute: async request => workerExecutionResult(request, 'ambiguous'),
        reconcile: async () => undefined,
      }
      const ambiguous = await outbox.runClaimed(workerRunInput(lease), ambiguousPort)
      const port: MemoryConsolidationPort = {
        admit: async request => workerAdmissionResult(request),
        execute: async () => undefined,
        reconcile: async request => workerReconciliationResult(request, 'proven-not-applied'),
      }
      const result = await outbox.reconcile(
        workerReconcileInput(envelope, ambiguous.generation),
        port,
      )
      const passed = result.status === 'retry-scheduled'
        && outbox.inspect().entries[0]?.nextAvailableAt === WORKER_TIMES.retryDue
      return { passed, metrics: workerMetrics({ reconciled: 1, retries: 1 }) }
    }),
    asyncCase('worker-unknown-cost-survives-dead-letter', 'cost-truthfulness', async () => {
      const { outbox, envelope, lease } = claimedOutbox()
      const unknownPort: MemoryConsolidationPort = {
        admit: async request => workerAdmissionResult(request),
        execute: async () => await new Promise(() => undefined),
        reconcile: async () => undefined,
      }
      const ambiguous = await outbox.runClaimed(
        { ...workerRunInput(lease), deadlineMs: 1 },
        unknownPort,
      )
      const deniedPort: MemoryConsolidationPort = {
        admit: async request => workerAdmissionResult(request, 'denied'),
        execute: async () => undefined,
        reconcile: async () => undefined,
      }
      const result = await outbox.reconcile(
        workerReconcileInput(envelope, ambiguous.generation),
        deniedPort,
      )
      return result.status === 'dead-lettered'
        && result.providerCostState === 'unknown'
        && result.providerCostMicrousd === 0
    }),
    asyncMetricCase('worker-reconciliation-generation-fence', 'lease-fencing', async () => {
      const { outbox, envelope, lease } = claimedOutbox()
      const port: MemoryConsolidationPort = {
        admit: async request => workerAdmissionResult(request),
        execute: async request => workerExecutionResult(request, 'ambiguous'),
        reconcile: async () => undefined,
      }
      const ambiguous = await outbox.runClaimed(workerRunInput(lease), port)
      let calls = 0
      const stalePort: MemoryConsolidationPort = {
        admit: async () => { calls += 1 },
        execute: async () => undefined,
        reconcile: async () => undefined,
      }
      const result = await outbox.reconcile(
        workerReconcileInput(envelope, ambiguous.generation + 1),
        stalePort,
      )
      return {
        passed: result.status === 'rejected' && calls === 0,
        metrics: workerMetrics({ rejected: 1, staleWriterRejections: 1 }),
      }
    }),
    asyncMetricCase('worker-terminal-dead-letter', 'dead-letter-retention', async () => {
      const { outbox, lease } = claimedOutbox()
      const port: MemoryConsolidationPort = {
        admit: async request => workerAdmissionResult(request, 'denied'),
        execute: async () => undefined,
        reconcile: async () => undefined,
      }
      const result = await outbox.runClaimed(workerRunInput(lease), port)
      const inspection = outbox.inspect()
      return {
        passed: result.status === 'dead-lettered'
          && inspection.deadLetters.length === 1
          && !JSON.stringify(inspection).includes('invented-memory-text'),
        metrics: workerMetrics({ rejected: 1, deadLetters: 1, queueDepth: 1 }),
      }
    }),
    passCase('worker-state-roundtrip', 'durable-state-contract', () => {
      const outbox = createInMemoryMemoryOutbox()
      outbox.enqueue(outbox.prepare(workerPrepareInput()))
      const state = outbox.exportState()
      const restored = createInMemoryMemoryOutbox({ seed: state })
      return restored.exportState().stateDigest === state.stateDigest
        && restored.inspect().entries.length === 1
    }),
    passCase('worker-state-tamper-rejected', 'state-integrity', () => {
      const outbox = createInMemoryMemoryOutbox()
      outbox.enqueue(outbox.prepare(workerPrepareInput()))
      const state = JSON.parse(JSON.stringify(outbox.exportState())) as {
        entries: { generation: number }[]
      }
      state.entries[0]!.generation = 99
      try {
        createInMemoryMemoryOutbox({ seed: state })
        return false
      } catch {
        return true
      }
    }),
    passCase('worker-checkpoint-precondition', 'checkpoint-integrity', () => {
      const outbox = createInMemoryMemoryOutbox()
      outbox.enqueue(outbox.prepare(workerPrepareInput()))
      const state = outbox.exportState()
      const result = outbox.checkpoint({
        schema: 'datazup.memory.outbox-checkpoint-request/v1',
        checkpointId: 'checkpoint-001',
        checkpointedAt: WORKER_TIMES.started,
        expectedRevision: state.revision,
        expectedStateDigest: state.stateDigest,
      })
      return result.status === 'checkpointed'
        && outbox.exportState().checkpoints.length === 1
    }),
    metricCase('worker-bounded-capacity', 'bounded-retention', () => {
      const outbox = createInMemoryMemoryOutbox({
        limits: { entries: 1, deadLetters: 1, checkpoints: 0 },
      })
      outbox.enqueue(outbox.prepare(workerPrepareInput()))
      const second = outbox.prepare(workerPrepareInput({
        envelopeId: 'envelope-002',
        idempotencyKey: 'idempotency-002',
        job: { ...workerPrepareInput().job as object, jobId: 'job-002' },
      }))
      const passed = outbox.enqueue(second).reasonCode === 'outbox-capacity-exhausted'
        && outbox.inspect().entries.length === 1
      return { passed, metrics: workerMetrics({ rejected: 1, queueDepth: 1 }) }
    }),
  ]
}

function claimedOutbox() {
  const outbox = createInMemoryMemoryOutbox()
  const envelope = outbox.prepare(workerPrepareInput())
  outbox.enqueue(envelope)
  const lease = outbox.claim(workerClaimInput()).lease!
  return { outbox, envelope, lease }
}

function passCase(
  id: string,
  capability: string,
  evaluate: () => boolean,
): InternalMemoryConformanceCaseV1 {
  return {
    id,
    capability,
    expected: 'pass',
    run: async () => outcome(evaluate()),
  }
}

function asyncCase(
  id: string,
  capability: string,
  evaluate: () => Promise<boolean>,
): InternalMemoryConformanceCaseV1 {
  return {
    id,
    capability,
    expected: 'pass',
    run: async () => outcome(await evaluate()),
  }
}

function metricCase(
  id: string,
  capability: string,
  evaluate: () => { readonly passed: boolean; readonly metrics: ReturnType<typeof workerMetrics> },
): InternalMemoryConformanceCaseV1 {
  return {
    id,
    capability,
    expected: 'pass',
    run: async () => metricOutcome(evaluate()),
  }
}

function asyncMetricCase(
  id: string,
  capability: string,
  evaluate: () => Promise<{
    readonly passed: boolean
    readonly metrics: ReturnType<typeof workerMetrics>
  }>,
): InternalMemoryConformanceCaseV1 {
  return {
    id,
    capability,
    expected: 'pass',
    run: async () => metricOutcome(await evaluate()),
  }
}

function outcome(passed: boolean) {
  return {
    passed,
    reasonCode: passed ? 'worker-contract-satisfied' : 'worker-contract-violated',
    evidenceDigests: [digestWorkerValue({ passed })],
  }
}

function metricOutcome(input: {
  readonly passed: boolean
  readonly metrics: ReturnType<typeof workerMetrics>
}) {
  return { ...outcome(input.passed), metrics: input.metrics }
}

function workerMetrics(values: {
  readonly accepted?: number
  readonly rejected?: number
  readonly retries?: number
  readonly reconciled?: number
  readonly deadLetters?: number
  readonly staleWriterRejections?: number
  readonly queueDepth?: number
}) {
  const metrics = [
    ['worker-accepted-count', values.accepted ?? 0],
    ['worker-rejected-count', values.rejected ?? 0],
    ['worker-retry-count', values.retries ?? 0],
    ['worker-reconciliation-count', values.reconciled ?? 0],
    ['worker-dead-letter-count', values.deadLetters ?? 0],
    ['worker-stale-writer-rejection-count', values.staleWriterRejections ?? 0],
    ['worker-maximum-queue-depth', values.queueDepth ?? 0],
    ['worker-provider-cost', 0],
  ] as const
  return metrics.map(([name, value]) => ({
    name,
    value,
    unit: name === 'worker-provider-cost' ? 'microusd' as const : 'count' as const,
    threshold: name === 'worker-provider-cost' ? 0 : value,
    comparison: 'exact' as const,
  }))
}
