/**
 * Shared low-tier pattern DATA for the content/memory sanitizers.
 *
 * `@dzupagent/core`'s `content-sanitizer` (Layer 1) and
 * `@dzupagent/memory`'s `memory-sanitizer` historically each carried a
 * byte-identical copy of these three pattern tables. Because the two were
 * tested separately, a new injection/exfiltration pattern added to one copy
 * could silently drift from the other, so memory-layer content could pass an
 * injection that Layer 1 would have blocked (audit finding DZUPAGENT-CODE-H-03).
 *
 * The pattern DATA now lives here — in `@dzupagent/security`, the lowest shared
 * tier that BOTH core and memory already depend on (it has zero internal
 * runtime dependencies). Each sanitizer keeps its own thin scan wrapper and
 * imports these tables, so there is exactly one source of truth for the
 * pattern set and no cross-layer scanner dependency.
 *
 * This does NOT violate the MC-A01 constraint documented in
 * `core/security/content-sanitizer.ts`: MC-A01 forbids Layer 1 depending on
 * `@dzupagent/memory`. `@dzupagent/security` is a leaf below both layers, so a
 * shared table that both import introduces no Layer-1 -> memory dependency and
 * no cycle.
 *
 * @module @dzupagent/security/sanitizer-patterns
 */

/** A single labeled regex used by the content/memory scanners. */
export interface LabeledPattern {
  pattern: RegExp
  label: string
}

/** Patterns indicating prompt-injection attempts (case-insensitive). */
export const SANITIZER_INJECTION_PATTERNS: ReadonlyArray<LabeledPattern> = [
  { pattern: /ignore\s+(?:all\s)?previous\s+instructions/i, label: 'prompt-injection: ignore-previous' },
  { pattern: /disregard\s+(?:all\s)?prior\s+(?:instructions|context)/i, label: 'prompt-injection: disregard-prior' },
  { pattern: /system\s+prompt\s+override/i, label: 'prompt-injection: system-override' },
  { pattern: /you\s+are\s+now\s+(a|an)\s+/i, label: 'prompt-injection: persona-hijack' },
  { pattern: /new\s+instructions?\s*:/i, label: 'prompt-injection: new-instructions' },
  { pattern: /forget\s+(everything|all)\s+(you|that)/i, label: 'prompt-injection: forget-context' },
  { pattern: /\bdo\s+not\s+follow\s+(any|the)\s+(previous|above)/i, label: 'prompt-injection: do-not-follow' },
  { pattern: /\bact\s+as\s+if\s+you\s+(are|were)\b/i, label: 'prompt-injection: act-as' },
]

/** Patterns indicating exfiltration / remote-execution attempts. */
export const SANITIZER_EXFILTRATION_PATTERNS: ReadonlyArray<LabeledPattern> = [
  { pattern: /\bcurl\b.*\$[A-Z_]/i, label: 'exfiltration: curl-with-env-var' },
  { pattern: /\bwget\b.*\$[A-Z_]/i, label: 'exfiltration: wget-with-env-var' },
  { pattern: /\bssh\b.*\b(exec|command)\b/i, label: 'exfiltration: ssh-exec' },
  { pattern: /\bnc\s+-[elp]/i, label: 'exfiltration: netcat-listener' },
  { pattern: /\beval\s*\(\s*atob\b/i, label: 'exfiltration: eval-base64' },
  { pattern: /\b(curl|wget|fetch)\b.*\b(api[_-]?key|token|secret|password)\b/i, label: 'exfiltration: credential-leak' },
  { pattern: /\breverse\s+shell\b/i, label: 'exfiltration: reverse-shell' },
  { pattern: /\bbase64\b.*\b(decode|--decode|-d)\b.*\|\s*(sh|bash)\b/i, label: 'exfiltration: base64-pipe-shell' },
]

/** Invisible / zero-width Unicode characters commonly used for hidden payloads. */
export const SANITIZER_INVISIBLE_UNICODE_PATTERN =
  /[\u200B\u200C\u200D\u200E\u200F\u2028\u2029\u2060\u2061\u2062\u2063\u2064\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E]/

/**
 * Global-flagged variant of {@link SANITIZER_INVISIBLE_UNICODE_PATTERN} for
 * `String.prototype.replace` when stripping (rather than detecting) hidden
 * characters. Kept as its own literal so callers never share a stateful
 * `lastIndex` across `test()` and `replace()` usages.
 */
export const SANITIZER_INVISIBLE_UNICODE_STRIP_PATTERN =
  /[\u200B\u200C\u200D\u200E\u200F\u2028\u2029\u2060\u2061\u2062\u2063\u2064\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E]/g
