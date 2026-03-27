/**
 * Security scanning for memory content.
 *
 * Detects prompt injection, exfiltration commands, and invisible Unicode
 * before content is stored. Inspired by Hermes Agent's memory security model.
 */

export interface SanitizeResult {
  safe: boolean
  /** Original content (returned as-is when safe) */
  content: string
  /** List of threats detected (empty when safe) */
  threats: string[]
}

/**
 * Patterns that indicate prompt injection attempts.
 * Matches are case-insensitive.
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, label: 'prompt-injection: ignore-previous' },
  { pattern: /disregard\s+(all\s+)?prior\s+(instructions|context)/i, label: 'prompt-injection: disregard-prior' },
  { pattern: /system\s+prompt\s+override/i, label: 'prompt-injection: system-override' },
  { pattern: /you\s+are\s+now\s+(a|an)\s+/i, label: 'prompt-injection: persona-hijack' },
  { pattern: /new\s+instructions?\s*:/i, label: 'prompt-injection: new-instructions' },
  { pattern: /forget\s+(everything|all)\s+(you|that)/i, label: 'prompt-injection: forget-context' },
  { pattern: /\bdo\s+not\s+follow\s+(any|the)\s+(previous|above)/i, label: 'prompt-injection: do-not-follow' },
  { pattern: /\bact\s+as\s+if\s+you\s+(are|were)\b/i, label: 'prompt-injection: act-as' },
]

/**
 * Patterns that indicate exfiltration or remote execution attempts.
 */
const EXFILTRATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bcurl\b.*\$[A-Z_]/i, label: 'exfiltration: curl-with-env-var' },
  { pattern: /\bwget\b.*\$[A-Z_]/i, label: 'exfiltration: wget-with-env-var' },
  { pattern: /\bssh\b.*\b(exec|command)\b/i, label: 'exfiltration: ssh-exec' },
  { pattern: /\bnc\s+-[elp]/i, label: 'exfiltration: netcat-listener' },
  { pattern: /\beval\s*\(\s*atob\b/i, label: 'exfiltration: eval-base64' },
  { pattern: /\b(curl|wget|fetch)\b.*\b(api[_-]?key|token|secret|password)\b/i, label: 'exfiltration: credential-leak' },
  { pattern: /\breverse\s+shell\b/i, label: 'exfiltration: reverse-shell' },
  { pattern: /\bbase64\b.*\b(decode|--decode|-d)\b.*\|\s*(sh|bash)\b/i, label: 'exfiltration: base64-pipe-shell' },
]

/**
 * Unicode ranges that are invisible/zero-width and commonly used
 * for hidden payload injection.
 */
const INVISIBLE_UNICODE_PATTERN =
  /[\u200B\u200C\u200D\u200E\u200F\u2028\u2029\u2060\u2061\u2062\u2063\u2064\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E]/

/**
 * Scans content for security threats before storing in memory.
 *
 * Returns a result object indicating whether the content is safe.
 * Does NOT throw — callers decide how to handle unsafe content.
 */
export function sanitizeMemoryContent(content: string): SanitizeResult {
  const threats: string[] = []

  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      threats.push(label)
    }
  }

  for (const { pattern, label } of EXFILTRATION_PATTERNS) {
    if (pattern.test(content)) {
      threats.push(label)
    }
  }

  if (INVISIBLE_UNICODE_PATTERN.test(content)) {
    threats.push('invisible-unicode: hidden characters detected')
  }

  return {
    safe: threats.length === 0,
    content,
    threats,
  }
}

/**
 * Strips invisible Unicode characters from content.
 * Use this when you want to clean content rather than reject it.
 */
export function stripInvisibleUnicode(content: string): string {
  return content.replace(
    /[\u200B\u200C\u200D\u200E\u200F\u2028\u2029\u2060\u2061\u2062\u2063\u2064\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E]/g,
    '',
  )
}
