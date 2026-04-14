import { describe, it, expect } from 'vitest'
import { CitationTracker } from '../citation-tracker.js'
import type { RetrievalResult, ScoredChunk } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<ScoredChunk> & { id: string }): ScoredChunk {
  return {
    text: `Text for ${overrides.id}`,
    score: 0.8,
    sourceId: 'src-1',
    chunkIndex: 0,
    ...overrides,
  }
}

function makeRetrievalResult(chunks: ScoredChunk[]): RetrievalResult {
  return {
    chunks,
    totalTokens: 100,
    searchMode: 'hybrid',
    queryTimeMs: 5,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CitationTracker', () => {
  // -------------------------------------------------------------------------
  // Source registration
  // -------------------------------------------------------------------------

  describe('source registration', () => {
    it('registers and retrieves a single source', () => {
      const tracker = new CitationTracker()
      tracker.registerSource({ sourceId: 's1', title: 'Source One', url: 'https://one.com' })
      const source = tracker.getSource('s1')
      expect(source).toEqual({ sourceId: 's1', title: 'Source One', url: 'https://one.com' })
    })

    it('registers multiple sources at once', () => {
      const tracker = new CitationTracker()
      tracker.registerSources([
        { sourceId: 's1', title: 'One' },
        { sourceId: 's2', title: 'Two', domain: 'example.com' },
      ])
      expect(tracker.getSource('s1')).toBeDefined()
      expect(tracker.getSource('s2')?.domain).toBe('example.com')
    })

    it('returns undefined for unregistered source', () => {
      const tracker = new CitationTracker()
      expect(tracker.getSource('nonexistent')).toBeUndefined()
    })

    it('overwrites source on re-registration', () => {
      const tracker = new CitationTracker()
      tracker.registerSource({ sourceId: 's1', title: 'Old' })
      tracker.registerSource({ sourceId: 's1', title: 'New' })
      expect(tracker.getSource('s1')?.title).toBe('New')
    })
  })

  // -------------------------------------------------------------------------
  // Citation generation
  // -------------------------------------------------------------------------

  describe('generateCitations', () => {
    it('produces citations from retrieval results', () => {
      const tracker = new CitationTracker()
      tracker.registerSource({ sourceId: 'src-1', title: 'Doc One', url: 'https://one.com' })

      const result = makeRetrievalResult([
        makeChunk({ id: 'c1', sourceId: 'src-1', chunkIndex: 0, score: 0.9, text: 'Content here' }),
      ])

      const citations = tracker.generateCitations(result)
      expect(citations).toHaveLength(1)
      expect(citations[0]!.sourceTitle).toBe('Doc One')
      expect(citations[0]!.sourceUrl).toBe('https://one.com')
      expect(citations[0]!.score).toBe(0.9)
      expect(citations[0]!.snippet).toBe('Content here')
    })

    it('deduplicates citations by sourceId+chunkIndex', () => {
      const tracker = new CitationTracker()
      tracker.registerSource({ sourceId: 'src-1', title: 'Doc' })

      const result = makeRetrievalResult([
        makeChunk({ id: 'c1', sourceId: 'src-1', chunkIndex: 0, score: 0.9 }),
        makeChunk({ id: 'c1-dup', sourceId: 'src-1', chunkIndex: 0, score: 0.7 }),
      ])

      const citations = tracker.generateCitations(result)
      expect(citations).toHaveLength(1)
    })

    it('keeps different chunks from the same source', () => {
      const tracker = new CitationTracker()
      tracker.registerSource({ sourceId: 'src-1', title: 'Doc' })

      const result = makeRetrievalResult([
        makeChunk({ id: 'c1', sourceId: 'src-1', chunkIndex: 0 }),
        makeChunk({ id: 'c2', sourceId: 'src-1', chunkIndex: 1 }),
      ])

      const citations = tracker.generateCitations(result)
      expect(citations).toHaveLength(2)
    })

    it('uses chunk sourceTitle as fallback when source not registered', () => {
      const tracker = new CitationTracker()
      const result = makeRetrievalResult([
        makeChunk({ id: 'c1', sourceId: 'unknown', sourceTitle: 'From Chunk' }),
      ])

      const citations = tracker.generateCitations(result)
      expect(citations[0]!.sourceTitle).toBe('From Chunk')
    })

    it('falls back to "Unknown" when no title is available', () => {
      const tracker = new CitationTracker()
      const result = makeRetrievalResult([
        makeChunk({ id: 'c1', sourceId: 'unknown', sourceTitle: undefined }),
      ])

      const citations = tracker.generateCitations(result)
      expect(citations[0]!.sourceTitle).toBe('Unknown')
    })

    it('truncates snippet to 200 characters', () => {
      const tracker = new CitationTracker()
      tracker.registerSource({ sourceId: 'src-1', title: 'Doc' })
      const longText = 'X'.repeat(500)

      const result = makeRetrievalResult([
        makeChunk({ id: 'c1', sourceId: 'src-1', text: longText }),
      ])

      const citations = tracker.generateCitations(result)
      expect(citations[0]!.snippet).toHaveLength(200)
    })

    it('handles empty retrieval results', () => {
      const tracker = new CitationTracker()
      const result = makeRetrievalResult([])
      const citations = tracker.generateCitations(result)
      expect(citations).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  describe('formatInlineCitation', () => {
    it('formats 0-based index as 1-based inline citation', () => {
      const tracker = new CitationTracker()
      expect(tracker.formatInlineCitation(0)).toBe('[1]')
      expect(tracker.formatInlineCitation(4)).toBe('[5]')
    })
  })

  describe('formatReferenceList', () => {
    it('formats a numbered reference list', () => {
      const tracker = new CitationTracker()
      const citations = [
        { sourceId: 's1', sourceTitle: 'First Doc', sourceUrl: 'https://first.com', chunkIndex: 0, score: 0.9, snippet: '' },
        { sourceId: 's2', sourceTitle: 'Second Doc', chunkIndex: 0, score: 0.8, snippet: '' },
      ]

      const list = tracker.formatReferenceList(citations)
      expect(list).toBe('[1] First Doc (https://first.com)\n[2] Second Doc')
    })

    it('returns empty string for empty citations', () => {
      const tracker = new CitationTracker()
      expect(tracker.formatReferenceList([])).toBe('')
    })
  })
})
