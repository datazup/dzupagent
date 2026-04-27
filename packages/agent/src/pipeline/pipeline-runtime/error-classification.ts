/**
 * Error classification helpers used by the pipeline runtime when deciding
 * whether to surface an error code to the edge resolver and what
 * `FailureType` to hand to the recovery copilot.
 *
 * Extracted as pure, side-effect-free helpers so the classification
 * invariants (regex shapes, precedence between bracketed/prefixed/exact
 * codes, and message-keyword routing into FailureType) can be tested in
 * isolation without standing up the whole runtime.
 *
 * Invariants preserved from the original in-class implementation:
 *   - `extractErrorCode` first checks for an `error.code` string field,
 *     then falls back to message parsing for `Error` instances and
 *     non-string non-null values.
 *   - Message parsing prefers, in order:
 *       1. `[CODE] ...`  (bracketed prefix)
 *       2. `CODE: ...`   (colon-suffixed prefix)
 *       3. `CODE`        (exact match — entire message is the code)
 *     The code shape is `^[A-Z][A-Z0-9_]{2,}$` (uppercase, ≥3 chars).
 *   - `classifyFailureType` keyword routing order matters: timeout >
 *     resource_exhaustion > build_failure > test_failure > default
 *     `generation_failure`. Matching is case-insensitive on the full
 *     message.
 *
 * @module pipeline/pipeline-runtime/error-classification
 */

import type { FailureType } from '../../recovery/recovery-types.js'

/**
 * Try to extract a structured error code from `error`.
 *
 * Returns `undefined` when no recognisable code is present. The returned
 * string is suitable for matching against `errorEdges`.
 */
export function extractErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) {
      return code
    }
  }

  if (typeof error !== 'string') {
    if (error instanceof Error) {
      return extractErrorCodeFromMessage(error.message)
    }
    if (error !== undefined && error !== null) {
      return extractErrorCodeFromMessage(String(error))
    }
    return undefined
  }

  return extractErrorCodeFromMessage(error)
}

/**
 * Parse a textual error message looking for a leading uppercase code.
 *
 * Recognised shapes (in priority order):
 *   - `[CODE] rest of message`
 *   - `CODE: rest of message`
 *   - `CODE`  (whole message)
 *
 * The code itself must match `^[A-Z][A-Z0-9_]{2,}$`.
 */
export function extractErrorCodeFromMessage(message: string): string | undefined {
  const bracketedCode = message.match(/^\[([A-Z][A-Z0-9_]{2,})\]\s*/)
  if (bracketedCode?.[1]) return bracketedCode[1]

  const prefixedCode = message.match(/^([A-Z][A-Z0-9_]{2,})\s*:/)
  if (prefixedCode?.[1]) return prefixedCode[1]

  const exactCode = message.match(/^([A-Z][A-Z0-9_]{2,})$/)
  if (exactCode?.[1]) return exactCode[1]

  return undefined
}

/**
 * Heuristically classify an error message into a `FailureType` for the
 * recovery copilot. Keyword precedence is: timeout > resource_exhaustion
 * > build_failure > test_failure > generation_failure (default).
 *
 * The `_nodeType` argument is accepted for symmetry with the previous
 * in-class signature; it currently has no effect on classification but
 * is kept so callers can pass it without rewriting.
 */
export function classifyFailureType(error: string, _nodeType?: string): FailureType {
  const lower = error.toLowerCase()
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('deadline')) {
    return 'timeout'
  }
  if (
    lower.includes('memory') ||
    lower.includes('oom') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('resource')
  ) {
    return 'resource_exhaustion'
  }
  if (lower.includes('build') || lower.includes('compile') || lower.includes('syntax')) {
    return 'build_failure'
  }
  if (lower.includes('test') || lower.includes('assertion') || lower.includes('expect')) {
    return 'test_failure'
  }
  return 'generation_failure'
}
