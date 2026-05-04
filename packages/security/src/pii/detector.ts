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
  SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
  CREDIT_CARD:
    /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
  IBAN: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}(?:[A-Z0-9]?){0,16}\b/g,
  JWT: /eyJ[A-Za-z0-9_-]{2,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/g,
  API_KEY_GENERIC: /\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9]{20,}\b/gi,
}
/* eslint-enable security/detect-unsafe-regex */

/** Short label used in the redaction marker for each PII type. */
const REDACTION_TAG: Readonly<Record<string, string>> = {
  SSN: 'SSN',
  CREDIT_CARD: 'CC',
  IBAN: 'IBAN',
  JWT: 'JWT',
  API_KEY_GENERIC: 'API-KEY',
}

export interface PiiScanResult {
  hasPii: boolean
  /** Distinct PII type keys discovered (e.g. `['SSN', 'JWT']`). */
  types: string[]
}

/** Stateless PII detector — every method is a pure function over its input. */
export class PiiDetector {
  /**
   * Identify which PII categories are present in `text` without mutating
   * the input. Returns `hasPii: false` for empty / non-string input.
   */
  scan(text: string): PiiScanResult {
    if (typeof text !== 'string' || text.length === 0) {
      return { hasPii: false, types: [] }
    }
    const types: string[] = []
    for (const [name, pattern] of Object.entries(PII_PATTERNS)) {
      // Reset lastIndex defensively in case the same RegExp instance
      // was used elsewhere (global flag carries cursor state).
      pattern.lastIndex = 0
      if (pattern.test(text)) {
        types.push(name)
      }
    }
    return { hasPii: types.length > 0, types }
  }

  /**
   * Replace every PII match with `[REDACTED-<TAG>]`. Idempotent and safe
   * to run on already-sanitized text (no patterns match the redaction
   * marker itself).
   */
  sanitize(text: string): string {
    if (typeof text !== 'string' || text.length === 0) return text ?? ''
    let out = text
    for (const [name, pattern] of Object.entries(PII_PATTERNS)) {
      const tag = REDACTION_TAG[name] ?? name
      pattern.lastIndex = 0
      out = out.replace(pattern, `[REDACTED-${tag}]`)
    }
    return out
  }
}
