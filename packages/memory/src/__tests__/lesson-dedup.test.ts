import { describe, it, expect } from 'vitest'
import { dedupLessons } from '../lesson-dedup.js'
import type { MemoryEntry } from '../consolidation-types.js'

function entry(key: string, text: string, extras?: Partial<MemoryEntry>): MemoryEntry {
  return { key, text, ...extras }
}

describe('dedupLessons', () => {
  it('should return empty result for empty input', () => {
    const result = dedupLessons([])
    expect(result.deduplicated).toHaveLength(0)
    expect(result.removedCount).toBe(0)
    expect(result.inputCount).toBe(0)
  })

  it('should keep a single entry unchanged', () => {
    const result = dedupLessons([entry('a', 'Always use TypeScript strict mode')])
    expect(result.deduplicated).toHaveLength(1)
    expect(result.deduplicated[0]!.count).toBe(1)
    expect(result.deduplicated[0]!.mergedKeys).toEqual(['a'])
    expect(result.removedCount).toBe(0)
  })

  it('should merge highly similar entries', () => {
    const lessons: MemoryEntry[] = [
      entry('a', 'Always use TypeScript strict mode for all projects'),
      entry('b', 'Always use TypeScript strict mode for every project'),
      entry('c', 'Something completely different about database migrations'),
    ]
    const result = dedupLessons(lessons, 0.6)

    // a and b are similar and should merge; c is different
    expect(result.deduplicated).toHaveLength(2)
    expect(result.removedCount).toBe(1)

    // Find the merged group
    const merged = result.deduplicated.find(d => d.count > 1)
    expect(merged).toBeDefined()
    expect(merged!.count).toBe(2)
    expect(merged!.mergedKeys).toContain('a')
    expect(merged!.mergedKeys).toContain('b')
  })

  it('should prefer the longest text as representative', () => {
    const lessons: MemoryEntry[] = [
      entry('short', 'use strict typescript mode for projects'),
      entry('long', 'use strict typescript mode for projects and all source files in the repo'),
    ]
    const result = dedupLessons(lessons, 0.4)

    expect(result.deduplicated).toHaveLength(1)
    expect(result.deduplicated[0]!.entry.key).toBe('long')
  })

  it('should not merge dissimilar entries', () => {
    const lessons: MemoryEntry[] = [
      entry('a', 'Use TypeScript strict mode'),
      entry('b', 'Database migration strategies for PostgreSQL'),
      entry('c', 'Vue 3 composition API best practices'),
    ]
    const result = dedupLessons(lessons, 0.6)

    expect(result.deduplicated).toHaveLength(3)
    expect(result.removedCount).toBe(0)
  })

  it('should merge multiple duplicates into one group', () => {
    const lessons: MemoryEntry[] = [
      entry('a', 'prefer named exports over default exports in typescript'),
      entry('b', 'use named exports instead of default exports in typescript'),
      entry('c', 'prefer named exports over default exports for typescript modules'),
      entry('d', 'unrelated: always validate input with zod schemas'),
    ]
    const result = dedupLessons(lessons, 0.5)

    // a, b, c should merge; d is separate
    expect(result.deduplicated).toHaveLength(2)
    const big = result.deduplicated.find(d => d.count >= 2)
    expect(big).toBeDefined()
    expect(big!.mergedKeys).toContain('a')
    expect(big!.mergedKeys).toContain('b')
  })

  it('should respect custom threshold', () => {
    const lessons: MemoryEntry[] = [
      entry('a', 'use strict mode'),
      entry('b', 'use strict typescript mode'),
    ]

    // Very high threshold — should not merge
    const strict = dedupLessons(lessons, 0.95)
    expect(strict.deduplicated).toHaveLength(2)

    // Low threshold — should merge
    const loose = dedupLessons(lessons, 0.3)
    expect(loose.deduplicated).toHaveLength(1)
  })

  it('should handle entries with identical text', () => {
    const lessons: MemoryEntry[] = [
      entry('a', 'exactly the same text'),
      entry('b', 'exactly the same text'),
    ]
    const result = dedupLessons(lessons)

    expect(result.deduplicated).toHaveLength(1)
    expect(result.deduplicated[0]!.count).toBe(2)
    expect(result.removedCount).toBe(1)
  })

  it('inputCount always equals original array length', () => {
    const lessons: MemoryEntry[] = [
      entry('a', 'foo bar baz'),
      entry('b', 'foo bar baz'),
      entry('c', 'qux quux'),
    ]
    const result = dedupLessons(lessons)
    expect(result.inputCount).toBe(3)
  })
})
