/**
 * Compatibility adapter for PII detection and redaction.
 *
 * The canonical scanner lives in `@dzupagent/security`; this module preserves
 * the historical `@dzupagent/core` result shape and redaction markers.
 */
import { PiiDetector, type PiiCanonicalType } from '@dzupagent/security'

export type PIIType = Extract<
  PiiCanonicalType,
  'email' | 'phone' | 'ssn' | 'credit-card' | 'ip-address'
>

export interface PIIMatch {
  type: PIIType
  value: string
  start: number
  end: number
}

export interface PIIDetectionResult {
  hasPII: boolean
  matches: PIIMatch[]
  redacted: string
}

const CORE_PII_TYPES: ReadonlySet<PiiCanonicalType> = new Set([
  'email',
  'phone',
  'ssn',
  'credit-card',
  'ip-address',
])

const detector = new PiiDetector()

/**
 * Detect PII in text content using the shared `@dzupagent/security` scanner.
 */
export function detectPII(content: string): PIIDetectionResult {
  const scan = detector.scanDetailed(content)
  const matches = scan.matches
    .filter((match) => CORE_PII_TYPES.has(match.canonicalType))
    .map((match) => ({
      type: match.canonicalType as PIIType,
      value: match.value,
      start: match.start,
      end: match.end,
    }))

  let redacted = content
  for (const { start, end, type } of [...matches].sort((a, b) => b.start - a.start)) {
    redacted = redacted.slice(0, start) + `[REDACTED:${type}]` + redacted.slice(end)
  }

  return {
    hasPII: matches.length > 0,
    matches,
    redacted,
  }
}

/**
 * Redact all PII from content, replacing with `[REDACTED:type]` placeholders.
 */
export function redactPII(content: string): string {
  return detectPII(content).redacted
}
