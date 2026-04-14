import { describe, it, expect } from 'vitest'
import { SmartChunker, DEFAULT_CHUNKING_CONFIG } from '../chunker.js'

// estimateTokens = Math.ceil(text.length / 4)

describe('SmartChunker', () => {
  // ---------------------------------------------------------------------------
  // Basic chunking
  // ---------------------------------------------------------------------------

  describe('chunkText', () => {
    it('returns empty array for empty string', () => {
      const chunker = new SmartChunker()
      expect(chunker.chunkText('', 'src-1')).toEqual([])
    })

    it('returns empty array for whitespace-only string', () => {
      const chunker = new SmartChunker()
      expect(chunker.chunkText('   \n\t  ', 'src-1')).toEqual([])
    })

    it('produces a single chunk for short text', () => {
      const chunker = new SmartChunker()
      const result = chunker.chunkText('Hello world.', 'src-1')
      expect(result).toHaveLength(1)
      expect(result[0]!.text).toBe('Hello world.')
      expect(result[0]!.id).toBe('src-1:0')
      expect(result[0]!.metadata.sourceId).toBe('src-1')
      expect(result[0]!.metadata.chunkIndex).toBe(0)
    })

    it('assigns sequential chunk indices', () => {
      const chunker = new SmartChunker({ targetTokens: 50, respectBoundaries: false })
      const text = 'A'.repeat(500)
      const result = chunker.chunkText(text, 'doc')
      for (let i = 0; i < result.length; i++) {
        expect(result[i]!.metadata.chunkIndex).toBe(i)
        expect(result[i]!.id).toBe(`doc:${i}`)
      }
    })

    it('generates overlapping chunks', () => {
      const chunker = new SmartChunker({ targetTokens: 50, overlapFraction: 0.2, respectBoundaries: false })
      const text = 'A'.repeat(500)
      const result = chunker.chunkText(text, 'doc')
      expect(result.length).toBeGreaterThan(1)
      for (let i = 1; i < result.length; i++) {
        expect(result[i]!.metadata.startOffset).toBeLessThan(result[i - 1]!.metadata.endOffset)
      }
    })

    it('respects the default config values', () => {
      expect(DEFAULT_CHUNKING_CONFIG).toEqual({
        targetTokens: 1200,
        overlapFraction: 0.15,
        respectBoundaries: true,
      })
    })

    it('uses custom config when provided', () => {
      const chunker = new SmartChunker({ targetTokens: 100, overlapFraction: 0.1, respectBoundaries: false })
      const text = 'Word '.repeat(200)
      const result = chunker.chunkText(text, 'src')
      expect(result.length).toBeGreaterThan(1)
    })

    it('produces token counts using estimateTokens (length/4 ceiling)', () => {
      const chunker = new SmartChunker()
      const result = chunker.chunkText('Hello world', 'src')
      expect(result[0]!.tokenCount).toBe(3)
    })
  })

  // ---------------------------------------------------------------------------
  // Boundary detection
  // ---------------------------------------------------------------------------

  describe('boundary detection', () => {
    it('splits at markdown header boundaries', () => {
      const chunker = new SmartChunker({ targetTokens: 30, respectBoundaries: true })
      const text = 'A'.repeat(80) + '\n## Section Two\n' + 'B'.repeat(80)
      const result = chunker.chunkText(text, 'doc')
      expect(result.length).toBeGreaterThanOrEqual(2)
      expect(result.find(c => c.metadata.boundaryType === 'header')).toBeDefined()
    })

    it('splits at paragraph boundaries (double newline)', () => {
      const chunker = new SmartChunker({ targetTokens: 30, respectBoundaries: true })
      const text = 'A'.repeat(80) + '\n\n' + 'B'.repeat(80)
      const result = chunker.chunkText(text, 'doc')
      expect(result.length).toBeGreaterThanOrEqual(2)
      expect(result.find(c => c.metadata.boundaryType === 'paragraph')).toBeDefined()
    })

    it('uses token boundary when respectBoundaries is false', () => {
      const chunker = new SmartChunker({ targetTokens: 30, respectBoundaries: false })
      const text = 'A'.repeat(80) + '\n## Header\n' + 'B'.repeat(80)
      const result = chunker.chunkText(text, 'doc')
      for (const chunk of result) {
        expect(chunk.metadata.boundaryType).toBe('token')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Tiny trailing chunk merge
  // ---------------------------------------------------------------------------

  describe('trailing chunk merge', () => {
    it('merges a tiny trailing chunk into its predecessor', () => {
      const chunker = new SmartChunker({ targetTokens: 50, overlapFraction: 0, respectBoundaries: false })
      const text = 'A'.repeat(210)
      const result = chunker.chunkText(text, 'doc')
      expect(result).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Quality scoring
  // ---------------------------------------------------------------------------

  describe('computeChunkQuality', () => {
    const chunker = new SmartChunker()

    it('returns zero metrics for empty content', () => {
      const quality = chunker.computeChunkQuality('', 0, 1)
      expect(quality.overallScore).toBe(0)
      expect(quality.vocabularyDiversity).toBe(0)
      expect(quality.avgSentenceLength).toBe(0)
      expect(quality.textToNoiseRatio).toBe(0)
      expect(quality.structureScore).toBe(0)
    })

    it('returns positive quality for meaningful content', () => {
      const content = 'The quick brown fox jumps over the lazy dog. This is a test of the quality scoring system. It should produce a reasonable quality score.'
      const quality = chunker.computeChunkQuality(content, 0, 3)
      expect(quality.overallScore).toBeGreaterThan(0)
      expect(quality.overallScore).toBeLessThanOrEqual(1)
    })

    it('penalizes the last chunk in a multi-chunk document', () => {
      const content = 'The quick brown fox jumps over the lazy dog. This is a meaningful sentence with enough words.'
      const middleQuality = chunker.computeChunkQuality(content, 1, 5)
      const lastQuality = chunker.computeChunkQuality(content, 4, 5)
      expect(lastQuality.overallScore).toBeLessThan(middleQuality.overallScore)
    })

    it('does not penalize the last chunk in a single-chunk document', () => {
      const content = 'The quick brown fox jumps over the lazy dog. This is a meaningful sentence with enough words.'
      const quality = chunker.computeChunkQuality(content, 0, 1)
      expect(quality.overallScore).toBeGreaterThan(0)
    })

    it('detects boilerplate content and lowers quality', () => {
      const boilerplate = 'Please subscribe to our newsletter. Accept cookies. Follow us on social media. Sign up for our service. Privacy policy applies. Copyright reserved. All rights reserved.'
      const clean = 'Machine learning models process data through multiple layers. Neural networks use activation functions to transform inputs.'
      const boilerplateQ = chunker.computeChunkQuality(boilerplate, 0, 3)
      const cleanQ = chunker.computeChunkQuality(clean, 0, 3)
      expect(boilerplateQ.overallScore).toBeLessThan(cleanQ.overallScore)
    })

    it('assigns vocabulary diversity score', () => {
      const diverse = 'The quick brown fox jumps over the lazy dog near the park.'
      const repetitive = 'the the the the the the the the the the the the'
      const diverseQ = chunker.computeChunkQuality(diverse, 0, 1)
      const repetitiveQ = chunker.computeChunkQuality(repetitive, 0, 1)
      expect(diverseQ.vocabularyDiversity).toBeGreaterThan(repetitiveQ.vocabularyDiversity)
    })

    it('assigns structure score for headers, lists, and code blocks', () => {
      const structured = '# Header\n- List item one\n- List item two\n```\ncode block\n```'
      const plain = 'Just some plain text without any structural elements at all.'
      const structuredQ = chunker.computeChunkQuality(structured, 0, 1)
      const plainQ = chunker.computeChunkQuality(plain, 0, 1)
      expect(structuredQ.structureScore).toBeGreaterThan(plainQ.structureScore)
      expect(plainQ.structureScore).toBe(0)
    })

    it('clamps overall score between 0 and 1', () => {
      const content = 'Some content for testing. This is a real sentence with words.'
      const quality = chunker.computeChunkQuality(content, 0, 1)
      expect(quality.overallScore).toBeGreaterThanOrEqual(0)
      expect(quality.overallScore).toBeLessThanOrEqual(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles text with only special characters', () => {
      const chunker = new SmartChunker()
      const result = chunker.chunkText('!!!???...', 'src')
      expect(result).toHaveLength(1)
    })

    it('handles long text without crashing', () => {
      const chunker = new SmartChunker({ targetTokens: 50, respectBoundaries: false })
      const text = 'word '.repeat(500)
      const result = chunker.chunkText(text, 'long')
      expect(result.length).toBeGreaterThan(1)
      for (const chunk of result) {
        expect(chunk.text.length).toBeGreaterThan(0)
      }
    })
  })
})
