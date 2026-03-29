import { splitOnHeadings } from './heading-chunker.js'
import { splitOnParagraphs } from './paragraph-chunker.js'
import { splitOnSentences } from './sentence-chunker.js'
import { addOverlap } from './overlap.js'

const DEFAULT_CHUNK_SIZE = 4000
const DEFAULT_OVERLAP_SIZE = 200

/**
 * Split text into chunks suitable for LLM processing.
 *
 * Strategy:
 * 1. Split on heading boundaries (## and ###) to preserve sections
 * 2. If a section exceeds maxChunkSize, split on paragraph boundaries (\n\n)
 * 3. If still too large, split on sentence boundaries
 * 4. Add overlap between chunks for context continuity
 *
 * @param text - The full document text
 * @param maxChunkSize - Maximum characters per chunk (default: 4000)
 * @param overlapSize - Characters of overlap between chunks (default: 200)
 * @returns Array of text chunks
 */
export function splitIntoChunks(
  text: string,
  maxChunkSize: number = DEFAULT_CHUNK_SIZE,
  overlapSize: number = DEFAULT_OVERLAP_SIZE,
): string[] {
  if (!text || text.trim().length === 0) {
    return []
  }

  // If the entire text fits in one chunk, return it
  if (text.length <= maxChunkSize) {
    return [text.trim()]
  }

  // Step 1: Split on heading boundaries
  const sections = splitOnHeadings(text)

  // Step 2: Process each section
  const chunks: string[] = []

  for (const section of sections) {
    if (section.length <= maxChunkSize) {
      chunks.push(section.trim())
    } else {
      // Section too large: split on paragraphs
      const paragraphChunks = splitOnParagraphs(section, maxChunkSize)
      for (const pChunk of paragraphChunks) {
        if (pChunk.length <= maxChunkSize) {
          chunks.push(pChunk.trim())
        } else {
          // Still too large: split on sentences
          const sentenceChunks = splitOnSentences(pChunk, maxChunkSize)
          chunks.push(...sentenceChunks.map((s) => s.trim()))
        }
      }
    }
  }

  // Step 3: Add overlap between chunks
  if (overlapSize > 0 && chunks.length > 1) {
    return addOverlap(chunks, overlapSize)
  }

  return chunks.filter((c) => c.length > 0)
}
