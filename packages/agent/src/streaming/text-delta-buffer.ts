/**
 * TextDeltaBuffer — accumulates partial text tokens from an LLM stream
 * and emits complete words or sentences.
 *
 * LLM token boundaries rarely align with word boundaries. This buffer
 * collects incoming deltas and splits on whitespace, yielding only
 * complete words. The remaining partial word stays buffered until more
 * tokens arrive or `flush()` is called.
 *
 * Usage:
 * ```typescript
 * const buffer = new TextDeltaBuffer();
 * for await (const chunk of llmStream) {
 *   const words = buffer.push(chunk.content);
 *   for (const word of words) sendToClient(word);
 * }
 * const remaining = buffer.flush();
 * if (remaining) sendToClient(remaining);
 * ```
 */
export class TextDeltaBuffer {
  private buffer = ''

  /**
   * Push a text delta into the buffer.
   *
   * Returns an array of complete chunks (whitespace-delimited words with
   * their trailing whitespace preserved) that are ready to emit. If no
   * complete word boundary is found, returns an empty array and the
   * content remains buffered.
   */
  push(delta: string): string[] {
    if (!delta) return []

    this.buffer += delta
    const chunks: string[] = []

    // Find the last whitespace boundary in the buffer.
    // Everything before it (inclusive) can be emitted; the rest stays buffered.
    const lastWs = this.findLastWhitespaceBoundary(this.buffer)
    if (lastWs === -1) {
      // No whitespace found yet — keep buffering
      return chunks
    }

    // Emit the portion up to and including the last whitespace
    const ready = this.buffer.slice(0, lastWs + 1)
    this.buffer = this.buffer.slice(lastWs + 1)

    // Split into individual word chunks (preserving whitespace)
    const words = ready.match(/\S+\s*/g)
    if (words) {
      chunks.push(...words)
    }

    return chunks
  }

  /**
   * Flush any remaining buffered content.
   * Returns the leftover text (possibly a partial word) and resets the buffer.
   */
  flush(): string {
    const remaining = this.buffer
    this.buffer = ''
    return remaining
  }

  /**
   * Reset the buffer, discarding any accumulated content.
   */
  reset(): void {
    this.buffer = ''
  }

  /**
   * Returns the current buffered content without modifying state.
   * Useful for debugging or inspection.
   */
  peek(): string {
    return this.buffer
  }

  /**
   * Find the index of the last whitespace character in the string.
   * Returns -1 if no whitespace is found.
   */
  private findLastWhitespaceBoundary(str: string): number {
    for (let i = str.length - 1; i >= 0; i--) {
      const ch = str[i]
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
        return i
      }
    }
    return -1
  }
}
