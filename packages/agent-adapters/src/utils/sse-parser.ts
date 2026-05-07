/**
 * Shared Server-Sent Events (SSE) parser utilities.
 *
 * Two abstraction layers are exposed:
 *
 *   1. Pure helpers — {@link parseSseLine} and {@link parseSseChunk}.
 *      Operate on already-decoded text. Decoupled from any I/O so they can be
 *      unit-tested without spinning up streams. Each adapter (OpenAI,
 *      OpenRouter, ...) keeps its provider-specific schema processing in the
 *      adapter itself; the helpers only handle the OpenAI-style SSE framing
 *      common to all of them: `data: <json>\n` lines, the `[DONE]` terminator,
 *      and malformed-JSON tolerance.
 *
 *   2. Stream consumer — {@link parseSSEStream}. A `ReadableStream<Uint8Array>`
 *      driver that buffers partial reads, splits into lines, applies a
 *      caller-supplied deserialize function, and honours an `AbortSignal`.
 *      Adapters use this to drive their typed SSE generators.
 *
 * Behavior summary for both layers:
 *   - `data: ` prefix is stripped from each line
 *   - `[DONE]` terminator stops the stream / signals end
 *   - Malformed JSON lines are skipped silently (never throw)
 *   - Empty / non-`data:` lines are ignored
 */

/** Result of parsing a single SSE line. `null` means "skip this line". */
export type ParsedSseLine =
  | { done: true }
  | { done: false; json: unknown }
  | null

/**
 * Parse a single SSE line.
 *
 * Returns:
 *   - `{ done: true }` when the line is the `[DONE]` terminator
 *   - `{ done: false, json }` when the line is a valid `data: <json>` event
 *   - `null` for empty lines, non-`data:` lines, or malformed JSON
 *
 * The line may be supplied with or without trailing whitespace; trimming is
 * performed internally.
 */
export function parseSseLine(line: string): ParsedSseLine {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('data: ')) return null
  const data = trimmed.slice(6)
  if (data === '[DONE]') return { done: true }
  try {
    const json = JSON.parse(data) as unknown
    return { done: false, json }
  } catch {
    return null
  }
}

/**
 * Parse a multi-line SSE chunk (e.g. one or more `data: ...` lines joined by
 * `\n`). Lines that produce `null` from {@link parseSseLine} are skipped. If a
 * `[DONE]` terminator appears mid-chunk, parsing stops and the terminator is
 * the final entry in the result array — any subsequent lines are dropped.
 *
 * Note: this helper assumes the input is a complete chunk (no partial line
 * suffix). For streaming `ReadableStream<Uint8Array>` input use
 * {@link parseSSEStream}, which handles read-boundary buffering.
 */
export function parseSseChunk(
  chunk: string,
): Array<{ done: true } | { done: false; json: unknown }> {
  const out: Array<{ done: true } | { done: false; json: unknown }> = []
  for (const line of chunk.split('\n')) {
    const parsed = parseSseLine(line)
    if (parsed === null) continue
    out.push(parsed)
    if (parsed.done) break
  }
  return out
}

/**
 * Streaming consumer that reads `Response.body`-style SSE bytes, buffers
 * across read boundaries, and yields deserialized chunks line-by-line.
 *
 * The `deserialize` callback receives the raw event data (after the `data: `
 * prefix is stripped). Returning `null`/`undefined` skips the line; returning
 * a value yields it. The stream stops cleanly on `[DONE]` and respects
 * `signal.aborted`. The reader lock is always released.
 */
export async function* parseSSEStream<T>(
  body: ReadableStream<Uint8Array>,
  deserialize: (line: string) => T | null | undefined,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') return
        const parsed = deserialize(data)
        if (parsed !== null && parsed !== undefined) {
          yield parsed
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
