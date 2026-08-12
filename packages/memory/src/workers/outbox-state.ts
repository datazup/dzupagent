import {
  createCheckpointOutcome,
  createDeadLetter,
  createEntryOutcome,
  createIdleOutcome,
} from './outcome-factory.js'
import { assertMemoryOutboxCapacity } from './outbox-capacity.js'
import { commitMemoryOutboxState } from './outbox-commit.js'
import { resolveProviderCost } from './provider-cost.js'
import type {
  InternalCheckpointRequestV1,
  InternalClaimRequestV1,
  InternalFactoryOptionsV1,
  InternalReconcileRequestV1,
  InternalRenewRequestV1,
} from './requests.js'
import {
  digestWorkerValue,
  freezeWorkerValue,
  memoryWorkerScopeDigest,
  timestampMs,
} from './snapshot.js'
import { inspectMemoryOutboxState } from './outbox-observation.js'
import {
  decodeMemoryOutboxStateV1,
  emptyMemoryOutboxStateV1,
  entryStorageKey,
  idempotencyStorageKey,
  workerStateCounts,
} from './state-validation.js'
import type {
  InternalMemoryOutboxEntryV1,
  InternalMemoryOutboxInspectionV1,
  InternalMemoryOutboxStateV1,
  InternalMemoryWorkerOutcomeStatusV1,
  InternalMemoryWorkerRefV1,
  MemoryWorkerLeaseV1,
  MemoryWorkerOutcomeV1,
} from './types.js'
import {
  memoryReconciliationRef,
  workerAdmissionRefsMatch,
} from './worker-identity.js'
import { decodeMemoryOutboxEnvelopeV1, sealMemoryWorkerLeaseV1 } from './validation-contracts.js'
import { sealMemoryWorkerCheckpointV1 } from './validation-results.js'

interface CompletionFields {
  readonly status: Extract<InternalMemoryWorkerOutcomeStatusV1, 'completed' | 'partial' | 'reconciled'>
  readonly reasonCode: string
  readonly occurredAt: string
  readonly candidateRefs: readonly InternalMemoryWorkerRefV1[]
  readonly providerCostMicrousd: number
}
export class InternalInMemoryOutboxState {
  private state: InternalMemoryOutboxStateV1
  constructor(private readonly options: InternalFactoryOptionsV1) {
    this.state = options.seed === undefined
      ? emptyMemoryOutboxStateV1()
      : decodeMemoryOutboxStateV1(options.seed)
    assertMemoryOutboxCapacity(this.state, options)
  }
  enqueue(input: unknown): MemoryWorkerOutcomeV1 {
    const envelope = decodeMemoryOutboxEnvelopeV1(input)
    const probe: InternalMemoryOutboxEntryV1 = {
      envelope,
      state: 'pending',
      attempt: 0,
      generation: 0,
      nextAvailableAt: envelope.notBefore,
    }
    const entryKey = entryStorageKey(probe)
    const idempotencyKey = idempotencyStorageKey(probe)
    const existingById = this.state.entries.find(entry => entryStorageKey(entry) === entryKey)
    const existingByIdempotency = this.state.entries.find(entry =>
      idempotencyStorageKey(entry) === idempotencyKey)
    const existing = existingById ?? existingByIdempotency
    if (existing) {
      const exactReplay = existing.envelope.envelopeDigest === envelope.envelopeDigest
      return createEntryOutcome(
        exactReplay ? 'replayed' : 'rejected',
        exactReplay
          ? 'idempotent-replay'
          : existingById === undefined
            ? 'idempotency-conflict'
            : 'envelope-identity-conflict',
        envelope.createdAt,
        this.state.revision,
        existing,
      )
    }
    if (this.state.entries.length >= this.options.limits.entries) {
      return createIdleOutcome(
        'outbox-capacity-exhausted',
        envelope.createdAt,
        this.state.revision,
        memoryWorkerScopeDigest(envelope.job.scope),
      )
    }
    const revision = this.state.revision + 1
    this.commit([...this.state.entries, freezeWorkerValue(probe)])
    return createEntryOutcome('enqueued', 'envelope-retained', envelope.createdAt, revision, probe)
  }
  claim(request: InternalClaimRequestV1): MemoryWorkerOutcomeV1 {
    const scopeDigest = memoryWorkerScopeDigest(request.scope)
    const scoped = this.state.entries
      .filter(entry => memoryWorkerScopeDigest(entry.envelope.job.scope) === scopeDigest)
      .sort((left, right) => entryStorageKey(left).localeCompare(entryStorageKey(right)))
    const expiredLease = scoped.find(entry =>
      (entry.state === 'leased' || entry.state === 'executing' || entry.state === 'reconciling')
      && timestampMs(entry.lease!.expiresAt) <= timestampMs(request.claimedAt))
    if (expiredLease) {
      return this.ambiguous(
        expiredLease.lease!,
        expiredLease.state === 'reconciling'
          ? 'reconciliation-lease-expired'
          : 'execution-lease-expired',
        request.claimedAt,
        expiredLease.reconciliationRef ?? memoryReconciliationRef(expiredLease, 'lease-expired'),
      )
    }
    const due = scoped.find(entry => entry.state === 'pending'
      && timestampMs(entry.nextAvailableAt) <= timestampMs(request.claimedAt))
    if (!due) return createIdleOutcome('no-eligible-envelope', request.claimedAt, this.state.revision, scopeDigest)
    if (timestampMs(due.envelope.deadlineAt) <= timestampMs(request.claimedAt)) {
      return this.deadLetter(due, 'envelope-deadline-exceeded', request.claimedAt)
    }
    const attempt = due.attempt + 1
    const generation = due.generation + 1
    const expiresAt = new Date(Math.min(
      timestampMs(request.claimedAt) + request.leaseDurationMs,
      timestampMs(due.envelope.deadlineAt),
    )).toISOString()
    const lease = sealMemoryWorkerLeaseV1({
      schema: 'datazup.memory.worker-lease/v1',
      envelopeId: due.envelope.envelopeId,
      envelopeDigest: due.envelope.envelopeDigest,
      workerId: request.workerId,
      generation,
      attempt,
      acquiredAt: request.claimedAt,
      expiresAt,
    })
    const next = freezeWorkerValue({
      envelope: due.envelope,
      state: 'leased' as const,
      attempt,
      generation,
      nextAvailableAt: due.nextAvailableAt,
      lease,
    })
    const revision = this.state.revision + 1
    this.replace(due, next)
    return createEntryOutcome('claimed', 'lease-acquired', request.claimedAt, revision, next, { lease })
  }
  renew(request: InternalRenewRequestV1): MemoryWorkerOutcomeV1 {
    const entry = this.entryForLease(request.lease)
    if (!entry) return this.staleLeaseOutcome(request.lease, request.renewedAt)
    if (entry.state === 'executing') {
      return createEntryOutcome('rejected', 'execution-in-progress', request.renewedAt, this.state.revision, entry)
    }
    if (timestampMs(request.renewedAt) < timestampMs(request.lease.acquiredAt)) {
      return createEntryOutcome('rejected', 'renewal-precedes-lease', request.renewedAt, this.state.revision, entry)
    }
    if (timestampMs(request.renewedAt) >= timestampMs(request.lease.expiresAt)) {
      return this.ambiguous(
        request.lease,
        'lease-expired-before-renewal',
        request.renewedAt,
        entry.reconciliationRef ?? memoryReconciliationRef(entry, 'renewal-expired'),
      )
    }
    const expiresAt = new Date(Math.min(
      timestampMs(request.renewedAt) + request.extendByMs,
      timestampMs(entry.envelope.deadlineAt),
    )).toISOString()
    if (timestampMs(expiresAt) <= timestampMs(request.renewedAt)) {
      return this.ambiguous(
        request.lease,
        'envelope-deadline-exceeded',
        request.renewedAt,
        entry.reconciliationRef ?? memoryReconciliationRef(entry, 'deadline-exceeded'),
      )
    }
    const lease = sealMemoryWorkerLeaseV1({
      schema: 'datazup.memory.worker-lease/v1',
      envelopeId: request.lease.envelopeId,
      envelopeDigest: request.lease.envelopeDigest,
      workerId: request.lease.workerId,
      generation: request.lease.generation + 1,
      attempt: request.lease.attempt,
      acquiredAt: request.renewedAt,
      expiresAt,
    })
    const revision = this.state.revision + 1
    const nextBase = {
      envelope: entry.envelope,
      state: entry.state,
      attempt: entry.attempt,
      generation: lease.generation,
      nextAvailableAt: entry.nextAvailableAt,
      lease,
      ...(entry.reconciliationRef === undefined ? {} : {
        reconciliationRef: entry.reconciliationRef,
      }),
    }
    const next = entry.state === 'reconciling'
      ? freezeWorkerValue({
        ...nextBase,
        outcome: createEntryOutcome(
          'ambiguous',
          'reconciliation-required',
          request.renewedAt,
          revision,
          nextBase,
          {
            providerCostMicrousd: entry.outcome?.providerCostMicrousd,
            providerCostState: entry.outcome?.providerCostState,
          },
        ),
      })
      : freezeWorkerValue(nextBase)
    this.replace(entry, next)
    return createEntryOutcome('renewed', 'lease-renewed', request.renewedAt, revision, next, { lease })
  }
  beginReconciliation(request: InternalReconcileRequestV1): MemoryWorkerOutcomeV1 {
    const scopeDigest = memoryWorkerScopeDigest(request.scope)
    const entry = this.state.entries.find(candidate =>
      memoryWorkerScopeDigest(candidate.envelope.job.scope) === scopeDigest
      && candidate.envelope.envelopeId === request.envelopeId)
    if (!entry || entry.state !== 'ambiguous') {
      return createIdleOutcome('ambiguous-envelope-not-found', request.startedAt, this.state.revision, scopeDigest)
    }
    if (entry.generation !== request.expectedGeneration) {
      return createEntryOutcome('rejected', 'stale-generation', request.startedAt, this.state.revision, entry)
    }
    if (!workerAdmissionRefsMatch(entry.envelope, request)) {
      return createEntryOutcome('rejected', 'admission-reference-mismatch', request.startedAt, this.state.revision, entry)
    }
    if (timestampMs(request.startedAt) >= timestampMs(entry.envelope.deadlineAt)) {
      return this.deadLetter(entry, 'reconciliation-deadline-exceeded', request.startedAt)
    }
    const generation = entry.generation + 1
    const expiresAt = new Date(Math.min(
      timestampMs(request.startedAt) + request.leaseDurationMs,
      timestampMs(entry.envelope.deadlineAt),
    )).toISOString()
    const lease = sealMemoryWorkerLeaseV1({
      schema: 'datazup.memory.worker-lease/v1',
      envelopeId: entry.envelope.envelopeId,
      envelopeDigest: entry.envelope.envelopeDigest,
      workerId: request.workerId,
      generation,
      attempt: entry.attempt,
      acquiredAt: request.startedAt,
      expiresAt,
    })
    const revision = this.state.revision + 1
    const nextBase: InternalMemoryOutboxEntryV1 = {
      ...entry,
      state: 'reconciling',
      generation,
      lease,
    }
    const next = freezeWorkerValue({
      ...nextBase,
      outcome: createEntryOutcome(
        'ambiguous',
        'reconciliation-required',
        request.startedAt,
        revision,
        nextBase,
        {
          providerCostMicrousd: entry.outcome?.providerCostMicrousd,
          providerCostState: entry.outcome?.providerCostState,
        },
      ),
    })
    this.replace(entry, next)
    return createEntryOutcome('claimed', 'reconciliation-lease-acquired', request.startedAt, revision, next, { lease })
  }
  entryForLease(lease: MemoryWorkerLeaseV1): InternalMemoryOutboxEntryV1 | undefined {
    return this.state.entries.find(entry =>
      (entry.state === 'leased' || entry.state === 'executing' || entry.state === 'reconciling')
      && entry.envelope.envelopeId === lease.envelopeId
      && entry.envelope.envelopeDigest === lease.envelopeDigest
      && entry.lease?.leaseDigest === lease.leaseDigest)
  }
  beginExecution(lease: MemoryWorkerLeaseV1): InternalMemoryOutboxEntryV1 | undefined {
    const entry = this.entryForLease(lease)
    if (!entry || entry.state !== 'leased') return undefined
    const next = freezeWorkerValue({ ...entry, state: 'executing' as const })
    this.replace(entry, next)
    return next
  }
  rejectLease(
    lease: MemoryWorkerLeaseV1,
    reasonCode: string,
    occurredAt: string,
  ): MemoryWorkerOutcomeV1 {
    const entry = this.entryForLease(lease)
    return entry === undefined
      ? this.staleLeaseOutcome(lease, occurredAt)
      : createEntryOutcome('rejected', reasonCode, occurredAt, this.state.revision, entry)
  }
  complete(lease: MemoryWorkerLeaseV1, fields: CompletionFields): MemoryWorkerOutcomeV1 {
    const entry = this.entryForLease(lease)
    if (!entry) return this.staleLeaseOutcome(lease, fields.occurredAt)
    const revision = this.state.revision + 1
    const outcome = createEntryOutcome(
      fields.status,
      fields.reasonCode,
      fields.occurredAt,
      revision,
      entry,
      { candidateRefs: fields.candidateRefs, providerCostMicrousd: fields.providerCostMicrousd },
    )
    this.replace(entry, freezeWorkerValue({
      envelope: entry.envelope,
      state: 'completed' as const,
      attempt: entry.attempt,
      generation: entry.generation,
      nextAvailableAt: entry.nextAvailableAt,
      outcome,
    }))
    return outcome
  }
  retryOrDeadLetter(
    lease: MemoryWorkerLeaseV1,
    reasonCode: string,
    occurredAt: string,
    providerCostMicrousd?: number,
    providerCostState?: 'known' | 'unknown',
  ): MemoryWorkerOutcomeV1 {
    const entry = this.entryForLease(lease)
    if (!entry) return this.staleLeaseOutcome(lease, occurredAt)
    const costFields = resolveProviderCost(entry, providerCostMicrousd, providerCostState)
    const retryable = entry.envelope.retryPolicy.retryableReasonCodes.includes(reasonCode)
      && entry.attempt < entry.envelope.retryPolicy.maxAttempts
      && timestampMs(occurredAt) < timestampMs(entry.envelope.deadlineAt)
    if (!retryable) return this.deadLetter(entry, reasonCode, occurredAt, costFields)
    const backoffMs = entry.envelope.retryPolicy.backoffMs[entry.attempt - 1] ?? 0
    const nextAvailableMs = timestampMs(occurredAt) + backoffMs
    if (nextAvailableMs >= timestampMs(entry.envelope.deadlineAt)) {
      return this.deadLetter(entry, 'retry-exceeds-envelope-deadline', occurredAt, costFields)
    }
    const revision = this.state.revision + 1
    const outcome = createEntryOutcome(
      'retry-scheduled', reasonCode, occurredAt, revision, entry, costFields,
    )
    this.replace(entry, freezeWorkerValue({
      envelope: entry.envelope,
      state: 'pending' as const,
      attempt: entry.attempt,
      generation: entry.generation,
      nextAvailableAt: new Date(nextAvailableMs).toISOString(),
      outcome,
    }))
    return outcome
  }

  deadLetterLease(
    lease: MemoryWorkerLeaseV1,
    reasonCode: string,
    occurredAt: string,
    providerCostMicrousd?: number,
    providerCostState?: 'known' | 'unknown',
  ): MemoryWorkerOutcomeV1 {
    const entry = this.entryForLease(lease)
    return entry === undefined
      ? this.staleLeaseOutcome(lease, occurredAt)
      : this.deadLetter(
        entry,
        reasonCode,
        occurredAt,
        resolveProviderCost(entry, providerCostMicrousd, providerCostState),
      )
  }

  ambiguous(
    lease: MemoryWorkerLeaseV1,
    reasonCode: string,
    occurredAt: string,
    reconciliationRef: InternalMemoryWorkerRefV1,
    providerCostMicrousd?: number,
    providerCostState?: 'known' | 'unknown',
  ): MemoryWorkerOutcomeV1 {
    const entry = this.entryForLease(lease)
    if (!entry) return this.staleLeaseOutcome(lease, occurredAt)
    const revision = this.state.revision + 1
    const costFields = resolveProviderCost(entry, providerCostMicrousd, providerCostState, 'unknown')
    const outcome = createEntryOutcome('ambiguous', reasonCode, occurredAt, revision, entry, {
      ...costFields,
    })
    this.replace(entry, freezeWorkerValue({
      envelope: entry.envelope,
      state: 'ambiguous' as const,
      attempt: entry.attempt,
      generation: entry.generation,
      nextAvailableAt: entry.nextAvailableAt,
      outcome,
      reconciliationRef,
    }))
    return outcome
  }

  checkpoint(request: InternalCheckpointRequestV1): MemoryWorkerOutcomeV1 {
    if (request.expectedRevision !== this.state.revision
      || request.expectedStateDigest !== this.state.stateDigest) {
      return createIdleOutcome(
        'stale-checkpoint-precondition',
        request.checkpointedAt,
        this.state.revision,
        digestWorkerValue({ schema: 'datazup.memory.all-scopes/v1' }),
      )
    }
    if (this.state.checkpoints.length >= this.options.limits.checkpoints) {
      return createIdleOutcome(
        'checkpoint-capacity-exhausted',
        request.checkpointedAt,
        this.state.revision,
        digestWorkerValue({ schema: 'datazup.memory.all-scopes/v1' }),
      )
    }
    const prior = this.state.checkpoints.at(-1)
    const checkpoint = sealMemoryWorkerCheckpointV1({
      schema: 'datazup.memory.worker-checkpoint/v1',
      checkpointId: request.checkpointId,
      checkpointedAt: request.checkpointedAt,
      revision: this.state.revision,
      sequence: this.state.sequence,
      priorStateDigest: this.state.stateDigest,
      ...(prior === undefined ? {} : { priorCheckpointDigest: prior.checkpointDigest }),
      counts: workerStateCounts(this.state.entries),
    })
    this.commit(this.state.entries, [...this.state.checkpoints, checkpoint])
    return createCheckpointOutcome(checkpoint, this.state.revision)
  }

  inspect(): InternalMemoryOutboxInspectionV1 {
    return inspectMemoryOutboxState(this.state)
  }

  exportState(): InternalMemoryOutboxStateV1 {
    return this.state
  }

  private deadLetter(
    entry: InternalMemoryOutboxEntryV1,
    reasonCode: string,
    occurredAt: string,
    costFields = resolveProviderCost(entry),
  ): MemoryWorkerOutcomeV1 {
    const revision = this.state.revision + 1
    const deadLetter = createDeadLetter(entry, reasonCode, occurredAt, entry.outcome?.outcomeDigest)
    const outcome = createEntryOutcome(
      'dead-lettered', reasonCode, occurredAt, revision, entry, { deadLetter, ...costFields },
    )
    this.replace(entry, freezeWorkerValue({
      envelope: entry.envelope,
      state: 'dead-lettered' as const,
      attempt: entry.attempt,
      generation: entry.generation,
      nextAvailableAt: entry.nextAvailableAt,
      outcome,
      deadLetter,
    }))
    return outcome
  }

  private staleLeaseOutcome(lease: MemoryWorkerLeaseV1, occurredAt: string): MemoryWorkerOutcomeV1 {
    const entry = this.state.entries.find(candidate =>
      candidate.envelope.envelopeId === lease.envelopeId
      && candidate.envelope.envelopeDigest === lease.envelopeDigest)
    return entry === undefined
      ? createIdleOutcome(
        'lease-envelope-not-found',
        occurredAt,
        this.state.revision,
        digestWorkerValue({ schema: 'datazup.memory.unknown-scope/v1' }),
      )
      : createEntryOutcome('rejected', 'stale-lease', occurredAt, this.state.revision, entry)
  }

  private replace(
    current: InternalMemoryOutboxEntryV1,
    next: InternalMemoryOutboxEntryV1,
  ): void {
    const key = entryStorageKey(current)
    this.commit(this.state.entries.map(entry => entryStorageKey(entry) === key ? next : entry))
  }

  private commit(
    entries: readonly InternalMemoryOutboxEntryV1[],
    checkpoints = this.state.checkpoints,
  ): void {
    this.state = commitMemoryOutboxState(this.state, entries, this.options, checkpoints)
  }
}
