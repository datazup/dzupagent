/**
 * CitationTracker — Maps retrieved chunks to source metadata for
 * citation generation.
 *
 * Maintains a registry of source metadata and produces CitationResult[]
 * from a RetrievalResult, with helpers for inline [N] formatting and
 * reference list generation.
 *
 * Note: The SourceMeta used here (CitationSourceMeta) is distinct from
 * the assembler's SourceMeta which includes contextMode/summary fields.
 */

import type { RetrievalResult, CitationResult } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Source metadata for citation tracking.
 *
 * Named CitationSourceMeta to avoid collision with the assembler's
 * SourceMeta (which carries contextMode).
 */
export interface CitationSourceMeta {
  sourceId: string
  title: string
  url?: string
  domain?: string
  quality?: number
}

// ---------------------------------------------------------------------------
// CitationTracker
// ---------------------------------------------------------------------------

export class CitationTracker {
  private readonly sources = new Map<string, CitationSourceMeta>()

  /** Register a single source */
  registerSource(meta: CitationSourceMeta): void {
    this.sources.set(meta.sourceId, meta)
  }

  /** Register multiple sources at once */
  registerSources(metas: CitationSourceMeta[]): void {
    for (const meta of metas) {
      this.registerSource(meta)
    }
  }

  /** Look up a registered source by ID */
  getSource(sourceId: string): CitationSourceMeta | undefined {
    return this.sources.get(sourceId)
  }

  /**
   * Generate deduplicated citations from a retrieval result.
   *
   * Each unique (sourceId, chunkIndex) pair produces one citation.
   * The snippet is the first 200 characters of the chunk text.
   */
  generateCitations(results: RetrievalResult): CitationResult[] {
    const seen = new Set<string>()
    const citations: CitationResult[] = []

    for (const chunk of results.chunks) {
      const key = `${chunk.sourceId}:${chunk.chunkIndex}`
      if (seen.has(key)) continue
      seen.add(key)

      const source = this.sources.get(chunk.sourceId)
      citations.push({
        sourceId: chunk.sourceId,
        sourceTitle: source?.title ?? chunk.sourceTitle ?? 'Unknown',
        sourceUrl: source?.url ?? chunk.sourceUrl,
        chunkIndex: chunk.chunkIndex,
        score: chunk.score,
        snippet: chunk.text.slice(0, 200),
      })
    }

    return citations
  }

  /** Format a 1-based inline citation reference */
  formatInlineCitation(index: number): string {
    return `[${index + 1}]`
  }

  /**
   * Format a numbered reference list from citations.
   *
   * Example output:
   *   [1] Source Title (https://example.com)
   *   [2] Another Source
   */
  formatReferenceList(citations: CitationResult[]): string {
    return citations
      .map((c, i) => {
        const url = c.sourceUrl ? ` (${c.sourceUrl})` : ''
        return `[${i + 1}] ${c.sourceTitle}${url}`
      })
      .join('\n')
  }
}
