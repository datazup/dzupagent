import { describe, it, expect } from 'vitest'
import { splitIntoChunks } from '../chunking/split-into-chunks.js'
import { splitOnHeadings } from '../chunking/heading-chunker.js'
import { splitOnParagraphs } from '../chunking/paragraph-chunker.js'
import { splitOnSentences } from '../chunking/sentence-chunker.js'
import { addOverlap } from '../chunking/overlap.js'

// ---------------------------------------------------------------------------
// End-to-end chunking pipeline tests
// ---------------------------------------------------------------------------

describe('chunking pipeline: document to chunks', () => {
  it('processes a multi-section markdown document', () => {
    const doc = [
      '## Introduction',
      'This is the introduction to the document. It covers background information.',
      '',
      '## Methods',
      'We used a combination of approaches. First, we collected data from various sources.',
      'Then we analyzed the data using statistical methods.',
      '',
      '## Results',
      'The results show significant improvement. The accuracy increased by 20%.',
      '',
      '## Conclusion',
      'In conclusion, our approach is effective.',
    ].join('\n')

    const chunks = splitIntoChunks(doc, 200, 0)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // Each chunk should contain some text
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0)
    }
  })

  it('handles a document with only paragraphs (no headings)', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      `Paragraph ${i + 1}: ${'Lorem ipsum dolor sit amet. '.repeat(5)}`,
    )
    const doc = paragraphs.join('\n\n')

    const chunks = splitIntoChunks(doc, 300, 0)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('handles a document with very long sentences', () => {
    const longSentence = 'The quick brown fox jumps over the lazy dog and '.repeat(20) + 'runs away.'
    const doc = `${longSentence} ${longSentence}`

    const chunks = splitIntoChunks(doc, 500, 0)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
  })

  it('preserves content integrity: no text is lost', () => {
    const doc = '## Part A\nAlpha content.\n\n## Part B\nBeta content.'
    const chunks = splitIntoChunks(doc, 30, 0)

    const combined = chunks.join(' ')
    expect(combined).toContain('Alpha content')
    expect(combined).toContain('Beta content')
  })

  it('overlap chunks share context between sections', () => {
    const doc = '## Part 1\n' + 'X'.repeat(300) + '\n## Part 2\n' + 'Y'.repeat(300)
    const chunks = splitIntoChunks(doc, 200, 50)

    if (chunks.length > 1) {
      // Second chunk should have overlap separator
      expect(chunks[1]).toContain('---')
    }
  })

  it('handles single-line document', () => {
    const doc = 'Just a single line of text.'
    const chunks = splitIntoChunks(doc, 1000, 0)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(doc)
  })

  it('handles document with only headings', () => {
    const doc = '## Heading 1\n## Heading 2\n## Heading 3'
    const chunks = splitIntoChunks(doc, 1000, 0)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Additional heading chunker tests
// ---------------------------------------------------------------------------

describe('splitOnHeadings extended', () => {
  it('handles mixed heading levels (## and ###)', () => {
    const text = '## Main\nContent\n### Sub\nMore content\n## Another\nFinal'
    const parts = splitOnHeadings(text)
    expect(parts.length).toBeGreaterThanOrEqual(3)
  })

  it('handles text before any heading', () => {
    const text = 'Preamble text\n## First Section\nContent'
    const parts = splitOnHeadings(text)
    expect(parts[0]).toContain('Preamble text')
  })

  it('preserves newlines within sections', () => {
    const text = '## Section\nLine 1\nLine 2\nLine 3'
    const parts = splitOnHeadings(text)
    expect(parts[0]).toContain('Line 1')
    expect(parts[0]).toContain('Line 3')
  })
})

// ---------------------------------------------------------------------------
// Additional paragraph chunker tests
// ---------------------------------------------------------------------------

describe('splitOnParagraphs extended', () => {
  it('handles single very long paragraph', () => {
    const text = 'A'.repeat(500)
    const chunks = splitOnParagraphs(text, 100)
    // Single paragraph can't be split further by paragraph chunker
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(text)
  })

  it('merges adjacent small paragraphs optimally', () => {
    // 10 paragraphs of ~20 chars each, maxSize 50
    const paras = Array.from({ length: 10 }, (_, i) => `Paragraph number ${i}.`)
    const text = paras.join('\n\n')
    const chunks = splitOnParagraphs(text, 50)

    // Each chunk should try to merge as many paragraphs as fit
    for (const chunk of chunks) {
      // No chunk should be empty
      expect(chunk.trim().length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Additional sentence chunker tests
// ---------------------------------------------------------------------------

describe('splitOnSentences extended', () => {
  it('handles text with no sentence boundaries', () => {
    const text = 'No period here at all and the text just goes on and on'
    const chunks = splitOnSentences(text, 20)
    // Can't split on sentence boundaries, returns as-is
    expect(chunks).toHaveLength(1)
  })

  it('handles text with mixed punctuation', () => {
    const text = 'First sentence. Second? Third! Fourth.'
    const chunks = splitOnSentences(text, 20)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('handles consecutive punctuation', () => {
    const text = 'Really?! Yes. No.'
    const chunks = splitOnSentences(text, 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// Additional overlap tests
// ---------------------------------------------------------------------------

describe('addOverlap extended', () => {
  it('overlap separator is exactly \\n---\\n', () => {
    const chunks = ['First chunk.', 'Second chunk.']
    const result = addOverlap(chunks, 5)
    expect(result[1]).toContain('\n---\n')
  })

  it('handles three chunks correctly', () => {
    const chunks = ['AAAA AAAA', 'BBBB BBBB', 'CCCC CCCC']
    const result = addOverlap(chunks, 4)
    expect(result).toHaveLength(3)
    // First chunk unchanged
    expect(result[0]).toBe('AAAA AAAA')
    // Second gets overlap from first
    expect(result[1]).toMatch(/^AAAA/)
    // Third gets overlap from original second (not overlapped second)
    expect(result[2]).toMatch(/^BBBB/)
  })

  it('handles very small overlap size', () => {
    const chunks = ['Hello World', 'Goodbye World']
    const result = addOverlap(chunks, 1)
    expect(result[1]).toBe('d\n---\nGoodbye World')
  })
})
