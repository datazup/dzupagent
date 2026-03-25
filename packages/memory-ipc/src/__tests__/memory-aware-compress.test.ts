import { describe, it, expect } from 'vitest'
import { FrameBuilder } from '../frame-builder.js'
import type { FrameRecordMeta, FrameRecordValue } from '../frame-builder.js'
import { batchOverlapAnalysis } from '../memory-aware-compress.js'

function buildTable(
  records: Array<{
    id: string
    text: string
    namespace?: string
  }>,
) {
  const builder = new FrameBuilder()
  for (const r of records) {
    const value: FrameRecordValue = { text: r.text }
    const meta: FrameRecordMeta = {
      id: r.id,
      namespace: r.namespace ?? 'test',
      key: r.id,
    }
    builder.add(value, meta)
  }
  return builder.build()
}

describe('batchOverlapAnalysis', () => {
  it('no existing memories: all novel', () => {
    const memoryTable = buildTable([])
    const observations = [
      'The user prefers dark mode themes',
      'TypeScript strict mode is required',
    ]

    const result = batchOverlapAnalysis(observations, memoryTable)

    expect(result.novel.length).toBe(2)
    expect(result.duplicate.length).toBe(0)
    expect(result.novel[0]?.text).toBe('The user prefers dark mode themes')
    expect(result.novel[1]?.text).toBe('TypeScript strict mode is required')
    expect(result.novel[0]?.index).toBe(0)
    expect(result.novel[1]?.index).toBe(1)
  })

  it('exact match: marked duplicate', () => {
    const text = 'Always use ESM modules with type module in package json'
    const memoryTable = buildTable([
      { id: 'mem0', text },
    ])

    const result = batchOverlapAnalysis([text], memoryTable)

    expect(result.novel.length).toBe(0)
    expect(result.duplicate.length).toBe(1)
    expect(result.duplicate[0]?.similarity).toBe(1.0)
    expect(result.duplicate[0]?.existingRowIndex).toBe(0)
  })

  it('high overlap: marked duplicate above threshold', () => {
    const memoryTable = buildTable([
      { id: 'mem0', text: 'Use TypeScript strict mode with no any types allowed' },
    ])
    // Very similar observation (only minor word changes)
    const observations = [
      'Use TypeScript strict mode with no any types permitted',
    ]

    const result = batchOverlapAnalysis(observations, memoryTable, 0.7)

    expect(result.duplicate.length).toBe(1)
    expect(result.duplicate[0]?.similarity).toBeGreaterThanOrEqual(0.7)
  })

  it('below threshold: marked novel', () => {
    const memoryTable = buildTable([
      { id: 'mem0', text: 'Use PostgreSQL for the database layer' },
    ])
    const observations = [
      'Configure Redis for caching with TTL expiration policies',
    ]

    const result = batchOverlapAnalysis(observations, memoryTable, 0.8)

    expect(result.novel.length).toBe(1)
    expect(result.duplicate.length).toBe(0)
  })

  it('mixed: some novel, some duplicate', () => {
    const memoryTable = buildTable([
      { id: 'mem0', text: 'Always use strict TypeScript with no any types' },
      { id: 'mem1', text: 'Deploy with Docker containers using multi stage builds' },
    ])
    const observations = [
      'Always use strict TypeScript with no any types', // exact dup of mem0
      'Vue 3 composition API with script setup syntax', // novel
      'Deploy with Docker containers using multi stage builds', // exact dup of mem1
    ]

    const result = batchOverlapAnalysis(observations, memoryTable)

    expect(result.duplicate.length).toBe(2)
    expect(result.novel.length).toBe(1)
    expect(result.novel[0]?.text).toContain('Vue 3')
  })

  it('performance: 50 observations x 100 memories completes quickly', () => {
    const memories = Array.from({ length: 100 }, (_, i) => ({
      id: `mem${i}`,
      text: `Memory record number ${i} with some additional text content for padding purposes to simulate real data`,
    }))
    const memoryTable = buildTable(memories)

    const observations = Array.from({ length: 50 }, (_, i) =>
      `Observation number ${i} with unique text content that should not match existing memories`,
    )

    const result = batchOverlapAnalysis(observations, memoryTable)

    // Should complete in reasonable time (< 5 seconds)
    expect(result.analysisMs).toBeLessThan(5000)
    // All should be novel since texts are different
    expect(result.novel.length).toBe(50)
    expect(result.duplicate.length).toBe(0)
  })

  it('custom threshold changes sensitivity', () => {
    const memoryTable = buildTable([
      { id: 'mem0', text: 'one two three four five six seven eight nine ten' },
    ])
    const observations = [
      // shares about half the words
      'one two three four five alpha beta gamma delta epsilon',
    ]

    // With low threshold, it's a duplicate
    const lowThreshold = batchOverlapAnalysis(observations, memoryTable, 0.3)
    expect(lowThreshold.duplicate.length).toBe(1)

    // With high threshold, it's novel
    const highThreshold = batchOverlapAnalysis(observations, memoryTable, 0.9)
    expect(highThreshold.novel.length).toBe(1)
  })

  it('handles empty observations array', () => {
    const memoryTable = buildTable([{ id: 'mem0', text: 'some text' }])
    const result = batchOverlapAnalysis([], memoryTable)

    expect(result.novel.length).toBe(0)
    expect(result.duplicate.length).toBe(0)
  })

  it('preserves original index in results', () => {
    const memoryTable = buildTable([
      { id: 'mem0', text: 'exact match text here' },
    ])
    const observations = [
      'completely different observation',
      'exact match text here',
      'another different one',
    ]

    const result = batchOverlapAnalysis(observations, memoryTable)

    expect(result.novel.length).toBe(2)
    expect(result.duplicate.length).toBe(1)
    expect(result.duplicate[0]?.index).toBe(1)
    expect(result.novel.map((n) => n.index).sort()).toEqual([0, 2])
  })
})
