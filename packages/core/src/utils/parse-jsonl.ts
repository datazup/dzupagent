/**
 * Shared JSONL parser for run-log readers (and any other line-delimited JSON
 * consumer).
 *
 * Run-event stores across DzupAgent (`raw-events.jsonl`,
 * `normalized-events.jsonl`, `artifacts.jsonl`, `managed-events.jsonl`,
 * `artifact-index.jsonl`, evaluation datasets) write one JSON value per line.
 * Readers historically duplicated the same `split('\n') -> trim -> JSON.parse`
 * pattern with subtly different error handling. This helper centralizes that
 * pattern with the conventions every call site agreed on independently:
 *
 * - empty lines (and trailing blank lines from `appendFile(line + '\n')`) are
 *   skipped silently;
 * - malformed JSON is skipped (NOT thrown) — partial writes during a crash
 *   would otherwise poison the entire log replay;
 * - an optional `validate` type guard rejects records whose JSON parses but
 *   does not match the expected shape;
 * - skipped records are surfaced via an optional `onSkip` callback so that
 *   callers who want to log/observe corruption can do so without parsing the
 *   file twice.
 *
 * This helper is intentionally synchronous and string-in / array-out. Stream
 * processing of multi-megabyte logs should use a dedicated line-streaming
 * abstraction rather than buffering the whole file. The store readers in the
 * codebase all `readFile(..., 'utf8')` first, so a synchronous helper matches
 * existing call sites without forcing a refactor.
 *
 * @example
 *   const events = parseJsonl<AgentEvent>(raw)
 *
 * @example
 *   // With shape validation:
 *   const events = parseJsonl(raw, {
 *     validate: (x): x is AgentEvent =>
 *       typeof x === 'object' && x !== null && 'type' in x,
 *     onSkip: (reason, line) => logger.warn('skipped jsonl record', { reason, line }),
 *   })
 */

/** Reason a JSONL line was rejected during parsing. */
export type ParseJsonlSkipReason = 'malformed-json' | 'failed-validation'

/** Optional parsing controls for {@link parseJsonl}. */
export interface ParseJsonlOptions<T> {
  /**
   * Type-guard run against every parsed record. When it returns `false`, the
   * record is skipped and `onSkip` is invoked with reason
   * `'failed-validation'`.
   */
  readonly validate?: (value: unknown) => value is T
  /**
   * Invoked once per skipped line. Useful for surfacing corruption metrics
   * without re-parsing the file. Errors thrown from `onSkip` propagate.
   */
  readonly onSkip?: (reason: ParseJsonlSkipReason, line: string, error?: unknown) => void
}

/**
 * Parse a JSONL string (one JSON value per line) into an array.
 *
 * Empty lines are skipped. Malformed lines and records that fail the optional
 * `validate` guard are also skipped (NOT thrown) so a partial write at the
 * tail of a crash-truncated log cannot poison replay. Use `options.onSkip` to
 * observe drops.
 */
export function parseJsonl<T = unknown>(
  raw: string,
  options?: ParseJsonlOptions<T>,
): T[] {
  if (raw.length === 0) return []

  const out: T[] = []
  const lines = raw.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      options?.onSkip?.('malformed-json', line, err)
      continue
    }

    if (options?.validate && !options.validate(parsed)) {
      options.onSkip?.('failed-validation', line)
      continue
    }

    out.push(parsed as T)
  }

  return out
}
