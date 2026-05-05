/**
 * Shared Server-Sent Events (SSE) parser utility.
 *
 * Consumes a `ReadableStream<Uint8Array>` (typically `Response.body` from a
 * streaming HTTP request) and yields deserialized chunks line by line.
 *
 * Behavior:
 *   - Accumulates partial chunks across `read()` calls (buffered line splitting)
 *   - Strips the `data: ` prefix from each event line
 *   - Stops cleanly when `[DONE]` terminator is encountered
 *   - Skips lines that fail JSON deserialization (does not throw)
 *   - Honors the supplied `AbortSignal` and stops the read loop on abort
 *   - Always releases the reader lock on completion or error
 *
 * The `deserialize` callback receives the raw event data (after `data: `
 * stripping). Returning `null`/`undefined` skips the line; returning a value
 * yields it.
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
