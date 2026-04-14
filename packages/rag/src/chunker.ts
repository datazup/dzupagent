/**
 * SmartChunker — Boundary-aware text splitting for RAG embeddings.
 *
 * Ported from @datazup/text-chunking with enhancements:
 * - Configurable via ChunkingConfig
 * - Quality scoring built-in
 * - Returns ChunkResult with full metadata
 *
 * Uses a local token estimator (length / 4, ceiling) — avoids importing
 * the full @dzupagent/core module graph in this lightweight utility.
 */

import type { ChunkingConfig, ChunkResult, ChunkMetadata, QualityMetrics } from './types.js'

/** Conservative token estimate: 4 chars per token (ceiling). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ---------------------------------------------------------------------------
// Boundary Definitions (priority-ordered)
// ---------------------------------------------------------------------------

interface BoundaryDef {
  pattern: RegExp
  name: string
  type: ChunkMetadata['boundaryType']
}

const BOUNDARY_PRIORITIES: BoundaryDef[] = [
  { pattern: /\n#{1,6}\s/, name: 'markdown_header', type: 'header' },
  { pattern: /\n\n/, name: 'double_newline', type: 'paragraph' },
  { pattern: /\.\s+(?=[A-Z])/, name: 'sentence_capital', type: 'sentence' },
  { pattern: /\.\n/, name: 'sentence_newline', type: 'sentence' },
  { pattern: /[!?]\s/, name: 'excl_question', type: 'sentence' },
  { pattern: /\n[-*]\s/, name: 'list_item', type: 'paragraph' },
  { pattern: /\n\d+\.\s/, name: 'numbered_list', type: 'paragraph' },
  { pattern: /\n```/, name: 'code_fence', type: 'paragraph' },
]

// ---------------------------------------------------------------------------
// Boilerplate Patterns (for quality scoring)
// ---------------------------------------------------------------------------

const BOILERPLATE_PATTERNS: RegExp[] = [
  /cookie/i, /subscribe/i, /newsletter/i, /share\s+(this|on)/i,
  /follow\s+us/i, /copyright\s*©?/i, /all\s+rights\s+reserved/i,
  /terms\s+(?:of\s)?(?:service|use)/i, /privacy\s+policy/i,
  /sign\s+(up|in)/i, /log\s*(in|out)/i, /accept\s+cookies/i,
  /we\s+use\s+cookies/i, /navigation/i, /breadcrumb/i,
  /skip\s+to\s+(content|main)/i, /advertisement/i, /sponsored/i,
]

/** Minimum tokens for a standalone chunk; smaller ones get merged */
const MIN_CHUNK_TOKENS = 50

// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------

/** Default chunking configuration */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  targetTokens: 1200,
  overlapFraction: 0.15,
  respectBoundaries: true,
}

// ---------------------------------------------------------------------------
// SmartChunker
// ---------------------------------------------------------------------------

/**
 * Boundary-aware text chunker with configurable target size, overlap,
 * and built-in quality scoring.
 */
export class SmartChunker {
  private readonly config: ChunkingConfig

  constructor(config?: Partial<ChunkingConfig>) {
    this.config = { ...DEFAULT_CHUNKING_CONFIG, ...config }
  }

  /**
   * Split text into overlapping chunks with smart boundary detection.
   *
   * @param text - Text to split
   * @param sourceId - Source document identifier (attached to chunk metadata)
   * @returns Array of ChunkResult with content, quality, and metadata
   */
  chunkText(text: string, sourceId: string): ChunkResult[] {
    if (!text || text.trim().length === 0) return []

    const { targetTokens, overlapFraction, respectBoundaries } = this.config
    const targetChars = targetTokens * 4
    const overlapChars = Math.floor(targetChars * overlapFraction)
    const effectiveOverlap = Math.min(overlapChars, Math.floor(targetChars * 0.5))

    const rawChunks: Array<{ content: string; startOffset: number; endOffset: number; boundaryType: ChunkMetadata['boundaryType'] }> = []
    let start = 0

    while (start < text.length) {
      let end = start + targetChars
      let boundaryType: ChunkMetadata['boundaryType'] = 'token'

      if (end < text.length && respectBoundaries) {
        const minPos = start + Math.floor(targetChars * 0.5)
        const result = this.findBestBreakpoint(text, minPos, end)
        if (result.position > 0) {
          end = result.position
          boundaryType = result.boundaryType
        }
      } else if (end >= text.length) {
        end = text.length
      }

      const content = text.slice(start, end).trim()
      if (content.length > 0) {
        rawChunks.push({ content, startOffset: start, endOffset: end, boundaryType })
      }

      // Once we have consumed to the end of the text, stop —
      // do not slide the window backwards to create duplicate chunks.
      if (end >= text.length) break

      // Always advance forward; cap overlap so start never goes backwards.
      const nextStart = end - effectiveOverlap
      start = nextStart > start ? nextStart : start + 1
      if (start >= text.length) break
    }

    // Merge tiny trailing chunk into its predecessor.
    // A chunk is "tiny" if it is under 25% of the configured target size
    // (also bounded by the absolute MIN_CHUNK_TOKENS floor for large targets).
    const tinyThreshold = Math.min(MIN_CHUNK_TOKENS, Math.floor(targetTokens * 0.25))
    if (rawChunks.length > 1) {
      const lastChunk = rawChunks[rawChunks.length - 1]!
      if (estimateTokens(lastChunk.content) < tinyThreshold) {
        const prevChunk = rawChunks[rawChunks.length - 2]!
        prevChunk.content += '\n' + lastChunk.content
        prevChunk.endOffset = lastChunk.endOffset
        rawChunks.pop()
      }
    }

    // Build ChunkResult array with quality scoring
    const totalChunks = rawChunks.length
    return rawChunks.map((raw, index) => {
      const tokenCount = estimateTokens(raw.content)
      const quality = this.computeChunkQuality(raw.content, index, totalChunks)

      return {
        id: `${sourceId}:${index}`,
        text: raw.content,
        tokenCount,
        quality: quality.overallScore,
        metadata: {
          sourceId,
          chunkIndex: index,
          startOffset: raw.startOffset,
          endOffset: raw.endOffset,
          boundaryType: raw.boundaryType,
        },
      }
    })
  }

  /**
   * Compute quality metrics for a text chunk.
   *
   * 5-factor weighted scoring:
   * - Content density (25%): non-whitespace ratio
   * - Meaningful sentences (25%): sentences with 5+ words
   * - Token ratio (20%): actual vs target tokens
   * - Position (15%): last-chunk penalty
   * - Boilerplate (15%): cookie/legal/nav pattern detection
   */
  computeChunkQuality(
    content: string,
    chunkIndex: number,
    totalChunks: number,
  ): QualityMetrics {
    if (content.length === 0) {
      return {
        vocabularyDiversity: 0,
        avgSentenceLength: 0,
        textToNoiseRatio: 0,
        structureScore: 0,
        overallScore: 0,
      }
    }

    // --- Content density (text-to-noise ratio) ---
    const nonWhitespace = content.replace(/\s/g, '').length
    const densityRaw = nonWhitespace / content.length
    const textToNoiseRatio = Math.min(1, densityRaw < 0.5 ? densityRaw / 0.5 : 1)

    // --- Meaningful sentences ---
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().split(/\s+/).length >= 5)
    const avgSentenceLength = sentences.length > 0
      ? sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) / sentences.length
      : 0
    const meaningfulSentencesScore = sentences.length >= 2 ? 1 : (sentences.length === 1 ? 0.5 : 0.1)

    // --- Token ratio ---
    const tokens = estimateTokens(content)
    const targetTokens = this.config.targetTokens
    const tokenRatioRaw = tokens / Math.max(1, targetTokens)
    const tokenRatio = tokenRatioRaw < 0.3 ? tokenRatioRaw / 0.3 : Math.min(1, 1 / tokenRatioRaw)

    // --- Position penalty ---
    const positionScore = (chunkIndex === totalChunks - 1 && totalChunks > 1) ? 0.7 : 1.0

    // --- Boilerplate detection ---
    let boilerplateMatches = 0
    for (const pattern of BOILERPLATE_PATTERNS) {
      if (pattern.test(content)) boilerplateMatches++
    }
    const boilerplateRatio = boilerplateMatches / BOILERPLATE_PATTERNS.length
    const boilerplateScore = boilerplateRatio > 0.3 ? 0 : Math.max(0, 1 - boilerplateRatio * 3)

    // --- Vocabulary diversity ---
    const words = content.toLowerCase().split(/\s+/).filter(w => w.length > 0)
    const uniqueWords = new Set(words)
    const vocabularyDiversity = words.length > 0 ? uniqueWords.size / words.length : 0

    // --- Structure score ---
    const hasHeaders = /^#{1,6}\s/m.test(content)
    const hasLists = /^[-*]\s/m.test(content) || /^\d+\.\s/m.test(content)
    const hasCodeBlocks = /```/.test(content)
    const structureScore = (hasHeaders ? 0.4 : 0) + (hasLists ? 0.3 : 0) + (hasCodeBlocks ? 0.3 : 0)

    // --- Composite score ---
    const overallScore = Math.min(1, Math.max(0,
      textToNoiseRatio * 0.25 +
      meaningfulSentencesScore * 0.25 +
      tokenRatio * 0.20 +
      positionScore * 0.15 +
      boilerplateScore * 0.15,
    ))

    return {
      vocabularyDiversity,
      avgSentenceLength,
      textToNoiseRatio,
      structureScore,
      overallScore,
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Find the best breakpoint within a search window using priority-ordered
   * boundary patterns.
   */
  private findBestBreakpoint(
    text: string,
    minPos: number,
    end: number,
  ): { position: number; boundaryType: ChunkMetadata['boundaryType'] } {
    const searchWindow = text.slice(minPos, end)

    for (const boundary of BOUNDARY_PRIORITIES) {
      let lastMatchEnd = -1
      const regex = new RegExp(boundary.pattern.source, boundary.pattern.flags + 'g')
      let match: RegExpExecArray | null
      while ((match = regex.exec(searchWindow)) !== null) {
        lastMatchEnd = match.index + match[0].length
      }
      if (lastMatchEnd > 0) {
        return { position: minPos + lastMatchEnd, boundaryType: boundary.type }
      }
    }

    // Fallback: look for sentence boundaries
    const fallbackBreakpoints = ['. ', '.\n', '! ', '? ']
    let bestBreak = -1
    for (const bp of fallbackBreakpoints) {
      const pos = text.lastIndexOf(bp, end)
      if (pos > minPos) bestBreak = Math.max(bestBreak, pos + bp.length)
    }

    return {
      position: bestBreak,
      boundaryType: bestBreak > 0 ? 'sentence' : 'token',
    }
  }
}
