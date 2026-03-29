/**
 * Split text on paragraph boundaries (\n\n).
 * Merges consecutive paragraphs that fit within maxSize.
 */
export function splitOnParagraphs(text: string, maxSize: number): string[] {
  const paragraphs = text.split(/\n\n+/)
  const chunks: string[] = []
  let current = ''

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= maxSize) {
      current = current ? `${current}\n\n${para}` : para
    } else {
      if (current) chunks.push(current)
      current = para
    }
  }
  if (current) chunks.push(current)

  return chunks
}
