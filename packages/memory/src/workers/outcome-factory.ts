import {
  derivedIdentifier,
  digestWorkerValue,
  memoryWorkerScopeDigest,
} from './snapshot.js'
import type {
  InternalMemoryOutboxEntryV1,
  InternalMemoryWorkerOutcomeStatusV1,
  InternalMemoryWorkerRefV1,
  MemoryDeadLetterV1,
  MemoryWorkerCheckpointV1,
  MemoryWorkerLeaseV1,
  MemoryWorkerOutcomeV1,
} from './types.js'
import {
  sealMemoryDeadLetterV1,
  sealMemoryWorkerOutcomeV1,
} from './validation-results.js'

interface EntryOutcomeFields {
  readonly lease?: MemoryWorkerLeaseV1
  readonly candidateRefs?: readonly InternalMemoryWorkerRefV1[]
  readonly deadLetter?: MemoryDeadLetterV1
  readonly providerCostMicrousd?: number | undefined
  readonly providerCostState?: 'known' | 'unknown' | undefined
}

export function createEntryOutcome(
  status: InternalMemoryWorkerOutcomeStatusV1,
  reasonCode: string,
  occurredAt: string,
  revision: number,
  entry: InternalMemoryOutboxEntryV1,
  fields: EntryOutcomeFields = {},
): MemoryWorkerOutcomeV1 {
  const identity = digestWorkerValue({
    schema: 'datazup.memory.worker-outcome-identity/v1',
    status,
    reasonCode,
    occurredAt,
    revision,
    envelopeDigest: entry.envelope.envelopeDigest,
    attempt: entry.attempt,
    generation: entry.generation,
  })
  return sealMemoryWorkerOutcomeV1({
    schema: 'datazup.memory.worker-outcome/v1',
    outcomeId: derivedIdentifier('worker-outcome', identity),
    status,
    reasonCode,
    occurredAt,
    revision,
    attempt: entry.attempt,
    generation: entry.generation,
    envelopeId: entry.envelope.envelopeId,
    envelopeDigest: entry.envelope.envelopeDigest,
    jobId: entry.envelope.job.jobId,
    jobDigest: entry.envelope.jobDigest,
    ...(fields.lease === undefined ? {} : { lease: fields.lease }),
    candidateRefs: fields.candidateRefs ?? [],
    ...(fields.deadLetter === undefined ? {} : {
      deadLetterRef: {
        owner: 'memory-outbox',
        id: fields.deadLetter.deadLetterId,
        digest: fields.deadLetter.deadLetterDigest,
      },
    }),
    providerCostMicrousd: fields.providerCostMicrousd ?? 0,
    providerCostState: fields.providerCostState ?? 'known',
    candidateReview: 'required',
    canonicalPromotion: 'not-performed',
    effectAuthority: 'none',
  })
}

export function createIdleOutcome(
  reasonCode: string,
  occurredAt: string,
  revision: number,
  scopeDigest: `sha256:${string}`,
): MemoryWorkerOutcomeV1 {
  const identity = digestWorkerValue({
    schema: 'datazup.memory.worker-idle-identity/v1',
    reasonCode,
    occurredAt,
    revision,
    scopeDigest,
  })
  return sealMemoryWorkerOutcomeV1({
    schema: 'datazup.memory.worker-outcome/v1',
    outcomeId: derivedIdentifier('worker-outcome', identity),
    status: 'idle',
    reasonCode,
    occurredAt,
    revision,
    attempt: 0,
    generation: 0,
    candidateRefs: [],
    providerCostMicrousd: 0,
    providerCostState: 'known',
    candidateReview: 'required',
    canonicalPromotion: 'not-performed',
    effectAuthority: 'none',
  })
}

export function createCheckpointOutcome(
  checkpoint: MemoryWorkerCheckpointV1,
  revision: number,
): MemoryWorkerOutcomeV1 {
  const identity = digestWorkerValue({
    schema: 'datazup.memory.worker-checkpoint-outcome-identity/v1',
    checkpointDigest: checkpoint.checkpointDigest,
    revision,
  })
  return sealMemoryWorkerOutcomeV1({
    schema: 'datazup.memory.worker-outcome/v1',
    outcomeId: derivedIdentifier('worker-outcome', identity),
    status: 'checkpointed',
    reasonCode: 'checkpoint-retained',
    occurredAt: checkpoint.checkpointedAt,
    revision,
    attempt: 0,
    generation: 0,
    candidateRefs: [],
    checkpointRef: {
      owner: 'memory-outbox',
      id: checkpoint.checkpointId,
      digest: checkpoint.checkpointDigest,
    },
    providerCostMicrousd: 0,
    providerCostState: 'known',
    candidateReview: 'required',
    canonicalPromotion: 'not-performed',
    effectAuthority: 'none',
  })
}

export function createDeadLetter(
  entry: InternalMemoryOutboxEntryV1,
  reasonCode: string,
  occurredAt: string,
  priorOutcomeDigest?: `sha256:${string}`,
): MemoryDeadLetterV1 {
  const identity = digestWorkerValue({
    schema: 'datazup.memory.dead-letter-identity/v1',
    envelopeDigest: entry.envelope.envelopeDigest,
    attempt: entry.attempt,
    generation: entry.generation,
    reasonCode,
    occurredAt,
  })
  return sealMemoryDeadLetterV1({
    schema: 'datazup.memory.dead-letter/v1',
    deadLetterId: derivedIdentifier('dead-letter', identity),
    envelopeId: entry.envelope.envelopeId,
    envelopeDigest: entry.envelope.envelopeDigest,
    jobId: entry.envelope.job.jobId,
    jobDigest: entry.envelope.jobDigest,
    scopeDigest: memoryWorkerScopeDigest(entry.envelope.job.scope),
    attempt: entry.attempt,
    generation: entry.generation,
    reasonCode,
    deadLetteredAt: occurredAt,
    ...(priorOutcomeDigest === undefined ? {} : { priorOutcomeDigest }),
  })
}
