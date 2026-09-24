/**
 * Coordination attempt report (MVP-04-CP05).
 *
 * A provider's structured report is a claim for the controller to reconcile
 * with what it observes; it is never an authority record.
 *
 * Rules:
 * - The report is a closed object: every field is required and no other key
 *   is accepted, so a report cannot smuggle in effects or scope.
 * - Transport is fixed by the renderer profile, never guessed from the reply:
 *   `native_schema` expects the whole reply to be the report JSON;
 *   `wrapper_capture` expects exactly one fenced `coordination-report` block.
 * - A report for another attempt is refused.
 * - Provider text is never echoed in an absent or invalid capture.
 *
 * Admission: workspace-docs doc-coord-mvp04-cp05-admit-20260924-r1/ADMISSION.md §3.3.
 */
import type { CoordinationSha256Digest } from '@dzupagent/adapter-types'

import { coordinationCanonicalDigest } from './coordination-assignment-decoder.js'

export const COORDINATION_ATTEMPT_REPORT_SCHEMA = 'dzupagent.coordinationAttemptReport/v1' as const

/** Fence info string for wrapper-captured reports. */
export const COORDINATION_REPORT_FENCE = 'coordination-report' as const

export type CoordinationReportTransport = 'native_schema' | 'wrapper_capture'

export type CoordinationAttemptReportStatus = 'completed' | 'blocked' | 'failed'

export interface CoordinationAttemptReport {
  readonly schema: typeof COORDINATION_ATTEMPT_REPORT_SCHEMA
  readonly attemptId: string
  readonly status: CoordinationAttemptReportStatus
  readonly summary: string
  readonly filesBelievedChanged: readonly string[]
  readonly validationAttempted: readonly string[]
  readonly blockers: readonly string[]
  /** Requests for the controller; never a grant. */
  readonly scopeRequests: readonly string[]
  readonly nextAction: string
}

export type CoordinationAttemptReportCapture =
  | {
      readonly status: 'captured'
      readonly authority: 'claim'
      readonly transport: CoordinationReportTransport
      readonly report: CoordinationAttemptReport
      readonly reportDigest: CoordinationSha256Digest
    }
  | {
      readonly status: 'absent' | 'invalid'
      readonly authority: 'claim'
      readonly transport: CoordinationReportTransport
      readonly code: string
    }

const STATUSES: readonly CoordinationAttemptReportStatus[] = ['completed', 'blocked', 'failed']
const TEXT_FIELDS = ['attemptId', 'summary', 'nextAction'] as const
const LIST_FIELDS = ['filesBelievedChanged', 'validationAttempted', 'blockers', 'scopeRequests'] as const
const REPORT_FIELDS = ['schema', 'attemptId', 'status', ...TEXT_FIELDS.slice(1), ...LIST_FIELDS] as const
const MAX_TEXT = 4000
const MAX_ENTRY = 1000
const MAX_ENTRIES = 200

const stringList = { type: 'array', items: { type: 'string' } } as const

/**
 * The schema sent as `outputSchema`: closed, every property required. Bounds
 * are enforced by the capture, not asked of the provider.
 */
export const COORDINATION_ATTEMPT_REPORT_JSON_SCHEMA: Readonly<Record<string, unknown>> = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: [...REPORT_FIELDS],
  properties: {
    schema: { type: 'string', enum: [COORDINATION_ATTEMPT_REPORT_SCHEMA] },
    attemptId: { type: 'string' },
    status: { type: 'string', enum: [...STATUSES] },
    summary: { type: 'string' },
    filesBelievedChanged: stringList,
    validationAttempted: stringList,
    blockers: stringList,
    scopeRequests: stringList,
    nextAction: { type: 'string' },
  },
})

const FENCE_PATTERN = new RegExp(`^\`\`\`${COORDINATION_REPORT_FENCE}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`[ \\t]*$`, 'gmu')

/**
 * Capture the report from a provider's final text. Never throws; the result
 * is frozen and always labelled a claim.
 */
export function captureCoordinationAttemptReport(
  text: unknown,
  expected: { readonly transport: CoordinationReportTransport; readonly attemptId: string },
): CoordinationAttemptReportCapture {
  const { transport, attemptId } = expected
  const fail = (status: 'absent' | 'invalid', code: string): CoordinationAttemptReportCapture =>
    Object.freeze({ status, authority: 'claim', transport, code })
  if (typeof text !== 'string' || text.trim().length === 0) return fail('absent', 'COORD_REPORT_ABSENT')

  let body: string
  if (transport === 'native_schema') {
    body = text.trim()
  } else {
    const blocks = [...text.matchAll(FENCE_PATTERN)]
    if (blocks.length === 0) return fail('absent', 'COORD_REPORT_ABSENT')
    if (blocks.length > 1) return fail('invalid', 'COORD_REPORT_AMBIGUOUS')
    body = blocks[0]![1]!
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return fail('invalid', 'COORD_REPORT_INVALID')
  }
  const report = validateReport(parsed)
  if (report === undefined) return fail('invalid', 'COORD_REPORT_INVALID')
  if (report.attemptId !== attemptId) return fail('invalid', 'COORD_REPORT_ATTEMPT_MISMATCH')
  return deepFreeze({
    status: 'captured',
    authority: 'claim',
    transport,
    report,
    reportDigest: coordinationCanonicalDigest(report),
  })
}

function validateReport(value: unknown): CoordinationAttemptReport | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== REPORT_FIELDS.length || !keys.every((key) => (REPORT_FIELDS as readonly string[]).includes(key))) {
    return undefined
  }
  if (record['schema'] !== COORDINATION_ATTEMPT_REPORT_SCHEMA) return undefined
  if (!STATUSES.includes(record['status'] as CoordinationAttemptReportStatus)) return undefined
  for (const field of TEXT_FIELDS) {
    const text = record[field]
    if (typeof text !== 'string' || text.length > MAX_TEXT) return undefined
  }
  for (const field of LIST_FIELDS) {
    const list = record[field]
    if (!Array.isArray(list) || list.length > MAX_ENTRIES) return undefined
    if (!list.every((entry) => typeof entry === 'string' && entry.length <= MAX_ENTRY)) return undefined
  }
  return {
    schema: COORDINATION_ATTEMPT_REPORT_SCHEMA,
    attemptId: record['attemptId'] as string,
    status: record['status'] as CoordinationAttemptReportStatus,
    summary: record['summary'] as string,
    filesBelievedChanged: [...(record['filesBelievedChanged'] as string[])],
    validationAttempted: [...(record['validationAttempted'] as string[])],
    blockers: [...(record['blockers'] as string[])],
    scopeRequests: [...(record['scopeRequests'] as string[])],
    nextAction: record['nextAction'] as string,
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
