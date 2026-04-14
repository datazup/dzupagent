/**
 * ContextAssembler — Build LLM-ready context from retrieved chunks.
 *
 * Ported from research-app's rag-retrieval.ts context assembly logic.
 *
 * Supports:
 * - Per-source context modes (off, insights, full)
 * - Token budget enforcement
 * - Citation tracking with source references
 * - Grounded and extended prompt generation
 */

import type {
  AssembledContext,
  AssemblyOptions,
  CitationResult,
  ContextMode,
  RetrievalResult,
  SourceContextBreakdown,
  SourceMeta,
} from './types.js'

// ---------------------------------------------------------------------------
// Default Options
// ---------------------------------------------------------------------------

/** Conservative token estimate: 4 chars per token (ceiling). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const DEFAULT_SNIPPET_LENGTH = 400

const DEFAULT_ASSEMBLY_OPTIONS: AssemblyOptions = {
  tokenBudget: 8000,
  snippetLength: DEFAULT_SNIPPET_LENGTH,
}

// ---------------------------------------------------------------------------
// ContextAssembler
// ---------------------------------------------------------------------------

/**
 * Assembles retrieved chunks into a structured context suitable for
 * LLM system prompts.
 *
 * The assembler groups chunks by source, applies per-source context modes,
 * enforces a token budget, and generates citation references.
 */
export class ContextAssembler {

  /**
   * Assemble context from a retrieval result and per-source metadata.
   *
   * Sources with mode 'off' are excluded entirely. Sources with mode
   * 'insights' use their summary instead of RAG chunks. Sources with
   * mode 'full' include the actual retrieved chunks.
   *
   * @param retrievalResult - Result from HybridRetriever.retrieve()
   * @param sourceMetadata - Map of sourceId to SourceMeta
   * @param options - Assembly options including token budget
   */
  assembleContext(
    retrievalResult: RetrievalResult,
    sourceMetadata: Map<string, SourceMeta>,
    options?: Partial<AssemblyOptions>,
  ): AssembledContext {
    const opts: AssemblyOptions = { ...DEFAULT_ASSEMBLY_OPTIONS, ...options }
    const snippetLength = opts.snippetLength ?? DEFAULT_SNIPPET_LENGTH

    // Collect all context pieces: insights summaries + full chunks
    const contextPieces: Array<{
      sourceId: string
      sourceTitle: string
      sourceUrl?: string
      mode: ContextMode
      text: string
      score: number
      chunkIndex: number
      tokenCount: number
    }> = []

    // Add insight summaries
    for (const [sourceId, meta] of sourceMetadata) {
      if (meta.contextMode === 'insights' && meta.summary && meta.summary.length >= 20) {
        const tokens = estimateTokens(meta.summary)
        contextPieces.push({
          sourceId,
          sourceTitle: meta.title,
          ...(meta.url !== undefined ? { sourceUrl: meta.url } : {}),
          mode: 'insights',
          text: meta.summary,
          score: 0.5, // Insight summaries get a baseline score
          chunkIndex: 0,
          tokenCount: tokens,
        })
      }
    }

    // Add full RAG chunks (only from sources with mode 'full')
    for (const chunk of retrievalResult.chunks) {
      const meta = sourceMetadata.get(chunk.sourceId)
      const mode = meta?.contextMode ?? 'full'

      if (mode === 'off') continue
      if (mode === 'insights') continue // Already handled above

      const resolvedUrl = chunk.sourceUrl ?? meta?.url
      contextPieces.push({
        sourceId: chunk.sourceId,
        sourceTitle: chunk.sourceTitle ?? meta?.title ?? 'Unknown',
        ...(resolvedUrl !== undefined ? { sourceUrl: resolvedUrl } : {}),
        mode: 'full',
        text: chunk.text,
        score: chunk.score,
        chunkIndex: chunk.chunkIndex,
        tokenCount: estimateTokens(chunk.text),
      })
    }

    // Sort: insights first, then full by score descending
    contextPieces.sort((a, b) => {
      if (a.mode === 'insights' && b.mode !== 'insights') return -1
      if (a.mode !== 'insights' && b.mode === 'insights') return 1
      return b.score - a.score
    })

    // Apply token budget (drop lowest-scored 'full' chunks first)
    const budgetedPieces = this.applyTokenBudget(contextPieces, opts.tokenBudget)

    // Build citations
    const citations: CitationResult[] = budgetedPieces.map((piece) => ({
      sourceId: piece.sourceId,
      sourceTitle: piece.sourceTitle,
      ...(piece.sourceUrl !== undefined ? { sourceUrl: piece.sourceUrl } : {}),
      chunkIndex: piece.chunkIndex,
      score: piece.score,
      snippet: piece.text.slice(0, snippetLength),
    }))

    // Build per-source breakdown
    const breakdownMap = new Map<string, SourceContextBreakdown>()

    for (const piece of budgetedPieces) {
      const existing = breakdownMap.get(piece.sourceId)
      if (existing) {
        existing.tokenCount += piece.tokenCount
        existing.chunkCount += 1
      } else {
        breakdownMap.set(piece.sourceId, {
          sourceId: piece.sourceId,
          sourceTitle: piece.sourceTitle,
          mode: piece.mode,
          tokenCount: piece.tokenCount,
          chunkCount: 1,
        })
      }
    }

    // Include 'off' sources in breakdown with zero counts
    for (const [sourceId, meta] of sourceMetadata) {
      if (meta.contextMode === 'off' && !breakdownMap.has(sourceId)) {
        breakdownMap.set(sourceId, {
          sourceId,
          sourceTitle: meta.title,
          mode: 'off',
          tokenCount: 0,
          chunkCount: 0,
        })
      }
    }

    // Build context text
    const contextText = budgetedPieces
      .map((piece, i) =>
        `[${i + 1}] "${piece.sourceTitle}" — ${piece.text}`,
      )
      .join('\n\n')

    const totalTokens = budgetedPieces.reduce((sum, p) => sum + p.tokenCount, 0)

    // Build system prompt (grounded by default)
    const systemPrompt = this.buildGroundedPrompt({
      systemPrompt: '',
      contextText,
      citations,
      totalTokens,
      sourceBreakdown: Array.from(breakdownMap.values()),
    }, opts.groundedTemplate)

    return {
      systemPrompt,
      contextText,
      citations,
      totalTokens,
      sourceBreakdown: Array.from(breakdownMap.values()),
    }
  }

  /**
   * Build a grounded system prompt.
   *
   * In grounded mode the LLM should ONLY use information from the provided
   * sources and cite each claim with [N] notation.
   */
  buildGroundedPrompt(context: AssembledContext, template?: string): string {
    if (context.citations.length === 0) {
      return 'You are a research assistant. No sources are currently indexed in this session. Ask the user to add sources first before asking questions.'
    }

    const sourceLines = context.contextText

    if (template) {
      return template.replace(/\{\{source_context\}\}/g, sourceLines)
    }

    return `You are a research assistant with access to the following source excerpts.
Answer the user's question using ONLY information from these sources.
For every factual claim, cite the source number using [N] notation inline in your response.
If the answer cannot be found in the provided sources, say explicitly: "This information is not available in the current sources."
Do not invent or infer information not present in the excerpts.

SOURCES:
${sourceLines}`
  }

  /**
   * Build an extended system prompt.
   *
   * In extended mode the LLM may use both the provided sources (cited with
   * [N]) and its general knowledge (prefixed with [AI Knowledge]).
   */
  buildExtendedPrompt(context: AssembledContext, template?: string): string {
    const sourcesSection = context.citations.length > 0
      ? `PROVIDED SOURCES:\n${context.contextText}`
      : 'PROVIDED SOURCES: None indexed yet.'

    if (template) {
      return template.replace(/\{\{source_context\}\}/g, sourcesSection)
    }

    return `You are a research assistant. You have access to specific source excerpts AND your general knowledge.
When using information from the provided sources below, cite with [N] notation.
When using your general knowledge (not from the provided sources), clearly prefix with [AI Knowledge].
Always be explicit about the origin of each piece of information.

${sourcesSection}`
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Enforce token budget by dropping the lowest-scored 'full' chunks from
   * the end first, preserving 'insights' summaries.
   */
  private applyTokenBudget<T extends { tokenCount: number; mode: ContextMode }>(
    pieces: T[],
    budget: number,
  ): T[] {
    let totalTokens = pieces.reduce((sum, p) => sum + p.tokenCount, 0)

    if (totalTokens <= budget) return pieces

    // Drop 'full' chunks from the end (lowest-scored due to prior sort)
    const result = [...pieces]
    for (let i = result.length - 1; i >= 0 && totalTokens > budget; i--) {
      const piece = result[i]
      if (!piece) continue
      if (piece.mode === 'insights') continue
      totalTokens -= piece.tokenCount
      result.splice(i, 1)
    }

    return result
  }
}
