/**
 * Durable storage contract for model-written observation candidates.
 *
 * Candidate records intentionally live outside the confirmed observation
 * namespace. A receipt makes promotion idempotent across process restarts:
 * retrying a confirmation may overwrite the same durable memory key, but it
 * cannot create a second logical promotion.
 */

import { createHash } from 'node:crypto'
import type { MemoryService } from './memory-service.js'
import type { StagedRecord } from './staged-writer.js'

export const OBSERVATION_CANDIDATE_SCHEMA =
  'dzupagent/observation-candidate/v1' as const
export const OBSERVATION_CONFIRMATION_RECEIPT_SCHEMA =
  'dzupagent/observation-confirmation-receipt/v1' as const

export interface ObservationConfirmationReceipt {
  schema: typeof OBSERVATION_CONFIRMATION_RECEIPT_SCHEMA
  candidateKey: string
  targetNamespace: string
  scope: Record<string, string>
  memoryKey: string
  candidateCreatedAt: number
  valueDigest: string
  persistedAt: number
}

export interface ObservationCandidateRetention {
  /** Maximum retained candidate records per namespace and scope. Default: 100. */
  maxRecords?: number | undefined
  /** Maximum age for active/confirmed records. Default: 30 days. */
  maxAgeMs?: number | undefined
  /** Maximum age for rejected records. Default: 7 days. */
  rejectedMaxAgeMs?: number | undefined
  /** Injectable clock used by deterministic hosts and tests. */
  now?: (() => number) | undefined
}

export interface ObservationCandidateStore {
  load(
    targetNamespace: string,
    scope: Record<string, string>,
  ): Promise<StagedRecord[]>
  put(record: StagedRecord): Promise<boolean>
  remove(record: StagedRecord): Promise<boolean>
  getReceipt(
    targetNamespace: string,
    scope: Record<string, string>,
    candidateKey: string,
  ): Promise<ObservationConfirmationReceipt | null>
  putReceipt(receipt: ObservationConfirmationReceipt): Promise<boolean>
  prune(
    targetNamespace: string,
    scope: Record<string, string>,
    retention?: ObservationCandidateRetention,
  ): Promise<number>
}

interface CandidateEnvelope {
  schema: typeof OBSERVATION_CANDIDATE_SCHEMA
  kind: 'candidate'
  candidateKey: string
  targetNamespace: string
  record: StagedRecord
}

interface TombstoneEnvelope {
  schema: typeof OBSERVATION_CANDIDATE_SCHEMA
  kind: 'tombstone'
  candidateKey: string
  targetNamespace: string
  removedAt: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETENTION: {
  maxRecords: number
  maxAgeMs: number
  rejectedMaxAgeMs: number
} = {
  maxRecords: 100,
  maxAgeMs: 30 * DAY_MS,
  rejectedMaxAgeMs: 7 * DAY_MS,
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return value
}

export function observationCandidateValueDigest(record: StagedRecord): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({
      key: record.key,
      namespace: record.namespace,
      scope: record.scope,
      value: record.value,
      createdAt: record.createdAt,
    })))
    .digest('hex')
}

export function createObservationConfirmationReceipt(
  record: StagedRecord,
  persistedAt = Date.now(),
): ObservationConfirmationReceipt {
  return {
    schema: OBSERVATION_CONFIRMATION_RECEIPT_SCHEMA,
    candidateKey: record.key,
    targetNamespace: record.namespace,
    scope: { ...record.scope },
    memoryKey: record.key,
    candidateCreatedAt: record.createdAt,
    valueDigest: observationCandidateValueDigest(record),
    persistedAt,
  }
}

function candidateStorageKey(candidateKey: string): string {
  return `candidate:${encodeURIComponent(candidateKey)}`
}

function receiptStorageKey(candidateKey: string): string {
  return `receipt:${encodeURIComponent(candidateKey)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value)
    && Object.values(value).every(entry => typeof entry === 'string')
}

function parseStagedRecord(value: unknown): StagedRecord | null {
  if (!isRecord(value)) return null
  if (
    typeof value['key'] !== 'string'
    || typeof value['namespace'] !== 'string'
    || !isStringRecord(value['scope'])
    || !isRecord(value['value'])
    || !['captured', 'candidate', 'confirmed', 'rejected'].includes(
      String(value['stage']),
    )
    || typeof value['confidence'] !== 'number'
    || typeof value['createdAt'] !== 'number'
  ) {
    return null
  }
  return {
    key: value['key'],
    namespace: value['namespace'],
    scope: { ...value['scope'] },
    value: { ...value['value'] },
    stage: value['stage'] as StagedRecord['stage'],
    confidence: value['confidence'],
    createdAt: value['createdAt'],
    ...(typeof value['captureReason'] === 'string'
      ? { captureReason: value['captureReason'] }
      : {}),
    ...(typeof value['promotedAt'] === 'number'
      ? { promotedAt: value['promotedAt'] }
      : {}),
    ...(typeof value['confirmedAt'] === 'number'
      ? { confirmedAt: value['confirmedAt'] }
      : {}),
  }
}

function parseCandidateEnvelope(value: unknown): CandidateEnvelope | null {
  if (!isRecord(value)) return null
  if (
    value['schema'] !== OBSERVATION_CANDIDATE_SCHEMA
    || value['kind'] !== 'candidate'
    || typeof value['candidateKey'] !== 'string'
    || typeof value['targetNamespace'] !== 'string'
  ) {
    return null
  }
  const record = parseStagedRecord(value['record'])
  if (
    !record
    || record.key !== value['candidateKey']
    || record.namespace !== value['targetNamespace']
  ) {
    return null
  }
  return {
    schema: OBSERVATION_CANDIDATE_SCHEMA,
    kind: 'candidate',
    candidateKey: value['candidateKey'],
    targetNamespace: value['targetNamespace'],
    record,
  }
}

function parseReceipt(value: unknown): ObservationConfirmationReceipt | null {
  if (!isRecord(value)) return null
  if (
    value['schema'] !== OBSERVATION_CONFIRMATION_RECEIPT_SCHEMA
    || typeof value['candidateKey'] !== 'string'
    || typeof value['targetNamespace'] !== 'string'
    || !isStringRecord(value['scope'])
    || typeof value['memoryKey'] !== 'string'
    || typeof value['candidateCreatedAt'] !== 'number'
    || typeof value['valueDigest'] !== 'string'
    || !/^[a-f0-9]{64}$/.test(value['valueDigest'])
    || typeof value['persistedAt'] !== 'number'
  ) {
    return null
  }
  return {
    schema: OBSERVATION_CONFIRMATION_RECEIPT_SCHEMA,
    candidateKey: value['candidateKey'],
    targetNamespace: value['targetNamespace'],
    scope: { ...value['scope'] },
    memoryKey: value['memoryKey'],
    candidateCreatedAt: value['candidateCreatedAt'],
    valueDigest: value['valueDigest'],
    persistedAt: value['persistedAt'],
  }
}

/**
 * Observation candidate store backed by a separately configured
 * {@link MemoryService} namespace.
 *
 * The backing namespace must use the same scope keys as the target
 * observation namespace. It should be non-searchable.
 */
export class MemoryServiceObservationCandidateStore
implements ObservationCandidateStore {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly storeNamespace: string,
  ) {}

  async load(
    targetNamespace: string,
    scope: Record<string, string>,
  ): Promise<StagedRecord[]> {
    const values = await this.memoryService.get(this.storeNamespace, scope)
    return values
      .map(parseCandidateEnvelope)
      .filter((entry): entry is CandidateEnvelope => (
        entry !== null && entry.targetNamespace === targetNamespace
      ))
      .map(entry => entry.record)
  }

  async put(record: StagedRecord): Promise<boolean> {
    const key = candidateStorageKey(record.key)
    const envelope: CandidateEnvelope = {
      schema: OBSERVATION_CANDIDATE_SCHEMA,
      kind: 'candidate',
      candidateKey: record.key,
      targetNamespace: record.namespace,
      record: {
        ...record,
        scope: { ...record.scope },
        value: { ...record.value },
      },
    }
    await this.memoryService.put(
      this.storeNamespace,
      record.scope,
      key,
      envelope as unknown as Record<string, unknown>,
    )
    const stored = await this.memoryService.get(
      this.storeNamespace,
      record.scope,
      key,
    )
    const parsed = parseCandidateEnvelope(stored[0])
    return parsed?.candidateKey === record.key
      && parsed.targetNamespace === record.namespace
      && observationCandidateValueDigest(parsed.record)
        === observationCandidateValueDigest(record)
      && parsed.record.stage === record.stage
  }

  async remove(record: StagedRecord): Promise<boolean> {
    const key = candidateStorageKey(record.key)
    if (await this.memoryService.delete(this.storeNamespace, record.scope, key)) {
      return true
    }

    const tombstone: TombstoneEnvelope = {
      schema: OBSERVATION_CANDIDATE_SCHEMA,
      kind: 'tombstone',
      candidateKey: record.key,
      targetNamespace: record.namespace,
      removedAt: Date.now(),
    }
    await this.memoryService.put(
      this.storeNamespace,
      record.scope,
      key,
      tombstone as unknown as Record<string, unknown>,
    )
    const stored = await this.memoryService.get(
      this.storeNamespace,
      record.scope,
      key,
    )
    return stored[0]?.['kind'] === 'tombstone'
      && stored[0]?.['candidateKey'] === record.key
  }

  async getReceipt(
    targetNamespace: string,
    scope: Record<string, string>,
    candidateKey: string,
  ): Promise<ObservationConfirmationReceipt | null> {
    const stored = await this.memoryService.get(
      this.storeNamespace,
      scope,
      receiptStorageKey(candidateKey),
    )
    const receipt = parseReceipt(stored[0])
    return receipt?.targetNamespace === targetNamespace ? receipt : null
  }

  async putReceipt(receipt: ObservationConfirmationReceipt): Promise<boolean> {
    const key = receiptStorageKey(receipt.candidateKey)
    await this.memoryService.put(
      this.storeNamespace,
      receipt.scope,
      key,
      receipt as unknown as Record<string, unknown>,
    )
    const stored = await this.memoryService.get(
      this.storeNamespace,
      receipt.scope,
      key,
    )
    const verified = parseReceipt(stored[0])
    return verified?.candidateKey === receipt.candidateKey
      && verified.targetNamespace === receipt.targetNamespace
      && verified.valueDigest === receipt.valueDigest
  }

  async prune(
    targetNamespace: string,
    scope: Record<string, string>,
    retention: ObservationCandidateRetention = {},
  ): Promise<number> {
    const records = await this.load(targetNamespace, scope)
    const now = retention.now?.() ?? Date.now()
    const maxRecords = retention.maxRecords ?? DEFAULT_RETENTION.maxRecords
    const maxAgeMs = retention.maxAgeMs ?? DEFAULT_RETENTION.maxAgeMs
    const rejectedMaxAgeMs =
      retention.rejectedMaxAgeMs ?? DEFAULT_RETENTION.rejectedMaxAgeMs

    const expired = records.filter(record => {
      const limit = record.stage === 'rejected' ? rejectedMaxAgeMs : maxAgeMs
      return now - record.createdAt > limit
    })
    const expiredKeys = new Set(expired.map(record => record.key))
    const retained = records
      .filter(record => !expiredKeys.has(record.key))
      .sort((left, right) => right.createdAt - left.createdAt)
    const overflow = retained.slice(Math.max(0, maxRecords))
    const removals = [...expired, ...overflow]
    let removed = 0
    for (const record of removals) {
      if (await this.remove(record)) removed++
    }
    return removed
  }
}
