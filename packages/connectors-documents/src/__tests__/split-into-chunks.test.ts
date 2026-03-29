import { describe, it, expect } from 'vitest'
import { splitIntoChunks } from '../chunking/split-into-chunks.js'

describe('splitIntoChunks', () => {
  it('returns empty array for empty text', () => {
    expect(splitIntoChunks('')).toEqual([])
    expect(splitIntoChunks('   ')).toEqual([])
  })

  it('returns single chunk for short text', () => {
    const text = 'Hello world'
    const chunks = splitIntoChunks(text, 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('Hello world')
  })

  it('splits on heading boundaries', () => {
    // Each section needs to be large enough that total exceeds maxChunkSize
    const section1 = `## Section 1\n${'Content A. '.repeat(50)}`
    const section2 = `## Section 2\n${'Content B. '.repeat(50)}`
    const section3 = `### Subsection 2.1\n${'Content C. '.repeat(50)}`
    const text = `${section1}\n\n${section2}\n\n${section3}`
    const chunks = splitIntoChunks(text, 400, 0)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]).toContain('Section 1')
  })

  it('splits large sections on paragraph boundaries', () => {
    // Create text with one section that exceeds maxChunkSize
    const bigParagraph = 'A'.repeat(200)
    const paragraphs = Array.from({ length: 30 }, () => bigParagraph)
    const text = paragraphs.join('\n\n')
    const chunks = splitIntoChunks(text, 1000, 0)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      // Each chunk should be at most maxChunkSize (with some tolerance for sentence splits)
      expect(chunk.length).toBeLessThanOrEqual(1200)
    }
  })

  it('adds overlap between chunks when overlapSize > 0', () => {
    const text = `## Section 1\n${'A'.repeat(500)}\n\n## Section 2\n${'B'.repeat(500)}`
    const chunks = splitIntoChunks(text, 400, 50)
    expect(chunks.length).toBeGreaterThan(1)
    // Second chunk should contain overlap separator
    if (chunks.length > 1) {
      expect(chunks[1]).toContain('---')
    }
  })

  it('handles text without headings', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}. This is some content.`).join('\n\n')
    const chunks = splitIntoChunks(text, 200, 0)
    expect(chunks.length).toBeGreaterThan(1)
  })
})
