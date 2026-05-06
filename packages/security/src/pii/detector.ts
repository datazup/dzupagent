/**
 * PII pattern library and lightweight detector.
 *
 * Each pattern is a global RegExp so the detector can collect every
 * occurrence in one pass. Sanitization replaces each match with a typed
 * redaction marker (`[REDACTED-SSN]`, `[REDACTED-CC]`, etc.) so downstream
 * consumers can still distinguish *what kind* of secret was removed
 * without ever seeing the raw value.
 */
/* eslint-disable security/detect-unsafe-regex --
 * These patterns are the package's security primitives. Each has been
 * vetted for catastrophic backtracking: every quantifier is bounded
 * ({n,m}) or anchored (\b…\b) and there is no nested unbounded
 * repetition. The eslint-plugin-security heuristic flags any nested
 * quantifier at all, so we disable the rule for this PII pattern table.
 */
export const PII_PATTERNS: Readonly<Record<string, RegExp>> = {
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
  CREDIT_CARD: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
  IBAN: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}(?:[A-Z0-9]?){0,16}\b/g,
  JWT: /eyJ[A-Za-z0-9_-]{2,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/g,
  API_KEY_GENERIC: /\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9]{20,}\b/gi,
  PHONE: /(?<![.\d])(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\.\d)/g,
  IP_ADDRESS:
    /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
}
/* eslint-enable security/detect-unsafe-regex */

/** Short label used in the redaction marker for each PII type. */
const REDACTION_TAG: Readonly<Record<string, string>> = {
  EMAIL: 'EMAIL',
  SSN: 'SSN',
  CREDIT_CARD: 'CC',
  PHONE: 'PHONE',
  IP_ADDRESS: 'IP',
  IBAN: 'IBAN',
  JWT: 'JWT',
  API_KEY_GENERIC: 'API-KEY',
}

export type PiiCanonicalType =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'credit-card'
  | 'ip-address'
  | 'iban'
  | 'jwt'
  | 'api-key'

const CANONICAL_TYPE: Readonly<Record<string, PiiCanonicalType>> = {
  EMAIL: 'email',
  SSN: 'ssn',
  CREDIT_CARD: 'credit-card',
  PHONE: 'phone',
  IP_ADDRESS: 'ip-address',
  IBAN: 'iban',
  JWT: 'jwt',
  API_KEY_GENERIC: 'api-key',
}

export interface PiiScanResult {
  hasPii: boolean
  /** Distinct PII type keys discovered (e.g. `['SSN', 'JWT']`). */
  types: string[]
}

export interface PiiMatch {
  /** Public security package type key, for example `SSN` or `API_KEY_GENERIC`. */
  type: string
  /** Lowercase canonical type used by compatibility adapters. */
  canonicalType: PiiCanonicalType
  value: string
  start: number
  end: number
}

export interface PiiDetailedScanResult extends PiiScanResult {
  matches: PiiMatch[]
  /** Sanitized text using the security package's `[REDACTED-<TAG>]` markers. */
  redacted: string
}

/** Stateless PII detector — every method is a pure function over its input. */
export class PiiDetector {
  /**
   * Identify which PII categories are present in `text` without mutating
   * the input. Returns `hasPii: false` for empty / non-string input.
   */
  scan(text: string): PiiScanResult {
    const { hasPii, types } = this.scanDetailed(text)
    return { hasPii, types }
  }

  /**
   * Identify every non-overlapping PII match and produce a redacted copy.
   * Earlier patterns in `PII_PATTERNS` have priority over later overlapping
   * matches, which keeps broad patterns from double-counting richer matches.
   */
  scanDetailed(text: string): PiiDetailedScanResult {
    if (typeof text !== 'string' || text.length === 0) {
      return { hasPii: false, types: [], matches: [], redacted: text ?? '' }
    }

    const matches: PiiMatch[] = []
    const replacements: Array<{ start: number; end: number; type: string }> = []

    for (const [name, pattern] of Object.entries(PII_PATTERNS)) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const start = match.index
        const end = start + match[0].length
        const overlaps = replacements.some((r) => start < r.end && end > r.start)
        if (overlaps) continue

        matches.push({
          type: name,
          canonicalType: CANONICAL_TYPE[name] ?? 'api-key',
          value: match[0],
          start,
          end,
        })
        replacements.push({ start, end, type: name })
      }
    }

    const types = Array.from(new Set(matches.map((match) => match.type)))
    let redacted = text
    for (const { start, end, type } of [...replacements].sort((a, b) => b.start - a.start)) {
      const tag = REDACTION_TAG[type] ?? type
      redacted = redacted.slice(0, start) + `[REDACTED-${tag}]` + redacted.slice(end)
    }

    return { hasPii: matches.length > 0, types, matches, redacted }
  }

  /**
   * Replace every PII match with `[REDACTED-<TAG>]`. Idempotent and safe
   * to run on already-sanitized text (no patterns match the redaction
   * marker itself).
   */
  sanitize(text: string): string {
    return this.scanDetailed(text).redacted
  }
}
