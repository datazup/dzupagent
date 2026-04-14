import { describe, it, expect } from 'vitest'
import { splitOnHeadings } from '../chunking/heading-chunker.js'
import { splitOnParagraphs } from '../chunking/paragraph-chunker.js'
import { splitOnSentences } from '../chunking/sentence-chunker.js'
import { addOverlap } from '../chunking/overlap.js'

// ---------------------------------------------------------------------------
// splitOnHeadings
// ---------------------------------------------------------------------------

describe('splitOnHeadings', () => {
  it('splits on ## headings', () => {
    const text = '## First\nContent A\n## Second\nContent B'
    const parts = splitOnHeadings(text)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toContain('## First')
    expect(parts[1]).toContain('## Second')
  })

  it('splits on ### headings', () => {
    const text = '### Sub 1\nA\n### Sub 2\nB'
    const parts = splitOnHeadings(text)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toContain('### Sub 1')
    expect(parts[1]).toContain('### Sub 2')
  })

  it('does not split on # (h1) headings', () => {
    const text = '# Title\nIntro paragraph\n## Section\nBody'
    const parts = splitOnHeadings(text)
    // h1 is not a split boundary, so "# Title\nIntro paragraph\n" stays with first part
    expect(parts.length).toBeGreaterThanOrEqual(1)
    expect(parts[0]).toContain('# Title')
  })

  it('returns single element for text without headings', () => {
    const text = 'Just a paragraph with no headings at all.'
    const parts = splitOnHeadings(text)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toBe(text)
  })

  it('returns empty array for empty/whitespace text', () => {
    expect(splitOnHeadings('')).toEqual([])
    expect(splitOnHeadings('   ')).toEqual([])
  })

  it('keeps heading with its body content', () => {
    const text = '## Heading\nLine 1\nLine 2\n## Next\nLine 3'
    const parts = splitOnHeadings(text)
    expect(parts[0]).toContain('Line 1')
    expect(parts[0]).toContain('Line 2')
    expect(parts[1]).toContain('Line 3')
  })

  it('handles consecutive headings with no body', () => {
    const text = '## A\n## B\n## C'
    const parts = splitOnHeadings(text)
    expect(parts).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// splitOnParagraphs
// ---------------------------------------------------------------------------

describe('splitOnParagraphs', () => {
  it('merges short paragraphs into one chunk', () => {
    const text = 'Para 1\n\nPara 2\n\nPara 3'
    const chunks = splitOnParagraphs(text, 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('Para 1')
    expect(chunks[0]).toContain('Para 3')
  })

  it('splits when paragraphs exceed maxSize', () => {
    const p1 = 'A'.repeat(100)
    const p2 = 'B'.repeat(100)
    const p3 = 'C'.repeat(100)
    const text = `${p1}\n\n${p2}\n\n${p3}`
    const chunks = splitOnParagraphs(text, 150)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('handles single paragraph', () => {
    const text = 'One single paragraph'
    const chunks = splitOnParagraphs(text, 100)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(text)
  })

  it('returns empty array for empty string', () => {
    const chunks = splitOnParagraphs('', 100)
    expect(chunks).toEqual([])
  })

  it('handles multiple consecutive newlines as one boundary', () => {
    const text = 'First\n\n\n\nSecond'
    const chunks = splitOnParagraphs(text, 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('First')
    expect(chunks[0]).toContain('Second')
  })

  it('each chunk respects maxSize when paragraphs are small', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} content here.`)
    const text = paragraphs.join('\n\n')
    const chunks = splitOnParagraphs(text, 60)
    for (const chunk of chunks) {
      // Individual paragraphs are under 30 chars, so merged pairs should fit
      expect(chunk.length).toBeLessThanOrEqual(60 + 30) // tolerance for a single paragraph that doesn't fit cleanly
    }
  })
})

// ---------------------------------------------------------------------------
// splitOnSentences
// ---------------------------------------------------------------------------

describe('splitOnSentences', () => {
  it('merges short sentences into one chunk', () => {
    const text = 'Hello. World. Test.'
    const chunks = splitOnSentences(text, 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(text)
  })

  it('splits when sentences exceed maxSize', () => {
    const s1 = 'A'.repeat(50) + '.'
    const s2 = 'B'.repeat(50) + '.'
    const s3 = 'C'.repeat(50) + '.'
    const text = `${s1} ${s2} ${s3}`
    const chunks = splitOnSentences(text, 60)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('handles single sentence', () => {
    const text = 'Just one sentence.'
    const chunks = splitOnSentences(text, 100)
    expect(chunks).toHaveLength(1)
  })

  it('preserves oversized single sentence as-is', () => {
    const longSentence = 'A'.repeat(200) + '.'
    const chunks = splitOnSentences(longSentence, 50)
    // The sentence is too long but there is no way to split further
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(longSentence)
  })

  it('splits on exclamation marks', () => {
    const text = 'Wow! Amazing! Incredible!'
    const chunks = splitOnSentences(text, 6)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('splits on question marks', () => {
    const text = 'What? Really? Yes!'
    const chunks = splitOnSentences(text, 7)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('returns empty array for empty string', () => {
    const chunks = splitOnSentences('', 100)
    expect(chunks).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// addOverlap
// ---------------------------------------------------------------------------

describe('addOverlap', () => {
  it('returns empty array for empty input', () => {
    expect(addOverlap([], 50)).toEqual([])
  })

  it('returns single chunk unchanged', () => {
    const chunks = ['Only chunk']
    expect(addOverlap(chunks, 50)).toEqual(['Only chunk'])
  })

  it('prepends overlap from previous chunk to subsequent chunks', () => {
    const chunks = ['First chunk content', 'Second chunk content']
    const result = addOverlap(chunks, 5)
    expect(result).toHaveLength(2)
    expect(result[0]).toBe('First chunk content')
    // The last 5 chars of first chunk are "ntent"
    expect(result[1]).toContain('ntent')
    expect(result[1]).toContain('---')
    expect(result[1]).toContain('Second chunk content')
  })

  it('handles overlap larger than previous chunk', () => {
    const chunks = ['Hi', 'There']
    const result = addOverlap(chunks, 100)
    expect(result).toHaveLength(2)
    expect(result[1]).toContain('Hi')
    expect(result[1]).toContain('There')
  })

  it('applies overlap to each consecutive pair', () => {
    const chunks = ['AAAA', 'BBBB', 'CCCC']
    const result = addOverlap(chunks, 2)
    expect(result).toHaveLength(3)
    expect(result[0]).toBe('AAAA')
    expect(result[1]).toContain('AA') // last 2 of AAAA
    expect(result[1]).toContain('BBBB')
    // Overlap for chunk 3 comes from the *original* chunks[1], which is 'BBBB'
    expect(result[2]).toContain('BB')
    expect(result[2]).toContain('CCCC')
  })

  it('uses zero overlap without error', () => {
    const chunks = ['A', 'B']
    const result = addOverlap(chunks, 0)
    expect(result).toHaveLength(2)
    expect(result[0]).toBe('A')
    expect(result[1]).toContain('B')
  })
})
