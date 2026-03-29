/**
 * Split text on sentence boundaries.
 * A sentence boundary is sentence-ending punctuation followed by whitespace.
 */
export function splitOnSentences(text: string, maxSize: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 <= maxSize) {
      current = current ? `${current} ${sentence}` : sentence
    } else {
      if (current) chunks.push(current)
      // If a single sentence exceeds maxSize, include it as-is
      current = sentence
    }
  }
  if (current) chunks.push(current)

  return chunks
}
