/**
 * Content security scanner used by core subsystems (e.g. skill-manager,
 * plugin loaders). Detects prompt injection, exfiltration commands, and
 * invisible Unicode before content is persisted.
 *
 * This scanner is intentionally kept in core so Layer 1 does not depend on
 * @dzupagent/memory (which re-exports an equivalent `sanitizeMemoryContent`
 * for its own callers). See MC-A01 for rationale.
 *
 * The pattern DATA, however, is shared: it lives in @dzupagent/security (a
 * leaf that BOTH core and memory already depend on) so the two sanitizers can
 * never drift (audit finding DZUPAGENT-CODE-H-03). Importing the tables from
 * @dzupagent/security does NOT create a Layer-1 -> memory dependency and does
 * NOT violate MC-A01 — only the per-layer scan wrapper stays local.
 */

import {
  SANITIZER_INJECTION_PATTERNS as INJECTION_PATTERNS,
  SANITIZER_EXFILTRATION_PATTERNS as EXFILTRATION_PATTERNS,
  SANITIZER_INVISIBLE_UNICODE_PATTERN as INVISIBLE_UNICODE_PATTERN,
  SANITIZER_INVISIBLE_UNICODE_STRIP_PATTERN,
} from "@dzupagent/security";

export interface ContentScanResult {
  safe: boolean;
  /** Original content returned as-is when safe. */
  content: string;
  /** Labels for every detected threat (empty when safe). */
  threats: string[];
}

/**
 * Scans content for security threats before it is persisted or executed.
 *
 * Returns a result object instead of throwing so callers can decide how
 * to handle unsafe content (reject, sanitize, log, etc.).
 */
export function scanContent(content: string): ContentScanResult {
  const threats: string[] = [];

  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(content)) threats.push(label);
  }

  for (const { pattern, label } of EXFILTRATION_PATTERNS) {
    if (pattern.test(content)) threats.push(label);
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

/** Strips invisible Unicode characters from a string. */
export function stripInvisibleUnicode(content: string): string {
  return content.replace(SANITIZER_INVISIBLE_UNICODE_STRIP_PATTERN, "");
}
