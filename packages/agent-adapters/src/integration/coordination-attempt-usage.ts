/**
 * Coordination attempt usage (MVP-04-CP07).
 *
 * Binds what a provider reported about usage to the immutable attempt, and
 * totals usage over attempts without ever presenting an uncertain set as
 * complete.
 *
 * Rules:
 * - Identity comes from the attempt correlation, never from the provider.
 * - Absent usage is `unknown`, never zero.
 * - An invalid count or cost is `uncertain`; nothing is coerced or clamped.
 * - Provider-reported cost is never authoritative. When the host prices the
 *   tokens under the bound tariff and gets a different figure, both are kept
 *   and the record is `uncertain`; neither figure is chosen.
 * - In a total, the same record reported twice is counted once; two different
 *   records for one attempt are a conflict and neither is counted.
 *
 * Admission: workspace-docs doc-coord-mvp04-cp07-admit-20260924-r1/ADMISSION.md §3.
 */
import type { CoordinationExecutionProviderId, CoordinationSha256Digest } from '@dzupagent/adapter-types'

import { coordinationCanonicalDigest, coordinationSelfDigest } from './coordination-assignment-decoder.js'
import type { CoordinationAttemptCorrelation } from './coordination-attempt-runner.js'
import type { AgentExecutionResult } from './run-agent-execution.js'

export const COORDINATION_ATTEMPT_USAGE_SCHEMA = 'dzupagent.coordinationAttemptUsage/v1' as const
export const COORDINATION_USAGE_TOTAL_SCHEMA = 'dzupagent.coordinationUsageTotal/v1' as const

export type CoordinationAttemptUsageStatus = 'reported' | 'unknown' | 'uncertain'

export type CoordinationAttemptUsageReason =
  | 'USAGE_NOT_REPORTED'
  | 'USAGE_VALUE_INVALID'
  | 'USAGE_COST_INVALID'
  | 'USAGE_TARIFF_PRICE_INVALID'
  | 'USAGE_COST_DISAGREES'

export type CoordinationUsageTotalReason =
  | CoordinationAttemptUsageReason
  | 'USAGE_RECORD_INVALID'
  | 'USAGE_DUPLICATE_DISAGREES'
  | 'USAGE_TOTAL_OVERFLOW'

/** Token counts, each a non-negative safe integer. */
export interface CoordinationAttemptTokens {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens?: number
  readonly cacheWriteTokens?: number
}

export interface CoordinationAttemptUsageRecord {
  readonly schema: typeof COORDINATION_ATTEMPT_USAGE_SCHEMA
  readonly attemptId: string
  readonly assignmentId: string
  readonly bindingId: string
  readonly providerId: CoordinationExecutionProviderId
  readonly tariffRef: string
  /** Canonical digest of the attempt correlation. */
  readonly correlationDigest: CoordinationSha256Digest
  readonly status: CoordinationAttemptUsageStatus
  readonly tokens?: CoordinationAttemptTokens
  /** What the provider said it cost. A claim, never the billed amount. */
  readonly providerReportedCostCents?: number
  /** What the host's pricer computed under `tariffRef`. */
  readonly tariffCostCents?: number
  readonly reasons: readonly CoordinationAttemptUsageReason[]
  /** Self-digest of the record without this field. */
  readonly recordDigest: CoordinationSha256Digest
}

/**
 * Host pricing under the bound tariff. Return `undefined` when the tariff
 * cannot price these tokens; a throw or a non-finite/negative figure makes
 * the record `uncertain`.
 */
export type CoordinationUsagePricer = (input: {
  readonly tariffRef: string
  /** The tariff digest a v3 binding pins; absent for a v2 binding. */
  readonly tariffDigest?: CoordinationSha256Digest
  readonly providerId: CoordinationExecutionProviderId
  readonly tokens: CoordinationAttemptTokens
}) => number | undefined

export interface RecordCoordinationAttemptUsageOptions {
  readonly priceUsage?: CoordinationUsagePricer | undefined
  /** Forwarded to the pricer when the plan pins a tariff digest. */
  readonly tariffDigest?: CoordinationSha256Digest | undefined
}

type ReportedUsage = AgentExecutionResult['usage']

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'] as const

/** Bind one attempt's reported usage to the attempt. */
export function recordCoordinationAttemptUsage(
  correlation: CoordinationAttemptCorrelation,
  usage: ReportedUsage,
  options: RecordCoordinationAttemptUsageOptions = {},
): CoordinationAttemptUsageRecord {
  const reasons = new Set<CoordinationAttemptUsageReason>()
  const body: Record<string, unknown> = {
    schema: COORDINATION_ATTEMPT_USAGE_SCHEMA,
    attemptId: correlation.attemptId,
    assignmentId: correlation.assignmentId,
    bindingId: correlation.bindingId,
    providerId: correlation.providerId,
    tariffRef: correlation.tariffRef,
    correlationDigest: coordinationCanonicalDigest(correlation),
  }

  if (usage === undefined || usage === null) {
    reasons.add('USAGE_NOT_REPORTED')
  } else {
    const tokens = validTokens(usage)
    if (tokens) body['tokens'] = tokens
    else reasons.add('USAGE_VALUE_INVALID')

    if (usage.costCents !== undefined) {
      if (isNonNegativeFinite(usage.costCents)) body['providerReportedCostCents'] = usage.costCents
      else reasons.add('USAGE_COST_INVALID')
    }

    if (tokens && options.priceUsage) {
      const priced = price(options.priceUsage, correlation, tokens, options.tariffDigest)
      if (priced === 'invalid') reasons.add('USAGE_TARIFF_PRICE_INVALID')
      else if (priced !== undefined) body['tariffCostCents'] = priced
    }

    const reported = body['providerReportedCostCents']
    const tariff = body['tariffCostCents']
    if (reported !== undefined && tariff !== undefined && reported !== tariff) {
      reasons.add('USAGE_COST_DISAGREES')
    }
  }

  body['status'] = reasons.has('USAGE_NOT_REPORTED') ? 'unknown' : reasons.size > 0 ? 'uncertain' : 'reported'
  body['reasons'] = Object.freeze([...reasons].sort())
  body['recordDigest'] = coordinationSelfDigest(body, 'recordDigest')
  return Object.freeze(body) as unknown as CoordinationAttemptUsageRecord
}

export interface CoordinationUsageTotal {
  readonly schema: typeof COORDINATION_USAGE_TOTAL_SCHEMA
  /** `complete` only when every distinct attempt reported and nothing conflicts. */
  readonly status: 'complete' | 'uncertain'
  /** Distinct attempts seen, including incomplete and conflicting ones. */
  readonly attempts: number
  /** Identical reports of one attempt beyond the first. */
  readonly duplicatesCollapsed: number
  /** Sum over `reported` attempts only; a lower bound when `uncertain`. */
  readonly knownTokens: Required<CoordinationAttemptTokens>
  readonly incompleteAttempts: readonly string[]
  readonly conflictingAttempts: readonly string[]
  readonly reasons: readonly CoordinationUsageTotalReason[]
}

/** Total usage over attempt records, collapsing duplicate reports of one attempt. */
export function totalCoordinationAttemptUsage(
  records: readonly CoordinationAttemptUsageRecord[],
): CoordinationUsageTotal {
  const reasons = new Set<CoordinationUsageTotalReason>()
  const byAttempt = new Map<string, CoordinationAttemptUsageRecord[]>()
  for (const record of records) {
    if (!isValidRecord(record)) {
      reasons.add('USAGE_RECORD_INVALID')
      continue
    }
    const seen = byAttempt.get(record.attemptId)
    if (seen) seen.push(record)
    else byAttempt.set(record.attemptId, [record])
  }

  const knownTokens = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }
  const incompleteAttempts: string[] = []
  const conflictingAttempts: string[] = []
  let duplicatesCollapsed = 0

  for (const [attemptId, reports] of byAttempt) {
    const digests = new Set(reports.map((report) => report.recordDigest))
    if (digests.size > 1) {
      conflictingAttempts.push(attemptId)
      reasons.add('USAGE_DUPLICATE_DISAGREES')
      continue
    }
    duplicatesCollapsed += reports.length - 1
    const record = reports[0]!
    if (record.status !== 'reported' || !record.tokens) {
      incompleteAttempts.push(attemptId)
      for (const reason of record.reasons) reasons.add(reason)
      continue
    }
    for (const field of TOKEN_FIELDS) {
      const sum = knownTokens[field] + (record.tokens[field] ?? 0)
      if (!Number.isSafeInteger(sum)) reasons.add('USAGE_TOTAL_OVERFLOW')
      else knownTokens[field] = sum
    }
  }

  return Object.freeze({
    schema: COORDINATION_USAGE_TOTAL_SCHEMA,
    status: reasons.size === 0 ? 'complete' : 'uncertain',
    attempts: byAttempt.size,
    duplicatesCollapsed,
    knownTokens: Object.freeze(knownTokens),
    incompleteAttempts: Object.freeze(incompleteAttempts.sort()),
    conflictingAttempts: Object.freeze(conflictingAttempts.sort()),
    reasons: Object.freeze([...reasons].sort()),
  })
}

function validTokens(usage: NonNullable<ReportedUsage>): CoordinationAttemptTokens | undefined {
  const tokens: Record<string, number> = {}
  for (const field of TOKEN_FIELDS) {
    const value: unknown = usage[field]
    if (value === undefined) {
      if (field === 'inputTokens' || field === 'outputTokens') return undefined
      continue
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
    tokens[field] = value
  }
  return Object.freeze(tokens) as unknown as CoordinationAttemptTokens
}

function price(
  pricer: CoordinationUsagePricer,
  correlation: CoordinationAttemptCorrelation,
  tokens: CoordinationAttemptTokens,
  tariffDigest: CoordinationSha256Digest | undefined,
): number | undefined | 'invalid' {
  let priced: unknown
  try {
    priced = pricer({
      tariffRef: correlation.tariffRef,
      ...(tariffDigest !== undefined ? { tariffDigest } : {}),
      providerId: correlation.providerId,
      tokens,
    })
  } catch {
    // The pricer's error text is host detail; only the fact of failure is kept.
    return 'invalid'
  }
  if (priced === undefined) return undefined
  return isNonNegativeFinite(priced) ? priced : 'invalid'
}

function isValidRecord(record: unknown): record is CoordinationAttemptUsageRecord {
  if (typeof record !== 'object' || record === null) return false
  const candidate = record as Record<string, unknown>
  return candidate['schema'] === COORDINATION_ATTEMPT_USAGE_SCHEMA
    && typeof candidate['attemptId'] === 'string'
    && candidate['recordDigest'] === coordinationSelfDigest(candidate, 'recordDigest')
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
