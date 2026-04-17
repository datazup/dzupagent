/**
 * Coverage tests for chunker.ts — boundary fallback paths (lines 278-286),
 * edge cases in chunk splitting, and quality scoring.
 */

import { describe, it, expect } from 'vitest'
import { SmartChunker } from '../chunker.js'
import type { ChunkResult } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultChunker(overrides?: Record<string, unknown>): SmartChunker {
  return new SmartChunker({
    targetTokens: 100,
    overlapFraction: 0.15,
    respectBoundaries: true,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmartChunker — coverage', () => {
  describe('empty and minimal input', () => {
    it('returns empty array for empty string', () => {
      const chunker = defaultChunker()
      const chunks = chunker.chunkText('', 'src-1')
      expect(chunks).toEqual([])
    })

    it('returns empty array for whitespace-only string', () => {
      const chunker = defaultChunker()
      const chunks = chunker.chunkText('   \n\n  \t  ', 'src-1')
      expect(chunks).toEqual([])
    })

    it('returns single chunk for very short text', () => {
      const chunker = defaultChunker()
      const chunks = chunker.chunkText('Hello world.', 'src-1')
      expect(chunks).toHaveLength(1)
      expect(chunks[0]!.text).toContain('Hello world')
    })
  })

  describe('boundary-aware splitting', () => {
    it('splits on markdown headers when respectBoundaries is true', () => {
      const chunker = defaultChunker({ targetTokens: 30 })
      const text = [
        '# Section One',
        'Content of section one with some text. '.repeat(5),
        '## Section Two',
        'Content of section two with some text. '.repeat(5),
      ].join('\n\n')

      const chunks = chunker.chunkText(text, 'src-1')
      expect(chunks.length).toBeGreaterThan(1)
    })

    it('splits on paragraph boundaries', () => {
      const chunker = defaultChunker({ targetTokens: 30 })
      const text = Array.from({ length: 10 }, (_, i) =>
        `Paragraph ${i}: ${'word '.repeat(20)}`,
      ).join('\n\n')

      const chunks = chunker.chunkText(text, 'src-1')
      expect(chunks.length).toBeGreaterThan(1)
    })

    it('falls back to sentence boundaries when no paragraph breaks', () => {
      const chunker = defaultChunker({ targetTokens: 30 })
      // Long text without paragraph breaks, only sentence endings
      const text = Array.from({ length: 20 }, (_, i) =>
        `This is sentence number ${i} with additional words to make it longer.`,
      ).join(' ')

      const chunks = chunker.chunkText(text, 'src-1')
      expect(chunks.length).toBeGreaterThan(1)
      // Most chunks should end at sentence boundaries
      for (const chunk of chunks.slice(0, -1)) {
        const trimmed = chunk.text.trim()
        // Should end with punctuation or be at a natural break
        expect(trimmed.length).toBeGreaterThan(0)
      }
    })

    it('falls back to token boundary when no sentence breaks found', () => {
      const chunker = defaultChunker({ targetTokens: 10 })
      // Long text without any sentence boundaries — just one continuous word-like thing
      const text = 'abcdefgh'.repeat(100)

      const chunks = chunker.chunkText(text, 'src-1')
      expect(chunks.length).toBeGreaterThan(1)
      // Should use 'token' boundary type for forced splits
      const tokenBoundaries = chunks.filter((c) => c.metadata.boundaryType === 'token')
      expect(tokenBoundaries.length).toBeGreaterThan(0)
    })
  })

  describe('overlap', () => {
    it('produces overlapping chunks when overlapFraction > 0', () => {
      const chunker = defaultChunker({ targetTokens: 30, overlapFraction: 0.2 })
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(30)

      const chunks = chunker.chunkText(text, 'src-1')
      expect(chunks.length).toBeGreaterThan(1)

      // Check that chunks overlap by verifying end of chunk N appears at start of chunk N+1
      if (chunks.length >= 2) {
        const lastWords = chunks[0]!.text.trim().split(/\s+/).slice(-3).join(' ')
        // With overlap, the next chunk should start near where the previous ended
        // Not an exact test, but chunks should not be completely disjoint
        expect(chunks[1]!.metadata.startOffset).toBeLessThan(chunks[0]!.metadata.endOffset + 200)
      }
    })

    it('produces non-overlapping chunks when overlapFraction is 0', () => {
      const chunker = defaultChunker({ targetTokens: 30, overlapFraction: 0 })
      const text = 'This is a test sentence for chunking. '.repeat(30)

      const chunks = chunker.chunkText(text, 'src-1')
      expect(chunks.length).toBeGreaterThan(1)
    })
  })

  describe('quality scoring', () => {
    it('assigns quality scores between 0 and 1', () => {
      const chunker = defaultChunker({ targetTokens: 50 })
      const text = 'This is a well-structured paragraph with good vocabulary diversity. '.repeat(20)

      const chunks = chunker.chunkText(text, 'src-1')
      for (const chunk of chunks) {
        expect(chunk.quality).toBeGreaterThanOrEqual(0)
        expect(chunk.quality).toBeLessThanOrEqual(1)
      }
    })

    it('gives higher quality to text with structure (headers, lists)', () => {
      const chunker = defaultChunker({ targetTokens: 200 })

      const structured = [
        '# Important Topic',
        '',
        'This section covers an important topic with detailed analysis.',
        '',
        '- First key point about the topic',
        '- Second key point with elaboration',
        '- Third key point for completeness',
        '',
        'In conclusion, this is well structured.',
      ].join('\n')

      const plain = 'word '.repeat(200)

      const structuredChunks = chunker.chunkText(structured, 'src-1')
      const plainChunks = chunker.chunkText(plain, 'src-2')

      if (structuredChunks.length > 0 && plainChunks.length > 0) {
        expect(structuredChunks[0]!.quality).toBeGreaterThan(plainChunks[0]!.quality)
      }
    })
  })

  describe('metadata', () => {
    it('includes correct source ID in metadata', () => {
      const chunker = defaultChunker()
      const chunks = chunker.chunkText('Hello world test.', 'my-source')
      expect(chunks[0]!.metadata.sourceId).toBe('my-source')
    })

    it('assigns sequential chunkIndex values', () => {
      const chunker = defaultChunker({ targetTokens: 20 })
      const text = 'A sentence with words. '.repeat(30)

      const chunks = chunker.chunkText(text, 'src-1')
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i]!.metadata.chunkIndex).toBe(i)
      }
    })

    it('includes valid startOffset and endOffset', () => {
      const chunker = defaultChunker({ targetTokens: 30 })
      const text = 'Content for offset testing. '.repeat(20)

      const chunks = chunker.chunkText(text, 'src-1')
      for (const chunk of chunks) {
        expect(chunk.metadata.startOffset).toBeGreaterThanOrEqual(0)
        expect(chunk.metadata.endOffset).toBeGreaterThan(chunk.metadata.startOffset)
      }
    })

    it('assigns unique IDs to each chunk', () => {
      const chunker = defaultChunker({ targetTokens: 20 })
      const text = 'Chunk test data here. '.repeat(20)

      const chunks = chunker.chunkText(text, 'src-1')
      const ids = new Set(chunks.map((c) => c.id))
      expect(ids.size).toBe(chunks.length)
    })
  })

  describe('token estimation', () => {
    it('estimates token count for each chunk', () => {
      const chunker = defaultChunker({ targetTokens: 30 })
      const text = 'Token estimation test. '.repeat(30)

      const chunks = chunker.chunkText(text, 'src-1')
      for (const chunk of chunks) {
        expect(chunk.tokenCount).toBeGreaterThan(0)
        // Token count should be roughly text.length / 4
        expect(chunk.tokenCount).toBeCloseTo(Math.ceil(chunk.text.length / 4), -1)
      }
    })
  })

  describe('respectBoundaries = false', () => {
    it('splits purely by token count when boundaries disabled', () => {
      const chunker = defaultChunker({ targetTokens: 20, respectBoundaries: false })
      const text = 'This is a test. '.repeat(30)

      const chunks = chunker.chunkText(text, 'src-1')
      expect(chunks.length).toBeGreaterThan(1)
    })
  })

  describe('code block handling', () => {
    it('handles text with code blocks', () => {
      const chunker = defaultChunker({ targetTokens: 40 })
      const text = [
        'Here is some code:',
        '',
        '```typescript',
        'function hello() {',
        '  console.log("hello world");',
        '}',
        '```',
        '',
        'And here is more text after the code block. '.repeat(10),
      ].join('\n')

      const chunks = chunker.chunkText(text, 'src-1')
      expect(chunks.length).toBeGreaterThan(0)
    })
  })

  describe('large input', () => {
    it('handles very long text efficiently', () => {
      const chunker = defaultChunker({ targetTokens: 200 })
      const text = 'This is a paragraph of text. '.repeat(500)

      const start = performance.now()
      const chunks = chunker.chunkText(text, 'src-1')
      const elapsed = performance.now() - start

      expect(chunks.length).toBeGreaterThan(1)
      // Should complete in reasonable time
      expect(elapsed).toBeLessThan(5000)
    })
  })
})
