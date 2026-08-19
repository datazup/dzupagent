import { DURABLE_PENDING_CONTACTS_KEY } from '@dzupagent/agent/tools'
import type {
  AtomicRunStore,
  Run,
  RunStatus,
} from '@dzupagent/core/persistence'
import {
  PENDING_CONTACTS_KEY,
  RESOLVED_CONTACTS_KEY,
} from './pending-contacts.js'

const RESERVATION_KIND = 'durable-human-contact-reservation-v1'
const BINDING_KIND = 'human-contact-binding-v1'
const RECEIPT_KIND = 'human-contact-receipt-v1'
const MAX_OPERATION_RUNS = 1_000
const MAX_RECONCILE_ATTEMPTS = 8

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'completed',
  'halted',
  'failed',
  'rejected',
  'cancelled',
])

export type HumanContactOperationalClassification =
  | 'reclaimable'
  | 'expired'
  | 'terminal'
  | 'malformed'
  | 'retention_due'

export type HumanContactOperationalSubject =
  | 'pause'
  | 'publication'
  | 'contact'
  | 'reservation'
  | 'binding'
  | 'receipt'
  | 'response'

export type HumanContactOperationalAction =
  | 'none'
  | 'lease_released'
  | 'reported'
  | 'removed'
  | 'pruned'

export interface HumanContactOperationalObservation {
  runId: string
  tenantId: string
  runStatus: RunStatus
  contactId?: string
  classification: HumanContactOperationalClassification
  subject: HumanContactOperationalSubject
  action: HumanContactOperationalAction
}

export interface HumanContactOperationalMetric {
  name: 'human_contact_operational_observation'
  value: 1
  classification: HumanContactOperationalClassification
  subject: HumanContactOperationalSubject
  action: HumanContactOperationalAction
}

export interface HumanContactOperationalSink {
  /** Identity plus state only; never contact or response content. */
  onAlert?(observation: HumanContactOperationalObservation): void | Promise<void>
  /** Bounded labels only; deliberately excludes tenant/run/contact identity. */
  onMetric?(metric: HumanContactOperationalMetric): void | Promise<void>
}

export interface HumanContactOperationOptions {
  /** Required finite scan ceiling, between 1 and 1,000 inclusive. */
  limit: number
  offset?: number
  tenantId?: string
  /** Injectable clock for deterministic operation and tests. */
  now?: Date | string
  /** Optional explicit retention duration for receipts and accepted response. */
  retentionMs?: number
  sink?: HumanContactOperationalSink
}

export interface HumanContactOperationReport {
  scannedRuns: number
  changedRuns: number
  contentionRuns: number
  telemetryFailures: number
  observations: HumanContactOperationalObservation[]
}

interface DurableReservationRecord extends Record<string, unknown> {
  kind: typeof RESERVATION_KIND
  contactId: string
  lifecycleStatus: 'preparing' | 'paused' | 'failed'
  expiresAt?: string
  pauseLeaseId?: string
  pauseLeaseExpiresAt?: string
}

interface PendingBindingRecord extends Record<string, unknown> {
  kind: typeof BINDING_KIND
  contactId: string
}

interface ResolvedReceiptRecord extends Record<string, unknown> {
  kind: typeof RECEIPT_KIND
  contactId: string
  respondedAt: string
  publicationStatus?: 'pending' | 'published'
  publicationClaimId?: string
  publicationLeaseExpiresAt?: string
}

interface Analysis {
  metadata: Record<string, unknown>
  changed: boolean
  observations: HumanContactOperationalObservation[]
}

function metadataOf(run: Pick<Run, 'metadata'>): Record<string, unknown> {
  return run.metadata ?? {}
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function timestampOf(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isReservation(value: unknown): value is DurableReservationRecord {
  const entry = recordOf(value)
  if (!entry) return false
  return entry['kind'] === RESERVATION_KIND
    && typeof entry['contactId'] === 'string'
    && typeof entry['runId'] === 'string'
    && typeof entry['tenantId'] === 'string'
    && typeof entry['invocationId'] === 'string'
    && typeof entry['invocationDigest'] === 'string'
    && typeof entry['requestType'] === 'string'
    && typeof entry['resumeTokenHash'] === 'string'
    && typeof entry['resumeTokenCiphertext'] === 'string'
    && (entry['deliveryStatus'] === 'pending'
      || entry['deliveryStatus'] === 'delivered'
      || entry['deliveryStatus'] === 'failed')
    && (entry['lifecycleStatus'] === 'preparing'
      || entry['lifecycleStatus'] === 'paused'
      || entry['lifecycleStatus'] === 'failed')
}

function isBinding(value: unknown): value is PendingBindingRecord {
  const entry = recordOf(value)
  return entry !== null
    && entry['kind'] === BINDING_KIND
    && typeof entry['contactId'] === 'string'
    && typeof entry['runId'] === 'string'
    && typeof entry['tenantId'] === 'string'
    && typeof entry['resumeTokenHash'] === 'string'
}

function isReceipt(value: unknown): value is ResolvedReceiptRecord {
  const entry = recordOf(value)
  return entry !== null
    && entry['kind'] === RECEIPT_KIND
    && typeof entry['contactId'] === 'string'
    && typeof entry['runId'] === 'string'
    && typeof entry['tenantId'] === 'string'
    && typeof entry['resumeTokenHash'] === 'string'
    && typeof entry['respondedAt'] === 'string'
    && typeof entry['responseType'] === 'string'
}

function observation(
  run: Run,
  classification: HumanContactOperationalClassification,
  subject: HumanContactOperationalSubject,
  action: HumanContactOperationalAction,
  contactId?: string,
): HumanContactOperationalObservation {
  const base = {
    runId: run.id,
    tenantId: run.tenantId ?? 'default',
    runStatus: run.status,
    classification,
    subject,
    action,
  }
  return contactId === undefined ? base : { ...base, contactId }
}

function operationalAction(
  apply: boolean,
  action: Exclude<HumanContactOperationalAction, 'none'>,
): HumanContactOperationalAction {
  return apply ? action : 'none'
}

function analyzeRun(
  run: Run,
  nowMs: number,
  retentionMs: number | undefined,
  apply: boolean,
): Analysis {
  const metadata = metadataOf(run)
  const nextMetadata: Record<string, unknown> = { ...metadata }
  const observations: HumanContactOperationalObservation[] = []
  const terminal = TERMINAL_RUN_STATUSES.has(run.status)
  let changed = false

  const rawReservations = metadata[DURABLE_PENDING_CONTACTS_KEY]
  if (Array.isArray(rawReservations)) {
    const nextReservations: unknown[] = []
    for (const rawReservation of rawReservations) {
      if (!isReservation(rawReservation)) {
        observations.push(observation(
          run,
          'malformed',
          'reservation',
          operationalAction(apply, 'reported'),
        ))
        nextReservations.push(rawReservation)
        continue
      }
      if (terminal) {
        observations.push(observation(
          run,
          'terminal',
          'reservation',
          operationalAction(apply, 'removed'),
          rawReservation.contactId,
        ))
        if (apply) {
          changed = true
          continue
        }
      }

      let nextReservation: DurableReservationRecord = rawReservation
      if (rawReservation.expiresAt !== undefined) {
        const expiresAt = timestampOf(rawReservation.expiresAt)
        if (expiresAt === null) {
          observations.push(observation(
            run,
            'malformed',
            'contact',
            operationalAction(apply, 'reported'),
            rawReservation.contactId,
          ))
        } else if (expiresAt <= nowMs) {
          observations.push(observation(
            run,
            'expired',
            'contact',
            operationalAction(apply, 'reported'),
            rawReservation.contactId,
          ))
        }
      }

      if (
        rawReservation.lifecycleStatus === 'preparing'
        && (rawReservation.pauseLeaseId !== undefined
          || rawReservation.pauseLeaseExpiresAt !== undefined)
      ) {
        const leaseExpiresAt = timestampOf(rawReservation.pauseLeaseExpiresAt)
        if (
          rawReservation.pauseLeaseId === undefined
          || leaseExpiresAt === null
        ) {
          observations.push(observation(
            run,
            'malformed',
            'pause',
            operationalAction(apply, 'reported'),
            rawReservation.contactId,
          ))
        } else if (leaseExpiresAt <= nowMs) {
          observations.push(observation(
            run,
            'reclaimable',
            'pause',
            operationalAction(apply, 'lease_released'),
            rawReservation.contactId,
          ))
          if (apply) {
            nextReservation = { ...rawReservation }
            delete nextReservation.pauseLeaseId
            delete nextReservation.pauseLeaseExpiresAt
            changed = true
          }
        }
      }
      nextReservations.push(nextReservation)
    }
    if (apply && changed) nextMetadata[DURABLE_PENDING_CONTACTS_KEY] = nextReservations
  } else if (rawReservations !== undefined) {
    observations.push(observation(
      run,
      'malformed',
      'reservation',
      operationalAction(apply, 'reported'),
    ))
  }

  const rawPending = metadata[PENDING_CONTACTS_KEY]
  if (Array.isArray(rawPending)) {
    const nextPending: unknown[] = []
    for (const entry of rawPending) {
      const contactId = typeof entry === 'string'
        ? entry
        : isBinding(entry) ? entry.contactId : undefined
      if (contactId === undefined) {
        observations.push(observation(
          run,
          'malformed',
          'binding',
          operationalAction(apply, 'reported'),
        ))
        nextPending.push(entry)
        continue
      }
      if (terminal) {
        observations.push(observation(
          run,
          'terminal',
          'binding',
          operationalAction(apply, 'removed'),
          contactId,
        ))
        if (apply) {
          changed = true
          continue
        }
      }
      nextPending.push(entry)
    }
    if (apply && changed) nextMetadata[PENDING_CONTACTS_KEY] = nextPending
  } else if (rawPending !== undefined) {
    observations.push(observation(
      run,
      'malformed',
      'binding',
      operationalAction(apply, 'reported'),
    ))
  }

  const retentionCutoff = retentionMs === undefined ? undefined : nowMs - retentionMs
  const rawReceipts = metadata[RESOLVED_CONTACTS_KEY]
  if (Array.isArray(rawReceipts)) {
    const nextReceipts: unknown[] = []
    for (const rawReceipt of rawReceipts) {
      if (!isReceipt(rawReceipt)) {
        observations.push(observation(
          run,
          'malformed',
          'receipt',
          operationalAction(apply, 'reported'),
        ))
        nextReceipts.push(rawReceipt)
        continue
      }
      const respondedAt = timestampOf(rawReceipt.respondedAt)
      if (respondedAt === null) {
        observations.push(observation(
          run,
          'malformed',
          'receipt',
          operationalAction(apply, 'reported'),
          rawReceipt.contactId,
        ))
        nextReceipts.push(rawReceipt)
        continue
      }

      let nextReceipt: ResolvedReceiptRecord = rawReceipt
      if (rawReceipt.publicationStatus === 'pending') {
        const hasClaim = rawReceipt.publicationClaimId !== undefined
          || rawReceipt.publicationLeaseExpiresAt !== undefined
        if (hasClaim) {
          const leaseExpiresAt = timestampOf(rawReceipt.publicationLeaseExpiresAt)
          if (rawReceipt.publicationClaimId === undefined || leaseExpiresAt === null) {
            observations.push(observation(
              run,
              'malformed',
              'publication',
              operationalAction(apply, 'reported'),
              rawReceipt.contactId,
            ))
          } else if (leaseExpiresAt <= nowMs) {
            observations.push(observation(
              run,
              'reclaimable',
              'publication',
              operationalAction(apply, 'lease_released'),
              rawReceipt.contactId,
            ))
            if (apply) {
              nextReceipt = { ...rawReceipt }
              delete nextReceipt.publicationClaimId
              delete nextReceipt.publicationLeaseExpiresAt
              changed = true
            }
          }
        }
      }

      const retentionDue = retentionCutoff !== undefined
        && respondedAt <= retentionCutoff
        && rawReceipt.publicationStatus !== 'pending'
      if (retentionDue) {
        observations.push(observation(
          run,
          'retention_due',
          'receipt',
          operationalAction(apply, 'pruned'),
          rawReceipt.contactId,
        ))
        if (apply) {
          changed = true
          continue
        }
      }
      nextReceipts.push(nextReceipt)
    }
    if (apply && changed) nextMetadata[RESOLVED_CONTACTS_KEY] = nextReceipts
  } else if (rawReceipts !== undefined) {
    observations.push(observation(
      run,
      'malformed',
      'receipt',
      operationalAction(apply, 'reported'),
    ))
  }

  const rawResponse = metadata['humanContactResponse']
  if (rawResponse !== undefined) {
    const response = recordOf(rawResponse)
    const contactId = typeof response?.['contactId'] === 'string'
      ? response['contactId']
      : undefined
    const respondedAt = timestampOf(response?.['respondedAt'])
    const matchingReceipt = contactId === undefined || !Array.isArray(rawReceipts)
      ? undefined
      : rawReceipts.find((entry) => (
          isReceipt(entry) && entry.contactId === contactId
        ))
    const publicationSettled = matchingReceipt !== undefined
      && matchingReceipt.publicationStatus !== 'pending'
    if (!response || contactId === undefined || respondedAt === null) {
      observations.push(observation(
        run,
        'malformed',
        'response',
        operationalAction(apply, 'reported'),
        contactId,
      ))
    } else if (
      retentionCutoff !== undefined
      && respondedAt <= retentionCutoff
      && publicationSettled
    ) {
      observations.push(observation(
        run,
        'retention_due',
        'response',
        operationalAction(apply, 'pruned'),
        contactId,
      ))
      if (apply) {
        delete nextMetadata['humanContactResponse']
        changed = true
      }
    }
  }

  return { metadata: nextMetadata, changed, observations }
}

function operationClock(now: Date | string | undefined): number {
  const value = now === undefined
    ? Date.now()
    : now instanceof Date ? now.getTime() : Date.parse(now)
  if (!Number.isFinite(value)) throw new Error('HUMAN_CONTACT_OPERATION_CLOCK_INVALID')
  return value
}

function validateOptions(options: HumanContactOperationOptions): {
  nowMs: number
  retentionMs?: number
} {
  if (
    !Number.isInteger(options.limit)
    || options.limit < 1
    || options.limit > MAX_OPERATION_RUNS
  ) {
    throw new Error('HUMAN_CONTACT_OPERATION_LIMIT_INVALID')
  }
  if (
    options.offset !== undefined
    && (!Number.isInteger(options.offset) || options.offset < 0)
  ) {
    throw new Error('HUMAN_CONTACT_OPERATION_OFFSET_INVALID')
  }
  if (
    options.retentionMs !== undefined
    && (!Number.isFinite(options.retentionMs) || options.retentionMs < 0)
  ) {
    throw new Error('HUMAN_CONTACT_OPERATION_RETENTION_INVALID')
  }
  const result: { nowMs: number; retentionMs?: number } = {
    nowMs: operationClock(options.now),
  }
  if (options.retentionMs !== undefined) result.retentionMs = options.retentionMs
  return result
}

async function emitTelemetry(
  observations: readonly HumanContactOperationalObservation[],
  sink: HumanContactOperationalSink | undefined,
): Promise<number> {
  if (!sink) return 0
  let failures = 0
  for (const item of observations) {
    if (sink.onAlert) {
      try {
        await sink.onAlert(item)
      } catch {
        failures += 1
      }
    }
    if (sink.onMetric) {
      try {
        await sink.onMetric({
          name: 'human_contact_operational_observation',
          value: 1,
          classification: item.classification,
          subject: item.subject,
          action: item.action,
        })
      } catch {
        failures += 1
      }
    }
  }
  return failures
}

async function listRuns(
  runStore: AtomicRunStore,
  options: HumanContactOperationOptions,
): Promise<Run[]> {
  return runStore.list({
    limit: options.limit,
    offset: options.offset ?? 0,
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
  })
}

/** Read-only bounded operational classification. */
export async function inspectHumanContactOperations(
  runStore: AtomicRunStore,
  options: HumanContactOperationOptions,
): Promise<HumanContactOperationReport> {
  const { nowMs, retentionMs } = validateOptions(options)
  const runs = await listRuns(runStore, options)
  const observations = runs.flatMap(
    (run) => analyzeRun(run, nowMs, retentionMs, false).observations,
  )
  return {
    scannedRuns: runs.length,
    changedRuns: 0,
    contentionRuns: 0,
    telemetryFailures: await emitTelemetry(observations, options.sink),
    observations,
  }
}

/**
 * Bounded CAS reconciliation for mechanical custody state only.
 *
 * Expired contacts and malformed records are reported but retained because
 * choosing a fallback/failure policy or repairing unknown bytes belongs to the
 * host. Telemetry failures are counted and never roll back committed custody.
 */
export async function reconcileHumanContactOperations(
  runStore: AtomicRunStore,
  options: HumanContactOperationOptions,
): Promise<HumanContactOperationReport> {
  const { nowMs, retentionMs } = validateOptions(options)
  const listedRuns = await listRuns(runStore, options)
  const observations: HumanContactOperationalObservation[] = []
  let changedRuns = 0
  let contentionRuns = 0

  for (const listedRun of listedRuns) {
    let settled = false
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
      const run = await runStore.get(listedRun.id)
      if (!run) {
        settled = true
        break
      }
      const analysis = analyzeRun(run, nowMs, retentionMs, true)
      if (!analysis.changed) {
        observations.push(...analysis.observations)
        settled = true
        break
      }
      const metadata = metadataOf(run)
      const committed = await runStore.compareAndSet(
        run.id,
        { status: run.status, metadata },
        { metadata: analysis.metadata },
      )
      if (committed) {
        changedRuns += 1
        observations.push(...analysis.observations)
        settled = true
        break
      }
    }
    if (!settled) contentionRuns += 1
  }

  return {
    scannedRuns: listedRuns.length,
    changedRuns,
    contentionRuns,
    telemetryFailures: await emitTelemetry(observations, options.sink),
    observations,
  }
}
