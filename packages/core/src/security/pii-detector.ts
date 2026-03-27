/**
 * PII (Personally Identifiable Information) detection and redaction.
 *
 * Detects emails, phone numbers, SSNs, credit card numbers, and IP addresses
 * using regex patterns. Redacts matches with [REDACTED:type] placeholders.
 */

export type PIIType = 'email' | 'phone' | 'ssn' | 'credit-card' | 'ip-address'

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

const PII_PATTERNS: Array<{ pattern: RegExp; type: PIIType }> = [
  // Email addresses
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    type: 'email',
  },
  // US SSN (must come before phone to avoid partial matches)
  {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    type: 'ssn',
  },
  // Credit card numbers (4 groups of 4 digits, with optional separators)
  {
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    type: 'credit-card',
  },
  // Phone numbers (US/international formats)
  {
    pattern: /(?<![.\d])(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\.\d)/g,
    type: 'phone',
  },
  // IPv4 addresses (validate octet range 0-255)
  {
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    type: 'ip-address',
  },
]

/**
 * Detect PII in text content using regex patterns.
 */
export function detectPII(content: string): PIIDetectionResult {
  const matches: PIIMatch[] = []
  const replacements: Array<{ start: number; end: number; type: PIIType }> = []

  for (const { pattern, type } of PII_PATTERNS) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(content)) !== null) {
      const start = m.index
      const end = start + m[0].length

      // Skip if this region overlaps with a higher-priority match
      const overlaps = replacements.some(
        (r) => start < r.end && end > r.start,
      )
      if (overlaps) continue

      matches.push({ type, value: m[0], start, end })
      replacements.push({ start, end, type })
    }
  }

  // Build redacted string — process from end to start to preserve offsets
  let redacted = content
  const sorted = [...replacements].sort((a, b) => b.start - a.start)
  for (const { start, end, type } of sorted) {
    redacted = redacted.slice(0, start) + `[REDACTED:${type}]` + redacted.slice(end)
  }

  return {
    hasPII: matches.length > 0,
    matches,
    redacted,
  }
}

/**
 * Redact all PII from content, replacing with [REDACTED:type] placeholders.
 */
export function redactPII(content: string): string {
  return detectPII(content).redacted
}
