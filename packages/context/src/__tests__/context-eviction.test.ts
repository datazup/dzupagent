import { describe, it, expect } from 'vitest'
import { evictIfNeeded, type EvictionConfig } from '../context-eviction.js'

describe('evictIfNeeded', () => {
  // -----------------------------------------------------------------------
  // No eviction cases
  // -----------------------------------------------------------------------

  it('returns content unchanged when under the default token threshold', () => {
    const content = 'Hello world\nLine two\nLine three'
    const result = evictIfNeeded(content, 'test.ts')
    expect(result.evicted).toBe(false)
    expect(result.content).toBe(content)
    expect(result.originalLength).toBeUndefined()
    expect(result.lineCount).toBeUndefined()
  })

  it('returns content unchanged for empty string', () => {
    const result = evictIfNeeded('', 'empty.ts')
    expect(result.evicted).toBe(false)
    expect(result.content).toBe('')
  })

  it('does not evict content exactly at the threshold boundary', () => {
    // Default: 20_000 tokens * 4 chars/token = 80_000 chars
    // "< charThreshold" so exactly 80_000 - 1 should NOT trigger
    const content = 'x'.repeat(79_999)
    const result = evictIfNeeded(content, 'boundary.ts')
    expect(result.evicted).toBe(false)
  })

  // -----------------------------------------------------------------------
  // Eviction cases
  // -----------------------------------------------------------------------

  it('evicts content that exceeds the default token threshold', () => {
    // Default: 20_000 * 4 = 80_000 char threshold
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'x'.repeat(500)}`)
    const content = lines.join('\n')
    expect(content.length).toBeGreaterThan(80_000)

    const result = evictIfNeeded(content, 'large-file.ts')
    expect(result.evicted).toBe(true)
    expect(result.originalLength).toBe(content.length)
    expect(result.lineCount).toBe(200)
  })

  it('shows head and tail lines in the preview', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'data'.repeat(150)}`)
    const content = lines.join('\n')

    const result = evictIfNeeded(content, 'file.ts')
    expect(result.evicted).toBe(true)
    // Default headLines=50, tailLines=20
    expect(result.content).toContain('First 50 lines')
    expect(result.content).toContain('Last 20 lines')
    expect(result.content).toContain('Line 0:')
    expect(result.content).toContain('Line 199:')
  })

  it('includes the omitted line count', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'data'.repeat(150)}`)
    const content = lines.join('\n')

    const result = evictIfNeeded(content, 'file.ts')
    // 200 lines - 50 head - 20 tail = 130 omitted
    expect(result.content).toContain('130 lines omitted')
  })

  it('includes a read_file hint with the identifier', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'data'.repeat(150)}`)
    const content = lines.join('\n')

    const result = evictIfNeeded(content, 'src/components/App.tsx')
    expect(result.content).toContain('read_file("src/components/App.tsx"')
  })

  it('includes the token estimate in the preview header', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'data'.repeat(150)}`)
    const content = lines.join('\n')

    const result = evictIfNeeded(content, 'file.ts')
    expect(result.content).toContain('Content truncated')
    expect(result.content).toContain('200 lines')
    expect(result.content).toContain('tokens')
  })

  // -----------------------------------------------------------------------
  // Custom config
  // -----------------------------------------------------------------------

  it('respects custom tokenThreshold', () => {
    // Set a low threshold: 100 tokens * 4 chars = 400 chars
    const content = 'x'.repeat(500)
    const result = evictIfNeeded(content, 'small.ts', { tokenThreshold: 100 })
    expect(result.evicted).toBe(true)
  })

  it('respects custom charsPerToken', () => {
    // 20_000 tokens * 2 chars/token = 40_000 char threshold
    const content = 'x'.repeat(50_000)
    const result = evictIfNeeded(content, 'test.ts', { charsPerToken: 2 })
    expect(result.evicted).toBe(true)
  })

  it('respects custom headLines and tailLines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${'data'.repeat(200)}`)
    const content = lines.join('\n')

    const result = evictIfNeeded(content, 'file.ts', {
      tokenThreshold: 100,
      headLines: 10,
      tailLines: 5,
    })
    expect(result.evicted).toBe(true)
    expect(result.content).toContain('First 10 lines')
    expect(result.content).toContain('Last 5 lines')
    // 100 - 10 - 5 = 85 omitted
    expect(result.content).toContain('85 lines omitted')
  })

  it('handles content with fewer lines than headLines + tailLines', () => {
    // Content that is character-wise large but has few lines
    const lines = Array.from({ length: 5 }, (_, i) => `Line ${i}: ${'x'.repeat(20_000)}`)
    const content = lines.join('\n')

    const result = evictIfNeeded(content, 'wide.ts')
    expect(result.evicted).toBe(true)
    // headLines=50, tailLines=20, but only 5 lines
    // head = all 5 lines (slice(0, 50) of 5 is 5)
    // tail = all 5 lines (slice(-20) of 5 is 5)
    // omitted = max(0, 5 - 50 - 20) = 0
    expect(result.content).toContain('0 lines omitted')
  })

  it('handles single-line content that exceeds threshold', () => {
    const content = 'x'.repeat(100_000)
    const result = evictIfNeeded(content, 'one-liner.ts')
    expect(result.evicted).toBe(true)
    expect(result.lineCount).toBe(1)
  })

  it('partial config merges with defaults', () => {
    // Only override headLines, keep defaults for everything else
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'data'.repeat(150)}`)
    const content = lines.join('\n')

    const result = evictIfNeeded(content, 'file.ts', { headLines: 5 })
    expect(result.content).toContain('First 5 lines')
    // tailLines should still be default 20
    expect(result.content).toContain('Last 20 lines')
  })
})
