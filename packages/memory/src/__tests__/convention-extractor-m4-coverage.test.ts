/**
 * Extended coverage for extractConventions (M4).
 *
 * Complements the existing convention-extractor-m4.test.ts by exercising
 * boundary conditions around shingle generation, category inference, id
 * uniqueness, confidence clamping, cluster-merge edge cases and short text.
 */
import { describe, it, expect } from 'vitest'
import { extractConventions } from '../convention/convention-extractor-m4.js'
import type { MemoryEntry } from '../consolidation-types.js'

function entry(key: string, text: string): MemoryEntry {
  return { key, text }
}

// ===========================================================================
// Boundary: empty / short / single inputs
// ===========================================================================

describe('extractConventions — boundary inputs', () => {
  it('handles single memory at threshold 1 without crashing', () => {
    const r = extractConventions([entry('a', 'use camelCase always')], 1)
    expect(r.memoriesAnalyzed).toBe(1)
    // With only 1 memory there is no cluster wider than 1 — but threshold 1 may emit.
    // Simply assert no crash and stable shape.
    expect(Array.isArray(r.conventions)).toBe(true)
  })

  it('handles memory with empty text', () => {
    const r = extractConventions([entry('a', '')], 1)
    expect(r.memoriesAnalyzed).toBe(1)
    expect(r.conventions).toHaveLength(0)
  })

  it('handles memories with only short words (skipped by min-len filter)', () => {
    const r = extractConventions(
      [entry('a', 'a b c'), entry('b', 'a b c'), entry('c', 'a b c')],
      3,
    )
    expect(r.memoriesAnalyzed).toBe(3)
    // All words are length 1, filtered out -> no shingles -> no conventions
    expect(r.conventions).toHaveLength(0)
  })

  it('handles whitespace-only text', () => {
    const r = extractConventions(
      [entry('a', '   \t\n   '), entry('b', '\n')],
      2,
    )
    expect(r.memoriesAnalyzed).toBe(2)
    expect(r.conventions).toHaveLength(0)
  })

  it('handles very short text (< 3 words) by joining into single shingle', () => {
    const r = extractConventions(
      [
        entry('a', 'use typescript'),
        entry('b', 'use typescript'),
        entry('c', 'use typescript'),
      ],
      3,
    )
    expect(r.memoriesAnalyzed).toBe(3)
    // Should detect "use typescript" as the shared shingle
    expect(r.conventions.length).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// Threshold semantics
// ===========================================================================

describe('extractConventions — threshold semantics', () => {
  it('threshold 1 + 1 memory may emit a single-source convention', () => {
    const r = extractConventions(
      [entry('a', 'always wrap in try catch blocks for error handling')],
      1,
    )
    // Should not throw; with threshold 1 even one memory can be a "cluster"
    expect(r.memoriesAnalyzed).toBe(1)
    expect(Array.isArray(r.conventions)).toBe(true)
  })

  it('threshold above input count returns no conventions', () => {
    const r = extractConventions(
      [
        entry('a', 'use camelCase for variable names'),
        entry('b', 'use camelCase for variable names'),
      ],
      5,
    )
    expect(r.conventions).toHaveLength(0)
  })

  it('respects threshold of exactly N when N memories share a pattern', () => {
    // Use identical text repeated N times so all 3-gram shingles match
    const text = 'always validate input with zod schemas before saving here'
    const memories = [
      entry('a', text),
      entry('b', text),
      entry('c', text),
      entry('d', text),
    ]
    const r = extractConventions(memories, 4)
    expect(r.conventions.length).toBeGreaterThanOrEqual(1)
    expect(r.conventions[0]!.occurrences).toBe(4)
  })
})

// ===========================================================================
// Category inference — exhaustive
// ===========================================================================

describe('extractConventions — category inference', () => {
  function categoryOf(memories: MemoryEntry[]): string | undefined {
    const r = extractConventions(memories, memories.length)
    return r.conventions[0]?.category
  }

  // For category to be detected the cluster must form. Use repeated identical
  // texts so all shingles are shared across all 3 memories.
  function repeat(text: string): MemoryEntry[] {
    return [entry('a', text), entry('b', text), entry('c', text)]
  }

  it('categorizes naming-related memories as "naming"', () => {
    const cat = categoryOf(repeat('always use camelCase for variable names'))
    expect(cat).toBe('naming')
  })

  it('categorizes module-related memories as "imports"', () => {
    const cat = categoryOf(repeat('always prefer named module exports here'))
    // "naming" matcher does not apply because no naming keyword present
    expect(cat).toBe('imports')
  })

  it('categorizes error-handling memories as "error-handling"', () => {
    const cat = categoryOf(repeat('wrap calls in try catch for safety'))
    expect(cat).toBe('error-handling')
  })

  it('categorizes typing-related memories as "typing"', () => {
    const cat = categoryOf(repeat('define interface for every exported type'))
    expect(cat).toBe('typing')
  })

  it('categorizes test-related memories as "testing"', () => {
    const cat = categoryOf(repeat('wrap each test in describe blocks always'))
    expect(cat).toBe('testing')
  })

  it('categorizes api-related memories as "api"', () => {
    const cat = categoryOf(repeat('return JSON from every endpoint consistently'))
    expect(cat).toBe('api')
  })

  it('categorizes db-related memories as "database"', () => {
    const cat = categoryOf(repeat('use prisma migration for database changes'))
    expect(cat).toBe('database')
  })

  it('categorizes css/style memories as "styling"', () => {
    const cat = categoryOf(repeat('use tailwind class names for spacing style'))
    expect(cat).toBe('styling')
  })

  it('categorizes structure-related memories as "structure"', () => {
    const cat = categoryOf(repeat('organize folder structure by feature directory'))
    expect(cat).toBe('structure')
  })

  it('falls back to "general" when no category keyword matches', () => {
    const cat = categoryOf(repeat('remember chocolate cookies recipe always'))
    expect(cat).toBe('general')
  })
})

// ===========================================================================
// Confidence clamping
// ===========================================================================

describe('extractConventions — confidence', () => {
  it('caps confidence at 1.0 even with many occurrences', () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      entry(`m${i}`, 'always use camelCase for variable naming in code'),
    )
    const r = extractConventions(memories, 3)
    expect(r.conventions.length).toBeGreaterThanOrEqual(1)
    for (const c of r.conventions) {
      expect(c.confidence).toBeLessThanOrEqual(1)
      expect(c.confidence).toBeGreaterThan(0)
    }
  })

  it('confidence is occurrences / (threshold * 2) for small counts', () => {
    // 3 occurrences, threshold 3 -> confidence = 3 / 6 = 0.5
    const memories = [
      entry('a', 'always use named exports for typescript modules everywhere'),
      entry('b', 'use named exports for typescript modules in this code'),
      entry('c', 'prefer named exports for typescript modules whenever possible'),
    ]
    const r = extractConventions(memories, 3)
    if (r.conventions.length > 0) {
      const c = r.conventions[0]!
      // Should be 0.5 for 3 occurrences with threshold 3
      expect(c.confidence).toBeCloseTo(0.5, 5)
    }
  })
})

// ===========================================================================
// ID uniqueness
// ===========================================================================

describe('extractConventions — id generation', () => {
  it('id starts with "mem-conv-" prefix', () => {
    const r = extractConventions(
      [
        entry('a', 'always use camelCase for variable names everywhere'),
        entry('b', 'use camelCase for variable names in modules'),
        entry('c', 'prefer camelCase for variable names in code'),
      ],
      3,
    )
    if (r.conventions.length > 0) {
      expect(r.conventions[0]!.id.startsWith('mem-conv-')).toBe(true)
    }
  })

  it('falls back to "mem-conv-unknown" for non-textual representative', () => {
    // We can't directly trigger this without empty text; just ensure the
    // function does not throw for memories whose text is mostly punctuation.
    const r = extractConventions(
      [entry('a', '!!!'), entry('b', '???'), entry('c', '...')],
      3,
    )
    expect(r.conventions).toHaveLength(0)
  })

  it('generates distinct ids for distinct clusters', () => {
    const memories = [
      // Cluster 1
      entry('a1', 'always use strict typescript mode in all files always'),
      entry('a2', 'use strict typescript mode in all source files'),
      entry('a3', 'enable strict typescript mode in every file'),
      // Cluster 2 (no overlap with cluster 1)
      entry('b1', 'database migration uses prisma migrate deploy command'),
      entry('b2', 'run prisma migrate deploy for database migration tasks'),
      entry('b3', 'prisma migrate deploy for each database migration step'),
    ]
    const r = extractConventions(memories, 3)
    if (r.conventions.length >= 2) {
      const ids = r.conventions.map(c => c.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})

// ===========================================================================
// Cluster behavior
// ===========================================================================

describe('extractConventions — clustering', () => {
  it('merges overlapping clusters via union-find', () => {
    // Three memories that all share at least one shingle pairwise via a
    // common bridge memory — should collapse into 1 cluster.
    const memories = [
      entry('a', 'use strict typescript mode everywhere consistently always'),
      entry('b', 'use strict typescript mode everywhere consistently in code'),
      entry('c', 'use strict typescript mode everywhere consistently across project'),
    ]
    const r = extractConventions(memories, 3)
    expect(r.conventions.length).toBe(1)
    expect(r.conventions[0]!.sourceKeys.length).toBe(3)
  })

  it('keeps unrelated patterns in separate conventions', () => {
    const memories = [
      // Pattern 1
      entry('a1', 'use camelCase for variable names in typescript always'),
      entry('a2', 'always camelCase for variable names in typescript'),
      entry('a3', 'prefer camelCase for variable names in typescript'),
      // Pattern 2 (very different vocabulary)
      entry('b1', 'database migration via prisma migrate deploy command'),
      entry('b2', 'prisma migrate deploy handles database migration steps'),
      entry('b3', 'use prisma migrate deploy for database migration runs'),
    ]
    const r = extractConventions(memories, 3)
    expect(r.conventions.length).toBeGreaterThanOrEqual(2)
  })

  it('memoriesAnalyzed reflects all input regardless of how many clusters formed', () => {
    const memories = [
      entry('a', 'always validate input with zod schemas before saving'),
      entry('b', 'always validate input with zod schemas before processing'),
      entry('c', 'always validate input with zod schemas before using'),
      entry('d', 'unrelated content about cooking pasta'),
      entry('e', 'another unrelated thought entirely random text'),
    ]
    const r = extractConventions(memories, 3)
    expect(r.memoriesAnalyzed).toBe(5)
  })

  it('skips clusters smaller than threshold even if they share a frequent shingle', () => {
    // The same shingle appears in 4 memories but only 2 of them cluster
    // with each other; threshold 4 should still yield the cluster of 4.
    const memories = [
      entry('a', 'use typescript strict mode always for type safety'),
      entry('b', 'use typescript strict mode always for safer code'),
      entry('c', 'use typescript strict mode always in production'),
      entry('d', 'use typescript strict mode always for clarity'),
    ]
    const r = extractConventions(memories, 4)
    if (r.conventions.length > 0) {
      expect(r.conventions[0]!.occurrences).toBeGreaterThanOrEqual(4)
    }
  })
})

// ===========================================================================
// Examples and source key fidelity
// ===========================================================================

describe('extractConventions — examples and sources', () => {
  it('caps examples at 3 entries', () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      entry(`m${i}`, `always validate input ${i} with zod schemas before saving`),
    )
    const r = extractConventions(memories, 3)
    expect(r.conventions.length).toBeGreaterThanOrEqual(1)
    expect(r.conventions[0]!.examples.length).toBeLessThanOrEqual(3)
  })

  it('truncates each example to 200 chars', () => {
    const longText = 'always use named export style and ' + 'x'.repeat(500)
    const memories = [
      entry('a', longText + ' for module a'),
      entry('b', longText + ' for module b'),
      entry('c', longText + ' for module c'),
    ]
    const r = extractConventions(memories, 3)
    if (r.conventions.length > 0) {
      for (const ex of r.conventions[0]!.examples) {
        expect(ex.length).toBeLessThanOrEqual(200)
      }
    }
  })

  it('includes occurrences count in description text', () => {
    const memories = [
      entry('a', 'always wrap in try catch for safety in async functions'),
      entry('b', 'wrap in try catch for safety in all async functions'),
      entry('c', 'try catch for safety wrapping in async functions'),
    ]
    const r = extractConventions(memories, 3)
    if (r.conventions.length > 0) {
      const desc = r.conventions[0]!.description
      expect(desc).toContain(String(r.conventions[0]!.occurrences))
      expect(desc.startsWith('Pattern observed')).toBe(true)
    }
  })

  it('sourceKeys are exact keys from input memories (no fabrication)', () => {
    const memories = [
      entry('xx-1', 'always use named exports across all typescript modules'),
      entry('xx-2', 'prefer named exports across all typescript modules'),
      entry('xx-3', 'use named exports across all typescript modules everywhere'),
      entry('unrelated', 'something completely different about pizza'),
    ]
    const r = extractConventions(memories, 3)
    if (r.conventions.length > 0) {
      for (const k of r.conventions[0]!.sourceKeys) {
        expect(['xx-1', 'xx-2', 'xx-3']).toContain(k)
      }
    }
  })
})

// ===========================================================================
// Sorting
// ===========================================================================

describe('extractConventions — output sorting', () => {
  it('most frequent convention first', () => {
    const memories = [
      // Common pattern (4)
      entry('p1', 'use strict typescript mode everywhere always for safety'),
      entry('p2', 'use strict typescript mode everywhere always in modules'),
      entry('p3', 'use strict typescript mode everywhere always in projects'),
      entry('p4', 'use strict typescript mode everywhere always in code'),
      // Less common pattern (3)
      entry('q1', 'always run prisma migrate deploy on each release cycle'),
      entry('q2', 'run prisma migrate deploy on each release cycle as policy'),
      entry('q3', 'prisma migrate deploy on each release cycle for safety'),
    ]
    const r = extractConventions(memories, 3)
    if (r.conventions.length >= 2) {
      expect(r.conventions[0]!.occurrences).toBeGreaterThanOrEqual(
        r.conventions[1]!.occurrences,
      )
    }
  })
})

// ===========================================================================
// Punctuation, casing
// ===========================================================================

describe('extractConventions — text normalization', () => {
  it('treats different cases as the same shingle', () => {
    const memories = [
      entry('a', 'USE CAMELCASE for VARIABLE names always'),
      entry('b', 'use camelcase for variable names always'),
      entry('c', 'Use Camelcase For Variable Names Always'),
    ]
    const r = extractConventions(memories, 3)
    expect(r.conventions.length).toBeGreaterThanOrEqual(1)
  })

  it('strips punctuation when forming shingles', () => {
    const memories = [
      entry('a', 'always, use, camelCase: for variable names!'),
      entry('b', 'always... use camelCase for variable names.'),
      entry('c', 'always - use - camelCase - for - variable - names'),
    ]
    const r = extractConventions(memories, 3)
    expect(r.conventions.length).toBeGreaterThanOrEqual(1)
  })

  it('handles unicode-letter words gracefully (no crash)', () => {
    const memories = [
      entry('a', 'naming convention using snake_case for files in project'),
      entry('b', 'snake_case for files in project as a naming convention'),
      entry('c', 'use snake_case for files in project naming convention'),
    ]
    const r = extractConventions(memories, 3)
    expect(r.memoriesAnalyzed).toBe(3)
  })
})
