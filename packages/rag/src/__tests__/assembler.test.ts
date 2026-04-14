import { describe, it, expect } from 'vitest'
import { ContextAssembler } from '../assembler.js'
import type {
  RetrievalResult,
  ScoredChunk,
  SourceMeta,
  AssembledContext,
} from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<ScoredChunk> & { id: string }): ScoredChunk {
  return {
    text: `Content of ${overrides.id}`,
    score: 0.8,
    sourceId: 'src-1',
    chunkIndex: 0,
    ...overrides,
  }
}

function makeRetrievalResult(chunks: ScoredChunk[]): RetrievalResult {
  return {
    chunks,
    totalTokens: chunks.reduce((sum, c) => sum + Math.ceil(c.text.length / 4), 0),
    searchMode: 'hybrid',
    queryTimeMs: 10,
  }
}

function makeSourceMeta(
  sourceId: string,
  overrides?: Partial<SourceMeta>,
): [string, SourceMeta] {
  return [sourceId, {
    sourceId,
    title: `Title for ${sourceId}`,
    contextMode: 'full',
    ...overrides,
  }]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContextAssembler', () => {
  const assembler = new ContextAssembler()

  // -------------------------------------------------------------------------
  // Basic assembly
  // -------------------------------------------------------------------------

  describe('assembleContext', () => {
    it('assembles context from retrieval results', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', score: 0.9 }),
        makeChunk({ id: 'c2', sourceId: 'src-2', score: 0.7 }),
      ]
      const result = makeRetrievalResult(chunks)
      const sourceMeta = new Map([
        makeSourceMeta('src-1'),
        makeSourceMeta('src-2'),
      ])

      const assembled = assembler.assembleContext(result, sourceMeta)
      expect(assembled.citations).toHaveLength(2)
      expect(assembled.contextText).toContain('Content of c1')
      expect(assembled.contextText).toContain('Content of c2')
      expect(assembled.totalTokens).toBeGreaterThan(0)
      expect(assembled.sourceBreakdown).toHaveLength(2)
    })

    it('returns no-sources prompt when there are no chunks', () => {
      const result = makeRetrievalResult([])
      const sourceMeta = new Map<string, SourceMeta>()

      const assembled = assembler.assembleContext(result, sourceMeta)
      expect(assembled.systemPrompt).toContain('No sources')
      expect(assembled.citations).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Context modes
  // -------------------------------------------------------------------------

  describe('context modes', () => {
    it('excludes sources with mode "off"', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-off', score: 0.9 }),
        makeChunk({ id: 'c2', sourceId: 'src-full', score: 0.7 }),
      ]
      const result = makeRetrievalResult(chunks)
      const sourceMeta = new Map([
        makeSourceMeta('src-off', { contextMode: 'off' }),
        makeSourceMeta('src-full', { contextMode: 'full' }),
      ])

      const assembled = assembler.assembleContext(result, sourceMeta)
      // Only the 'full' source should appear in citations
      expect(assembled.citations).toHaveLength(1)
      expect(assembled.citations[0]!.sourceId).toBe('src-full')
      // 'off' source still appears in breakdown with zero counts
      const offBreakdown = assembled.sourceBreakdown.find(b => b.sourceId === 'src-off')
      expect(offBreakdown).toBeDefined()
      expect(offBreakdown!.mode).toBe('off')
      expect(offBreakdown!.chunkCount).toBe(0)
    })

    it('uses summary for sources with mode "insights"', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-insights', score: 0.9 }),
      ]
      const result = makeRetrievalResult(chunks)
      const summary = 'This is a detailed summary of the document that is long enough.'
      const sourceMeta = new Map([
        makeSourceMeta('src-insights', {
          contextMode: 'insights',
          summary,
        }),
      ])

      const assembled = assembler.assembleContext(result, sourceMeta)
      // Should include the summary, not the chunk text
      expect(assembled.contextText).toContain(summary)
      expect(assembled.contextText).not.toContain('Content of c1')
    })

    it('ignores insights with summary shorter than 20 chars', () => {
      const chunks: ScoredChunk[] = []
      const result = makeRetrievalResult(chunks)
      const sourceMeta = new Map([
        makeSourceMeta('src-insights', {
          contextMode: 'insights',
          summary: 'Too short.',
        }),
      ])

      const assembled = assembler.assembleContext(result, sourceMeta)
      expect(assembled.citations).toHaveLength(0)
    })

    it('sorts insights before full chunks', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-full', score: 0.95 }),
      ]
      const result = makeRetrievalResult(chunks)
      const summary = 'A sufficiently long summary for insights mode usage.'
      const sourceMeta = new Map([
        makeSourceMeta('src-full', { contextMode: 'full' }),
        makeSourceMeta('src-insights', { contextMode: 'insights', summary }),
      ])

      const assembled = assembler.assembleContext(result, sourceMeta)
      // Insights should come first in context text
      expect(assembled.contextText.indexOf(summary))
        .toBeLessThan(assembled.contextText.indexOf('Content of c1'))
    })
  })

  // -------------------------------------------------------------------------
  // Token budget
  // -------------------------------------------------------------------------

  describe('token budget', () => {
    it('drops low-scored full chunks when over budget', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', score: 0.9, text: 'A'.repeat(100) }),
        makeChunk({ id: 'c2', sourceId: 'src-1', score: 0.5, text: 'B'.repeat(100) }),
      ]
      const result = makeRetrievalResult(chunks)
      const sourceMeta = new Map([makeSourceMeta('src-1')])

      // Budget only allows ~1 chunk worth of tokens (100 chars = 25 tokens)
      const assembled = assembler.assembleContext(result, sourceMeta, { tokenBudget: 30 })
      expect(assembled.citations).toHaveLength(1)
      expect(assembled.citations[0]!.score).toBe(0.9) // Kept the higher-scored one
    })

    it('preserves insights summaries when trimming for budget', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-full', score: 0.9, text: 'A'.repeat(100) }),
      ]
      const result = makeRetrievalResult(chunks)
      const summary = 'This is a long enough summary for the insights source.'
      const sourceMeta = new Map([
        makeSourceMeta('src-full', { contextMode: 'full' }),
        makeSourceMeta('src-insights', { contextMode: 'insights', summary }),
      ])

      // Very small budget: only room for the insights summary
      const assembled = assembler.assembleContext(result, sourceMeta, { tokenBudget: 20 })
      const insightsCitation = assembled.citations.find(c => c.sourceId === 'src-insights')
      expect(insightsCitation).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // Citations
  // -------------------------------------------------------------------------

  describe('citations', () => {
    it('generates citations with snippet from chunk text', () => {
      const longText = 'Z'.repeat(500)
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', text: longText }),
      ]
      const result = makeRetrievalResult(chunks)
      const sourceMeta = new Map([makeSourceMeta('src-1')])

      const assembled = assembler.assembleContext(result, sourceMeta, { snippetLength: 100 })
      expect(assembled.citations[0]!.snippet).toHaveLength(100)
    })

    it('uses source title from metadata for citations', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', sourceTitle: undefined }),
      ]
      const result = makeRetrievalResult(chunks)
      const sourceMeta = new Map([
        makeSourceMeta('src-1', { title: 'Custom Title' }),
      ])

      const assembled = assembler.assembleContext(result, sourceMeta)
      expect(assembled.citations[0]!.sourceTitle).toBe('Custom Title')
    })

    it('formats context text with numbered source references', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', score: 0.9 }),
      ]
      const result = makeRetrievalResult(chunks)
      const sourceMeta = new Map([makeSourceMeta('src-1', { title: 'My Source' })])

      const assembled = assembler.assembleContext(result, sourceMeta)
      expect(assembled.contextText).toMatch(/^\[1\] "My Source"/)
    })
  })

  // -------------------------------------------------------------------------
  // Grounded prompt
  // -------------------------------------------------------------------------

  describe('buildGroundedPrompt', () => {
    it('returns no-sources message when no citations', () => {
      const context: AssembledContext = {
        systemPrompt: '',
        contextText: '',
        citations: [],
        totalTokens: 0,
        sourceBreakdown: [],
      }
      const prompt = assembler.buildGroundedPrompt(context)
      expect(prompt).toContain('No sources')
    })

    it('includes SOURCES section with context text', () => {
      const context: AssembledContext = {
        systemPrompt: '',
        contextText: '[1] "Doc" — Some content',
        citations: [{ sourceId: 's1', sourceTitle: 'Doc', chunkIndex: 0, score: 0.9, snippet: 'x' }],
        totalTokens: 10,
        sourceBreakdown: [],
      }
      const prompt = assembler.buildGroundedPrompt(context)
      expect(prompt).toContain('SOURCES:')
      expect(prompt).toContain('[1] "Doc" — Some content')
      expect(prompt).toContain('[N] notation')
    })

    it('applies custom template with {{source_context}} placeholder', () => {
      const context: AssembledContext = {
        systemPrompt: '',
        contextText: 'my-context',
        citations: [{ sourceId: 's1', sourceTitle: 'Doc', chunkIndex: 0, score: 0.9, snippet: 'x' }],
        totalTokens: 10,
        sourceBreakdown: [],
      }
      const template = 'PREFIX: {{source_context}} :SUFFIX'
      const prompt = assembler.buildGroundedPrompt(context, template)
      expect(prompt).toBe('PREFIX: my-context :SUFFIX')
    })
  })

  // -------------------------------------------------------------------------
  // Extended prompt
  // -------------------------------------------------------------------------

  describe('buildExtendedPrompt', () => {
    it('includes AI Knowledge instruction', () => {
      const context: AssembledContext = {
        systemPrompt: '',
        contextText: '[1] "Doc" — Content',
        citations: [{ sourceId: 's1', sourceTitle: 'Doc', chunkIndex: 0, score: 0.9, snippet: 'x' }],
        totalTokens: 10,
        sourceBreakdown: [],
      }
      const prompt = assembler.buildExtendedPrompt(context)
      expect(prompt).toContain('[AI Knowledge]')
      expect(prompt).toContain('PROVIDED SOURCES:')
    })

    it('says none indexed when no citations', () => {
      const context: AssembledContext = {
        systemPrompt: '',
        contextText: '',
        citations: [],
        totalTokens: 0,
        sourceBreakdown: [],
      }
      const prompt = assembler.buildExtendedPrompt(context)
      expect(prompt).toContain('None indexed')
    })

    it('applies custom template', () => {
      const context: AssembledContext = {
        systemPrompt: '',
        contextText: 'ctx',
        citations: [{ sourceId: 's1', sourceTitle: 'D', chunkIndex: 0, score: 0.9, snippet: 'x' }],
        totalTokens: 5,
        sourceBreakdown: [],
      }
      const prompt = assembler.buildExtendedPrompt(context, 'TMPL: {{source_context}}')
      expect(prompt).toContain('PROVIDED SOURCES:')
      expect(prompt).toContain('ctx')
    })
  })

  // -------------------------------------------------------------------------
  // Source breakdown
  // -------------------------------------------------------------------------

  describe('source breakdown', () => {
    it('aggregates token and chunk counts per source', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', score: 0.9, text: 'AAAA', chunkIndex: 0 }),
        makeChunk({ id: 'c2', sourceId: 'src-1', score: 0.8, text: 'BBBB', chunkIndex: 1 }),
        makeChunk({ id: 'c3', sourceId: 'src-2', score: 0.7, text: 'CCCC', chunkIndex: 0 }),
      ]
      const result = makeRetrievalResult(chunks)
      const sourceMeta = new Map([
        makeSourceMeta('src-1'),
        makeSourceMeta('src-2'),
      ])

      const assembled = assembler.assembleContext(result, sourceMeta)
      const bd1 = assembled.sourceBreakdown.find(b => b.sourceId === 'src-1')!
      const bd2 = assembled.sourceBreakdown.find(b => b.sourceId === 'src-2')!
      expect(bd1.chunkCount).toBe(2)
      expect(bd2.chunkCount).toBe(1)
    })
  })
})
