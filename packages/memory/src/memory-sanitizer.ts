/**
 * Security scanning for memory content.
 *
 * Detects prompt injection, exfiltration commands, and invisible Unicode
 * before content is stored. Inspired by Hermes Agent's memory security model.
 *
 * The pattern DATA is shared with core's `content-sanitizer` via
 * @dzupagent/security (a leaf both layers already depend on) so the two
 * sanitizers can never drift (audit finding DZUPAGENT-CODE-H-03). Only this
 * per-layer scan wrapper is local to memory.
 */

import {
  SANITIZER_INJECTION_PATTERNS as INJECTION_PATTERNS,
  SANITIZER_EXFILTRATION_PATTERNS as EXFILTRATION_PATTERNS,
  SANITIZER_INVISIBLE_UNICODE_PATTERN as INVISIBLE_UNICODE_PATTERN,
  SANITIZER_INVISIBLE_UNICODE_STRIP_PATTERN,
} from "@dzupagent/security";

export interface SanitizeResult {
  safe: boolean;
  /** Original content (returned as-is when safe) */
  content: string;
  /** List of threats detected (empty when safe) */
  threats: string[];
}

/**
 * Scans content for security threats before storing in memory.
 *
 * Returns a result object indicating whether the content is safe.
 * Does NOT throw — callers decide how to handle unsafe content.
 */
export function sanitizeMemoryContent(content: string): SanitizeResult {
  const threats: string[] = [];

  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      threats.push(label);
    }
  }

  for (const { pattern, label } of EXFILTRATION_PATTERNS) {
    if (pattern.test(content)) {
      threats.push(label);
    }
  }

  if (INVISIBLE_UNICODE_PATTERN.test(content)) {
    threats.push("invisible-unicode: hidden characters detected");
  }

  return {
    safe: threats.length === 0,
    content,
    threats,
  };
}

/**
 * Strips invisible Unicode characters from content.
 * Use this when you want to clean content rather than reject it.
 */
export function stripInvisibleUnicode(content: string): string {
  return content.replace(SANITIZER_INVISIBLE_UNICODE_STRIP_PATTERN, "");
}
