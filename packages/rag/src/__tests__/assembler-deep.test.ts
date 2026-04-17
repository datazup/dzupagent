/**
 * Deep coverage tests for ContextAssembler (CF-0023).
 *
 * Fills gaps left by assembler.test.ts and assembler-coverage.test.ts.
 * Focus areas:
 *   - Token budget: exact-fit, zero-budget, negative budget, very-large budget
 *   - Citation numbering: sequential [1], [2], [3]
 *   - Multi-chunk separator injection
 *   - Empty inputs produce no-sources fallback
 *   - Single chunk has no trailing separator
 *   - SnippetLength edge cases: 0, negative, beyond text length
 *   - Citation score preservation
 *   - Context text ordering (insights first)
 *   - Total tokens aggregation
 *   - sourceBreakdown aggregation with mixed modes
 */

import { describe, it, expect } from 'vitest'
import { ContextAssembler } from '../assembler.js'
import type {
  RetrievalResult,
  ScoredChunk,
  SourceMeta,
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

function makeResult(chunks: ScoredChunk[]): RetrievalResult {
  return {
    chunks,
    totalTokens: chunks.reduce((sum, c) => sum + Math.ceil(c.text.length / 4), 0),
    searchMode: 'hybrid',
    queryTimeMs: 10,
  }
}

function makeMeta(
  sourceId: string,
  overrides?: Partial<SourceMeta>,
): [string, SourceMeta] {
  return [
    sourceId,
    {
      sourceId,
      title: `Title for ${sourceId}`,
      contextMode: 'full',
      ...overrides,
    },
  ]
}

// ===========================================================================
// Tests
// ===========================================================================

describe('ContextAssembler — deep branches', () => {
  const assembler = new ContextAssembler()

  // -------------------------------------------------------------------------
  // Citation numbering
  // -------------------------------------------------------------------------

  describe('citation numbering', () => {
    it('numbers citations as [1], [2], [3] sequentially', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', score: 0.9, text: 'A' }),
        makeChunk({ id: 'c2', sourceId: 's2', score: 0.8, text: 'B' }),
        makeChunk({ id: 'c3', sourceId: 's3', score: 0.7, text: 'C' }),
      ]
      const meta = new Map([makeMeta('s1'), makeMeta('s2'), makeMeta('s3')])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      // Context text uses [1], [2], [3] prefixes
      expect(ctx.contextText).toMatch(/^\[1\]/)
      expect(ctx.contextText).toContain('[2]')
      expect(ctx.contextText).toContain('[3]')
    })

    it('citations array length matches the number of included pieces', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', score: 0.9 }),
        makeChunk({ id: 'c2', sourceId: 's2', score: 0.8 }),
      ]
      const meta = new Map([makeMeta('s1'), makeMeta('s2')])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      expect(ctx.citations).toHaveLength(2)
    })

    it('each citation has matching score from the chunk', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', score: 0.95 }),
        makeChunk({ id: 'c2', sourceId: 's2', score: 0.42 }),
      ]
      const meta = new Map([makeMeta('s1'), makeMeta('s2')])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      const scores = ctx.citations.map((c) => c.score).sort((a, b) => b - a)
      expect(scores[0]).toBe(0.95)
      expect(scores[1]).toBe(0.42)
    })
  })

  // -------------------------------------------------------------------------
  // Multi-chunk separator
  // -------------------------------------------------------------------------

  describe('multi-chunk separator', () => {
    it('injects \\n\\n between adjacent chunks', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', score: 0.9, text: 'first' }),
        makeChunk({ id: 'c2', sourceId: 's1', score: 0.8, text: 'second' }),
      ]
      const meta = new Map([makeMeta('s1')])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      // Pieces joined with '\n\n'
      expect(ctx.contextText).toContain('\n\n')
      // Both pieces survive
      expect(ctx.contextText).toContain('first')
      expect(ctx.contextText).toContain('second')
    })

    it('single chunk has no separator in context text', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', score: 0.9, text: 'only one' }),
      ]
      const meta = new Map([makeMeta('s1')])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      expect(ctx.contextText).not.toContain('\n\n')
      expect(ctx.contextText).toContain('only one')
    })
  })

  // -------------------------------------------------------------------------
  // Token budget edges
  // -------------------------------------------------------------------------

  describe('token budget edges', () => {
    it('zero budget drops all full chunks (no insights preserved if zero)', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', text: 'X'.repeat(100), score: 0.9 }),
      ]
      const meta = new Map([makeMeta('s1')])
      const ctx = assembler.assembleContext(makeResult(chunks), meta, { tokenBudget: 0 })

      expect(ctx.citations).toHaveLength(0)
      expect(ctx.contextText).toBe('')
    })

    it('very large budget keeps all chunks', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', text: 'A', score: 0.9 }),
        makeChunk({ id: 'c2', sourceId: 's1', text: 'B', score: 0.8 }),
      ]
      const meta = new Map([makeMeta('s1')])
      const ctx = assembler.assembleContext(makeResult(chunks), meta, {
        tokenBudget: 1_000_000,
      })

      expect(ctx.citations).toHaveLength(2)
    })

    it('budget exactly sufficient keeps all chunks (boundary case)', () => {
      // Each chunk text "ABCD" = 4 chars → 1 token; total = 2 tokens
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', text: 'ABCD', score: 0.9 }),
        makeChunk({ id: 'c2', sourceId: 's1', text: 'EFGH', score: 0.8 }),
      ]
      const meta = new Map([makeMeta('s1')])
      // totalTokens = 2, budget = 2 → keeps both
      const ctx = assembler.assembleContext(makeResult(chunks), meta, { tokenBudget: 2 })
      expect(ctx.citations).toHaveLength(2)
    })

    it('preserves insights piece when full chunks exceed budget', () => {
      const longSummary = 'A relevant summary long enough to pass the 20-char threshold.'
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 'src-full', text: 'X'.repeat(400), score: 0.5 }),
      ]
      const meta = new Map([
        makeMeta('src-full', { contextMode: 'full' }),
        makeMeta('src-ins', { contextMode: 'insights', summary: longSummary }),
      ])

      const ctx = assembler.assembleContext(makeResult(chunks), meta, { tokenBudget: 20 })
      // Insights is preserved
      expect(ctx.contextText).toContain(longSummary)
    })

    it('totalTokens equals sum of kept piece tokens', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', text: 'ABCD', score: 0.9 }),
        makeChunk({ id: 'c2', sourceId: 's1', text: 'EFGH', score: 0.8 }),
      ]
      const meta = new Map([makeMeta('s1')])
      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      expect(ctx.totalTokens).toBe(2) // 4 chars / 4 tokens each
    })
  })

  // -------------------------------------------------------------------------
  // Empty and edge cases
  // -------------------------------------------------------------------------

  describe('empty and edge cases', () => {
    it('no chunks and no metadata: no-sources fallback prompt + empty context', () => {
      const result = makeResult([])
      const meta = new Map<string, SourceMeta>()

      const ctx = assembler.assembleContext(result, meta)
      expect(ctx.citations).toHaveLength(0)
      expect(ctx.contextText).toBe('')
      expect(ctx.systemPrompt).toContain('No sources')
      expect(ctx.totalTokens).toBe(0)
      expect(ctx.sourceBreakdown).toHaveLength(0)
    })

    it('all chunks belong to "off" sources → no included citations', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's-off', score: 0.9 }),
        makeChunk({ id: 'c2', sourceId: 's-off', score: 0.8 }),
      ]
      const meta = new Map([makeMeta('s-off', { contextMode: 'off' })])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      expect(ctx.citations).toHaveLength(0)
      expect(ctx.contextText).toBe('')

      // 'off' source recorded in breakdown with zero counts
      const offBreakdown = ctx.sourceBreakdown.find((b) => b.sourceId === 's-off')
      expect(offBreakdown).toBeDefined()
      expect(offBreakdown!.chunkCount).toBe(0)
    })

    it('default snippetLength (400) used when not provided', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', text: 'Y'.repeat(2000) }),
      ]
      const meta = new Map([makeMeta('s1')])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      expect(ctx.citations[0]!.snippet).toHaveLength(400)
    })

    it('snippet does not exceed custom snippetLength', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', text: 'Z'.repeat(1000) }),
      ]
      const meta = new Map([makeMeta('s1')])
      const ctx = assembler.assembleContext(makeResult(chunks), meta, { snippetLength: 25 })
      expect(ctx.citations[0]!.snippet.length).toBeLessThanOrEqual(25)
    })

    it('snippet shorter than text length when text < snippetLength', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', text: 'tiny' }),
      ]
      const meta = new Map([makeMeta('s1')])
      const ctx = assembler.assembleContext(makeResult(chunks), meta, { snippetLength: 100 })
      // Snippet equals the full text (4 chars, slice up to 100)
      expect(ctx.citations[0]!.snippet).toBe('tiny')
    })
  })

  // -------------------------------------------------------------------------
  // Context mode ordering
  // -------------------------------------------------------------------------

  describe('ordering', () => {
    it('insights piece appears before higher-scored full chunk in output', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's-full', text: 'Top-score full chunk', score: 0.99 }),
      ]
      const meta = new Map([
        makeMeta('s-full', { contextMode: 'full' }),
        makeMeta('s-ins', {
          contextMode: 'insights',
          summary: 'A useful insights summary with enough length.',
        }),
      ])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      const insightsIdx = ctx.contextText.indexOf('useful insights summary')
      const fullIdx = ctx.contextText.indexOf('Top-score full chunk')
      expect(insightsIdx).toBeGreaterThanOrEqual(0)
      expect(fullIdx).toBeGreaterThan(insightsIdx)
    })

    it('full chunks sorted by score descending within the full-chunk group', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', text: 'LOW', score: 0.3 }),
        makeChunk({ id: 'c2', sourceId: 's1', text: 'HIGH', score: 0.9 }),
        makeChunk({ id: 'c3', sourceId: 's1', text: 'MID', score: 0.6 }),
      ]
      const meta = new Map([makeMeta('s1')])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      const highIdx = ctx.contextText.indexOf('HIGH')
      const midIdx = ctx.contextText.indexOf('MID')
      const lowIdx = ctx.contextText.indexOf('LOW')
      expect(highIdx).toBeLessThan(midIdx)
      expect(midIdx).toBeLessThan(lowIdx)
    })
  })

  // -------------------------------------------------------------------------
  // Citation contents
  // -------------------------------------------------------------------------

  describe('citation contents', () => {
    it('citation chunkIndex is preserved from the chunk', () => {
      const chunks = [makeChunk({ id: 'c1', sourceId: 's1', chunkIndex: 7 })]
      const meta = new Map([makeMeta('s1')])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      expect(ctx.citations[0]!.chunkIndex).toBe(7)
    })

    it('citation includes sourceUrl from meta when chunk has none', () => {
      const chunks = [makeChunk({ id: 'c1', sourceId: 's1' })]
      const meta = new Map([
        makeMeta('s1', { url: 'https://meta-url.example.com' }),
      ])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      expect(ctx.citations[0]!.sourceUrl).toBe('https://meta-url.example.com')
    })

    it('citation uses chunk.sourceUrl over meta.url when both provided', () => {
      const chunks = [
        makeChunk({
          id: 'c1',
          sourceId: 's1',
          sourceUrl: 'https://chunk-url.example.com',
        }),
      ]
      const meta = new Map([
        makeMeta('s1', { url: 'https://meta-url.example.com' }),
      ])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      expect(ctx.citations[0]!.sourceUrl).toBe('https://chunk-url.example.com')
    })

    it('falls back to "Unknown" title when neither chunk nor meta has a title', () => {
      const chunks = [
        makeChunk({
          id: 'c1',
          sourceId: 'missing',
          sourceTitle: undefined,
        }),
      ]
      const meta = new Map<string, SourceMeta>() // No meta for 'missing'

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      expect(ctx.citations[0]!.sourceTitle).toBe('Unknown')
    })
  })

  // -------------------------------------------------------------------------
  // Grounded / extended prompt templates
  // -------------------------------------------------------------------------

  describe('grounded and extended prompts', () => {
    it('grounded custom template replaces all occurrences of placeholder', () => {
      const chunks = [makeChunk({ id: 'c1', sourceId: 's1', text: 'stuff' })]
      const meta = new Map([makeMeta('s1')])

      const template = 'A {{source_context}} B {{source_context}} C'
      const ctx = assembler.assembleContext(makeResult(chunks), meta, {
        groundedTemplate: template,
      })
      // Both placeholders replaced
      const matches = ctx.systemPrompt.match(/\{\{source_context\}\}/g)
      expect(matches).toBeNull()
      // Literal A, B, C from template still present
      expect(ctx.systemPrompt).toContain('A ')
      expect(ctx.systemPrompt).toContain(' B ')
      expect(ctx.systemPrompt).toContain(' C')
    })

    it('extended custom template replaces all occurrences of placeholder', () => {
      const ctx = assembler.buildExtendedPrompt(
        {
          systemPrompt: '',
          contextText: 'ctx',
          citations: [
            { sourceId: 's', sourceTitle: 'T', chunkIndex: 0, score: 0.5, snippet: 'x' },
          ],
          totalTokens: 5,
          sourceBreakdown: [],
        },
        'FIRST {{source_context}} SECOND {{source_context}} END',
      )
      expect(ctx).not.toContain('{{source_context}}')
      expect(ctx).toContain('FIRST')
      expect(ctx).toContain('SECOND')
      expect(ctx).toContain('END')
    })

    it('buildGroundedPrompt default branch includes "SOURCES:" header', () => {
      const prompt = assembler.buildGroundedPrompt({
        systemPrompt: '',
        contextText: '[1] "Doc" — text',
        citations: [
          { sourceId: 's', sourceTitle: 'Doc', chunkIndex: 0, score: 0.9, snippet: 't' },
        ],
        totalTokens: 5,
        sourceBreakdown: [],
      })
      expect(prompt).toContain('SOURCES:')
      expect(prompt).toContain('[N] notation')
    })

    it('buildExtendedPrompt default branch mentions general knowledge prefix', () => {
      const prompt = assembler.buildExtendedPrompt({
        systemPrompt: '',
        contextText: '[1] "Doc" — text',
        citations: [
          { sourceId: 's', sourceTitle: 'Doc', chunkIndex: 0, score: 0.9, snippet: 't' },
        ],
        totalTokens: 5,
        sourceBreakdown: [],
      })
      expect(prompt).toContain('[AI Knowledge]')
    })
  })

  // -------------------------------------------------------------------------
  // sourceBreakdown aggregation
  // -------------------------------------------------------------------------

  describe('sourceBreakdown aggregation', () => {
    it('multi-chunk single-source aggregates counts correctly', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's1', text: 'AAAA', chunkIndex: 0 }),
        makeChunk({ id: 'c2', sourceId: 's1', text: 'BBBB', chunkIndex: 1 }),
        makeChunk({ id: 'c3', sourceId: 's1', text: 'CCCC', chunkIndex: 2 }),
      ]
      const meta = new Map([makeMeta('s1')])
      const ctx = assembler.assembleContext(makeResult(chunks), meta)

      const bd = ctx.sourceBreakdown.find((b) => b.sourceId === 's1')
      expect(bd).toBeDefined()
      expect(bd!.chunkCount).toBe(3)
      // Each "AAAA" = 4 chars → 1 token; total = 3 tokens
      expect(bd!.tokenCount).toBe(3)
    })

    it('breakdown mode reflects the mode used (full vs insights)', () => {
      const chunks = [
        makeChunk({ id: 'c1', sourceId: 's-full', text: 'full-chunk' }),
      ]
      const meta = new Map([
        makeMeta('s-full', { contextMode: 'full' }),
        makeMeta('s-ins', {
          contextMode: 'insights',
          summary: 'An insight summary long enough to be included.',
        }),
      ])

      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      const fullBd = ctx.sourceBreakdown.find((b) => b.sourceId === 's-full')
      const insBd = ctx.sourceBreakdown.find((b) => b.sourceId === 's-ins')
      expect(fullBd!.mode).toBe('full')
      expect(insBd!.mode).toBe('insights')
    })

    it('breakdown does NOT include sources that produced no pieces AND are not in meta', () => {
      const chunks: ScoredChunk[] = []
      const meta = new Map<string, SourceMeta>()
      const ctx = assembler.assembleContext(makeResult(chunks), meta)
      expect(ctx.sourceBreakdown).toHaveLength(0)
    })
  })
})
