/**
 * Add overlap between adjacent chunks for context continuity.
 * Takes the last `overlapSize` characters from the previous chunk
 * and prepends them to the current chunk with a separator.
 */
export function addOverlap(chunks: string[], overlapSize: number): string[] {
  const first = chunks[0]
  if (!first) return []

  const result: string[] = [first]

  for (let i = 1; i < chunks.length; i++) {
    const prevChunk = chunks[i - 1] ?? ''
    const currentChunk = chunks[i] ?? ''
    const overlap = prevChunk.slice(-overlapSize)
    result.push(`${overlap}\n---\n${currentChunk}`)
  }

  return result
}
