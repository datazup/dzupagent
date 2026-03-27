/**
 * Secrets detection and redaction for code and text content.
 *
 * Scans for hardcoded secrets (API keys, passwords, tokens, connection strings)
 * using regex patterns and Shannon entropy analysis.
 */

export interface SecretMatch {
  type: string
  value: string
  line?: number
  confidence: number
}

export interface ScanResult {
  hasSecrets: boolean
  matches: SecretMatch[]
  redacted: string
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; type: string; confidence: number }> = [
  // AWS
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, type: 'aws-access-key', confidence: 0.95 },
  { pattern: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g, type: 'aws-secret-key', confidence: 0.4 },

  // GitHub tokens
  { pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/g, type: 'github-token', confidence: 0.95 },

  // GitLab tokens
  { pattern: /\bglpat-[A-Za-z0-9\-_]{20,}\b/g, type: 'gitlab-token', confidence: 0.95 },

  // Slack tokens
  { pattern: /\b(xoxb|xoxp|xapp)-[A-Za-z0-9\-]{10,}/g, type: 'slack-token', confidence: 0.95 },

  // Generic API keys, passwords, secrets, tokens (in assignments)
  { pattern: /api[_-]?key\s*[:=]\s*["']([A-Za-z0-9_\-/.+=]{8,})["']/gi, type: 'generic-api-key', confidence: 0.8 },
  { pattern: /password\s*[:=]\s*["']([^\s"']{8,})["']/gi, type: 'generic-password', confidence: 0.85 },
  { pattern: /(?:secret|token)\s*[:=]\s*["']([A-Za-z0-9_\-/.+=]{8,})["']/gi, type: 'generic-secret', confidence: 0.8 },

  // Connection strings
  { pattern: /\b(postgresql|mongodb|redis|mysql):\/\/[^\s"'`,)}\]]{10,}/gi, type: 'connection-string', confidence: 0.9 },

  // JWT tokens
  { pattern: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_\-+/=]{20,}\b/g, type: 'jwt-token', confidence: 0.9 },

  // Private keys
  { pattern: /-----BEGIN\s[\w\s]*PRIVATE KEY-----[\s\S]*?-----END\s[\w\s]*PRIVATE KEY-----/g, type: 'private-key', confidence: 0.99 },

  // Bearer tokens in code
  { pattern: /Authorization['":\s]+Bearer\s+([A-Za-z0-9_\-/.+=]{20,})/gi, type: 'bearer-token', confidence: 0.85 },
]

/**
 * Compute Shannon entropy (bits per character) for a string.
 */
function shannonEntropy(str: string): number {
  const freq = new Map<string, number>()
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1)
  }
  const len = str.length
  let entropy = 0
  for (const count of freq.values()) {
    const p = count / len
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/**
 * Pattern for quoted string values in assignments (for entropy check).
 */
const ASSIGNED_STRING_PATTERN = /(?:[:=])\s*["']([A-Za-z0-9_\-/.+=]{20,})["']/g

/**
 * Finds the 1-based line number for a character offset in content.
 */
function lineNumberAt(content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

/**
 * Scan content for hardcoded secrets using pattern matching and entropy analysis.
 */
export function scanForSecrets(content: string): ScanResult {
  const matches: SecretMatch[] = []
  const replacements: Array<{ start: number; end: number; type: string }> = []

  // Pattern-based detection
  for (const { pattern, type, confidence } of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(content)) !== null) {
      // Use captured group if present, otherwise full match
      const value = m[1] !== undefined ? m[1] : m[0]
      matches.push({
        type,
        value,
        line: lineNumberAt(content, m.index),
        confidence,
      })
      replacements.push({ start: m.index, end: m.index + m[0].length, type })
    }
  }

  // Entropy-based detection for assigned string values
  ASSIGNED_STRING_PATTERN.lastIndex = 0
  let em: RegExpExecArray | null
  while ((em = ASSIGNED_STRING_PATTERN.exec(content)) !== null) {
    const value = em[1]
    if (value !== undefined && value.length > 20 && shannonEntropy(value) > 4.5) {
      // Avoid duplicating already-detected secrets
      const offset = em.index
      const alreadyFound = replacements.some(
        (r) => r.start <= offset && r.end >= offset + em![0].length,
      )
      if (!alreadyFound) {
        matches.push({
          type: 'generic-high-entropy',
          value,
          line: lineNumberAt(content, offset),
          confidence: 0.6,
        })
        replacements.push({ start: offset, end: offset + em[0].length, type: 'generic-high-entropy' })
      }
    }
  }

  // Build redacted string — process replacements from end to start
  let redacted = content
  const sorted = [...replacements].sort((a, b) => b.start - a.start)
  for (const { start, end, type } of sorted) {
    redacted = redacted.slice(0, start) + `[REDACTED:${type}]` + redacted.slice(end)
  }

  return {
    hasSecrets: matches.length > 0,
    matches,
    redacted,
  }
}

/**
 * Convenience function that returns content with all detected secrets redacted.
 */
export function redactSecrets(content: string): string {
  return scanForSecrets(content).redacted
}
