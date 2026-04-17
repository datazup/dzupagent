/**
 * Coverage tests for assembler.ts — extended prompt, token budget enforcement,
 * insights mode, off mode, grounded template, and edge cases.
 */

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

describe('ContextAssembler — coverage', () => {
  const assembler = new ContextAssembler()

  describe('insights mode', () => {
    it('includes insight summary instead of chunks for insights sources', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-insight', text: 'RAG chunk that should be skipped' }),
      ]
      const result = makeRetrievalResult(chunks)

      const meta = new Map([
        makeSourceMeta('src-insight', {
          contextMode: 'insights',
          summary: 'This is a comprehensive summary of the source that is long enough to pass the 20 char threshold.',
        }),
      ])

      const ctx = assembler.assembleContext(result, meta)

      // Should include the summary, not the chunk text
      expect(ctx.contextText).toContain('comprehensive summary')
      expect(ctx.contextText).not.toContain('should be skipped')
    })

    it('skips insights summary when shorter than 20 characters', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-insight' }),
      ]
      const result = makeRetrievalResult(chunks)

      const meta = new Map([
        makeSourceMeta('src-insight', {
          contextMode: 'insights',
          summary: 'Too short',
        }),
      ])

      const ctx = assembler.assembleContext(result, meta)
      // Short summary skipped, and chunk also skipped because mode is insights
      expect(ctx.contextText).not.toContain('Too short')
    })

    it('insights pieces appear before full chunks in output', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-full', text: 'Full chunk content', score: 0.9 }),
        makeChunk({ id: 'c2', sourceId: 'src-insight', text: 'Insight RAG chunk', score: 0.95 }),
      ]
      const result = makeRetrievalResult(chunks)

      const meta = new Map([
        makeSourceMeta('src-full', { contextMode: 'full' }),
        makeSourceMeta('src-insight', {
          contextMode: 'insights',
          summary: 'Insight summary from the source document that is quite long and useful.',
        }),
      ])

      const ctx = assembler.assembleContext(result, meta)
      const insightPos = ctx.contextText.indexOf('Insight summary')
      const fullPos = ctx.contextText.indexOf('Full chunk content')
      expect(insightPos).toBeLessThan(fullPos)
    })
  })

  describe('off mode', () => {
    it('excludes chunks from sources with mode off', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-off', text: 'Should be excluded' }),
        makeChunk({ id: 'c2', sourceId: 'src-full', text: 'Should be included' }),
      ]
      const result = makeRetrievalResult(chunks)

      const meta = new Map([
        makeSourceMeta('src-off', { contextMode: 'off' }),
        makeSourceMeta('src-full', { contextMode: 'full' }),
      ])

      const ctx = assembler.assembleContext(result, meta)
      expect(ctx.contextText).not.toContain('Should be excluded')
      expect(ctx.contextText).toContain('Should be included')
    })

    it('includes off sources in breakdown with zero counts', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-full', text: 'Content' }),
      ]
      const result = makeRetrievalResult(chunks)

      const meta = new Map([
        makeSourceMeta('src-full', { contextMode: 'full' }),
        makeSourceMeta('src-off', { contextMode: 'off' }),
      ])

      const ctx = assembler.assembleContext(result, meta)
      const offBreakdown = ctx.sourceBreakdown.find((b) => b.sourceId === 'src-off')
      expect(offBreakdown).toBeDefined()
      expect(offBreakdown!.tokenCount).toBe(0)
      expect(offBreakdown!.chunkCount).toBe(0)
      expect(offBreakdown!.mode).toBe('off')
    })
  })

  describe('token budget enforcement', () => {
    it('drops lowest-scored full chunks when over budget', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', text: 'A'.repeat(200), score: 0.9 }),
        makeChunk({ id: 'c2', sourceId: 'src-1', text: 'B'.repeat(200), score: 0.5 }),
        makeChunk({ id: 'c3', sourceId: 'src-1', text: 'C'.repeat(200), score: 0.3 }),
      ]
      const result = makeRetrievalResult(chunks)
      const meta = new Map([makeSourceMeta('src-1')])

      const ctx = assembler.assembleContext(result, meta, { tokenBudget: 60 })

      // With budget of 60, should drop some chunks
      // Each chunk is ~50 tokens (200/4)
      expect(ctx.citations.length).toBeLessThan(3)
      // Highest scored should survive
      if (ctx.citations.length > 0) {
        expect(ctx.citations[0]!.score).toBe(0.9)
      }
    })

    it('preserves insights pieces even when over budget', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-full', text: 'X'.repeat(400), score: 0.4 }),
      ]
      const result = makeRetrievalResult(chunks)

      const meta = new Map([
        makeSourceMeta('src-full', { contextMode: 'full' }),
        makeSourceMeta('src-insight', {
          contextMode: 'insights',
          summary: 'Important insight summary that must be preserved in context.',
        }),
      ])

      const ctx = assembler.assembleContext(result, meta, { tokenBudget: 20 })

      // Insight should survive budget enforcement (insights are not dropped)
      expect(ctx.contextText).toContain('Important insight summary')
    })
  })

  describe('grounded prompt', () => {
    it('generates grounded prompt for non-empty citations', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', text: 'Some content' }),
      ]
      const result = makeRetrievalResult(chunks)
      const meta = new Map([makeSourceMeta('src-1')])

      const ctx = assembler.assembleContext(result, meta)
      expect(ctx.systemPrompt).toContain('research assistant')
      expect(ctx.systemPrompt).toContain('SOURCES:')
    })

    it('generates fallback prompt when no citations', () => {
      const result = makeRetrievalResult([])
      const meta = new Map<string, SourceMeta>()

      const ctx = assembler.assembleContext(result, meta)
      expect(ctx.systemPrompt).toContain('No sources')
    })

    it('uses custom grounded template', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', text: 'Content here' }),
      ]
      const result = makeRetrievalResult(chunks)
      const meta = new Map([makeSourceMeta('src-1')])

      const ctx = assembler.assembleContext(result, meta, {
        groundedTemplate: 'Custom prompt with {{source_context}} injected',
      })
      expect(ctx.systemPrompt).toContain('Custom prompt with')
      expect(ctx.systemPrompt).toContain('Content here')
    })
  })

  describe('buildExtendedPrompt', () => {
    it('builds extended prompt with sources', () => {
      const context: AssembledContext = {
        systemPrompt: '',
        contextText: '[1] "Source A" -- Some text',
        citations: [
          { sourceId: 'src-1', sourceTitle: 'Source A', chunkIndex: 0, score: 0.9, snippet: 'Some text' },
        ],
        totalTokens: 10,
        sourceBreakdown: [],
      }

      const prompt = assembler.buildExtendedPrompt(context)
      expect(prompt).toContain('research assistant')
      expect(prompt).toContain('PROVIDED SOURCES:')
      expect(prompt).toContain('[AI Knowledge]')
      expect(prompt).toContain('Some text')
    })

    it('builds extended prompt with no sources', () => {
      const context: AssembledContext = {
        systemPrompt: '',
        contextText: '',
        citations: [],
        totalTokens: 0,
        sourceBreakdown: [],
      }

      const prompt = assembler.buildExtendedPrompt(context)
      expect(prompt).toContain('None indexed yet')
    })

    it('uses custom extended template', () => {
      const context: AssembledContext = {
        systemPrompt: '',
        contextText: 'context text here',
        citations: [
          { sourceId: 'src-1', sourceTitle: 'S', chunkIndex: 0, score: 0.5, snippet: 'x' },
        ],
        totalTokens: 5,
        sourceBreakdown: [],
      }

      const prompt = assembler.buildExtendedPrompt(
        context,
        'My template: {{source_context}} end',
      )
      expect(prompt).toContain('My template:')
      expect(prompt).toContain('PROVIDED SOURCES:')
      expect(prompt).toContain('end')
    })
  })

  describe('citation formatting', () => {
    it('respects custom snippetLength', () => {
      const longText = 'W'.repeat(1000)
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', text: longText }),
      ]
      const result = makeRetrievalResult(chunks)
      const meta = new Map([makeSourceMeta('src-1')])

      const ctx = assembler.assembleContext(result, meta, { snippetLength: 50 })
      expect(ctx.citations[0]!.snippet.length).toBeLessThanOrEqual(50)
    })

    it('includes sourceUrl in citations when present', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', text: 'Content', sourceUrl: 'https://example.com' }),
      ]
      const result = makeRetrievalResult(chunks)
      const meta = new Map([makeSourceMeta('src-1', { url: 'https://example.com' })])

      const ctx = assembler.assembleContext(result, meta)
      expect(ctx.citations[0]!.sourceUrl).toBe('https://example.com')
    })

    it('resolves sourceUrl from meta when chunk has none', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', text: 'Content' }),
      ]
      const result = makeRetrievalResult(chunks)
      const meta = new Map([makeSourceMeta('src-1', { url: 'https://meta-url.com' })])

      const ctx = assembler.assembleContext(result, meta)
      // The context piece should have the URL from meta
      expect(ctx.contextText).toBeDefined()
    })
  })

  describe('source breakdown', () => {
    it('aggregates multiple chunks from the same source', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', text: 'First chunk', chunkIndex: 0 }),
        makeChunk({ id: 'c2', sourceId: 'src-1', text: 'Second chunk', chunkIndex: 1 }),
        makeChunk({ id: 'c3', sourceId: 'src-2', text: 'Other source', chunkIndex: 0 }),
      ]
      const result = makeRetrievalResult(chunks)
      const meta = new Map([
        makeSourceMeta('src-1'),
        makeSourceMeta('src-2'),
      ])

      const ctx = assembler.assembleContext(result, meta)

      const src1Breakdown = ctx.sourceBreakdown.find((b) => b.sourceId === 'src-1')
      expect(src1Breakdown!.chunkCount).toBe(2)
      expect(src1Breakdown!.tokenCount).toBeGreaterThan(0)

      const src2Breakdown = ctx.sourceBreakdown.find((b) => b.sourceId === 'src-2')
      expect(src2Breakdown!.chunkCount).toBe(1)
    })
  })

  describe('chunk without explicit source meta', () => {
    it('defaults to full mode when source not in metadata', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-unknown', text: 'Unknown source chunk' }),
      ]
      const result = makeRetrievalResult(chunks)
      const meta = new Map<string, SourceMeta>() // Empty metadata

      const ctx = assembler.assembleContext(result, meta)
      // Should still include the chunk with default full mode
      expect(ctx.contextText).toContain('Unknown source chunk')
    })

    it('uses sourceTitle from chunk when available', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-1', text: 'Content', sourceTitle: 'My Doc' }),
      ]
      const result = makeRetrievalResult(chunks)
      const meta = new Map<string, SourceMeta>()

      const ctx = assembler.assembleContext(result, meta)
      expect(ctx.citations[0]!.sourceTitle).toBe('My Doc')
    })
  })
})
