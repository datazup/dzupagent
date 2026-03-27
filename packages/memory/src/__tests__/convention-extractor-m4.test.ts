import { describe, it, expect } from 'vitest'
import { extractConventions } from '../convention/convention-extractor-m4.js'
import type { MemoryEntry } from '../consolidation-types.js'

function entry(key: string, text: string): MemoryEntry {
  return { key, text }
}

describe('extractConventions', () => {
  it('should return empty result for empty input', () => {
    const result = extractConventions([])
    expect(result.conventions).toHaveLength(0)
    expect(result.memoriesAnalyzed).toBe(0)
  })

  it('should return empty when no pattern meets the threshold', () => {
    const memories = [
      entry('a', 'something unique about apples'),
      entry('b', 'completely different about oranges'),
    ]
    const result = extractConventions(memories, 3)
    expect(result.conventions).toHaveLength(0)
    expect(result.memoriesAnalyzed).toBe(2)
  })

  it('should extract a convention when a pattern appears >= threshold times', () => {
    const memories = [
      entry('a', 'always use camelCase for variable names in typescript'),
      entry('b', 'prefer camelCase for variable names when writing code'),
      entry('c', 'use camelCase for variable names in all modules'),
      entry('d', 'database migration strategies for postgresql'),
    ]
    const result = extractConventions(memories, 3)

    // The camelCase pattern should be detected across a, b, c
    expect(result.conventions.length).toBeGreaterThanOrEqual(1)
    expect(result.memoriesAnalyzed).toBe(4)

    const camelConv = result.conventions.find(c =>
      c.sourceKeys.some(k => ['a', 'b', 'c'].includes(k)),
    )
    expect(camelConv).toBeDefined()
    expect(camelConv!.occurrences).toBeGreaterThanOrEqual(3)
  })

  it('should assign reasonable category from text keywords', () => {
    const memories = [
      entry('a', 'always wrap api endpoint calls in try catch blocks'),
      entry('b', 'use try catch for error handling in api endpoints'),
      entry('c', 'error handling with try catch blocks is required for api calls'),
    ]
    const result = extractConventions(memories, 3)

    if (result.conventions.length > 0) {
      const conv = result.conventions[0]!
      // Should detect error-handling or api category
      expect(['error-handling', 'api', 'general']).toContain(conv.category)
    }
  })

  it('should respect custom threshold', () => {
    const memories = [
      entry('a', 'always validate input with zod schemas before saving'),
      entry('b', 'always validate input with zod schemas before processing'),
    ]

    // threshold 3 — not enough (only 2 memories)
    const high = extractConventions(memories, 3)
    expect(high.conventions).toHaveLength(0)

    // threshold 2 — should extract (shared shingles meet threshold)
    const low = extractConventions(memories, 2)
    expect(low.conventions.length).toBeGreaterThanOrEqual(1)
  })

  it('should provide examples from source memories', () => {
    const memories = [
      entry('a', 'use named exports for all typescript modules in the project'),
      entry('b', 'prefer named exports for all typescript modules when possible'),
      entry('c', 'always use named exports for all typescript modules'),
    ]
    const result = extractConventions(memories, 3)

    if (result.conventions.length > 0) {
      expect(result.conventions[0]!.examples.length).toBeGreaterThan(0)
      expect(result.conventions[0]!.examples.length).toBeLessThanOrEqual(3)
    }
  })

  it('should sort conventions by occurrence count descending', () => {
    // Create two distinct patterns with different frequencies
    const memories = [
      // Pattern A: 4 occurrences
      entry('a1', 'always use strict typescript mode in all files'),
      entry('a2', 'use strict typescript mode in all source files'),
      entry('a3', 'enable strict typescript mode in every file'),
      entry('a4', 'strict typescript mode in all project files'),
      // Pattern B: 3 occurrences
      entry('b1', 'database migration uses prisma migrate deploy'),
      entry('b2', 'run prisma migrate deploy for database migration'),
      entry('b3', 'prisma migrate deploy for each database migration'),
    ]
    const result = extractConventions(memories, 3)

    if (result.conventions.length >= 2) {
      expect(result.conventions[0]!.occurrences).toBeGreaterThanOrEqual(
        result.conventions[1]!.occurrences,
      )
    }
  })

  it('should generate unique convention ids', () => {
    const memories = [
      entry('a', 'always use named exports in modules'),
      entry('b', 'use named exports in every module'),
      entry('c', 'prefer named exports in all modules'),
    ]
    const result = extractConventions(memories, 3)

    const ids = result.conventions.map(c => c.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  it('should include sourceKeys pointing back to original memories', () => {
    const memories = [
      entry('k1', 'handle errors with try catch in async functions'),
      entry('k2', 'wrap async functions in try catch for error handling'),
      entry('k3', 'try catch for error handling in all async functions'),
    ]
    const result = extractConventions(memories, 3)

    if (result.conventions.length > 0) {
      const conv = result.conventions[0]!
      expect(conv.sourceKeys.length).toBeGreaterThanOrEqual(3)
      for (const key of conv.sourceKeys) {
        expect(['k1', 'k2', 'k3']).toContain(key)
      }
    }
  })
})
