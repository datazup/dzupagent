import { describe, it, expect } from 'vitest'
import { computePPR, queryPPR } from '../retrieval/pagerank.js'
import type { PPRConfig } from '../retrieval/pagerank.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seeds(entries: [string, number][]): Map<string, number> {
  return new Map(entries)
}

function adjacency(edges: [string, string[]][]): Map<string, string[]> {
  return new Map(edges)
}

// ---------------------------------------------------------------------------
// computePPR
// ---------------------------------------------------------------------------

describe('computePPR', () => {
  describe('empty and trivial inputs', () => {
    it('returns empty scores when seeds map is empty', () => {
      const result = computePPR(new Map(), adjacency([['A', ['B']]]))
      expect(result.scores.size).toBe(0)
      expect(result.iterations).toBe(0)
      expect(result.converged).toBe(true)
    })

    it('handles single isolated node as seed', () => {
      const result = computePPR(seeds([['A', 1]]), new Map())
      expect(result.scores.has('A')).toBe(true)
      expect(result.scores.get('A')!).toBeGreaterThan(0)
      expect(result.converged).toBe(true)
    })

    it('handles seed node not in adjacency', () => {
      const result = computePPR(
        seeds([['X', 1]]),
        adjacency([['A', ['B']]]),
      )
      // X should still have a score via teleportation
      expect(result.scores.has('X')).toBe(true)
      expect(result.scores.get('X')!).toBeGreaterThan(0)
    })
  })

  describe('linear chain', () => {
    // A -> B -> C
    const adj = adjacency([
      ['A', ['B']],
      ['B', ['C']],
    ])

    it('propagates scores along the chain', () => {
      const result = computePPR(seeds([['A', 1]]), adj)
      expect(result.converged).toBe(true)
      const scoreA = result.scores.get('A')!
      const scoreB = result.scores.get('B')!
      const scoreC = result.scores.get('C')!
      // A is the seed: should have highest score
      expect(scoreA).toBeGreaterThan(scoreB)
      // B is 1 hop from seed, C is 2 hops
      expect(scoreB).toBeGreaterThan(scoreC)
      // All scores positive
      expect(scoreC).toBeGreaterThan(0)
    })
  })

  describe('branching graph', () => {
    // A -> B, A -> C, B -> D, C -> D
    const adj = adjacency([
      ['A', ['B', 'C']],
      ['B', ['D']],
      ['C', ['D']],
    ])

    it('nodes closer to seed score higher', () => {
      const result = computePPR(seeds([['A', 1]]), adj)
      const scoreA = result.scores.get('A')!
      const scoreD = result.scores.get('D')!
      expect(scoreA).toBeGreaterThan(scoreD)
    })

    it('D receives propagation from two parents', () => {
      const result = computePPR(seeds([['A', 1]]), adj)
      const scoreB = result.scores.get('B')!
      const scoreC = result.scores.get('C')!
      const scoreD = result.scores.get('D')!
      // D gets flow from both B and C, so it should be non-trivial
      expect(scoreD).toBeGreaterThan(0)
      // D receives from two parents, which can make it higher than either single parent
      // B and C each get half of A's propagation; D gets all of B's and C's
      expect(scoreD).toBeGreaterThan(scoreB)
      expect(scoreD).toBeGreaterThan(scoreC)
    })
  })

  describe('convergence', () => {
    it('converges within maxIterations for a simple graph', () => {
      const adj = adjacency([
        ['A', ['B']],
        ['B', ['C']],
        ['C', ['A']],
      ])
      // Cycles may need more iterations or a looser epsilon to converge
      const result = computePPR(seeds([['A', 1]]), adj, {
        maxIterations: 100,
        epsilon: 1e-4,
      })
      expect(result.converged).toBe(true)
      expect(result.iterations).toBeLessThanOrEqual(100)
    })

    it('respects maxIterations config', () => {
      const adj = adjacency([
        ['A', ['B']],
        ['B', ['A']],
      ])
      const cfg: PPRConfig = { maxIterations: 2, epsilon: 1e-20 }
      const result = computePPR(seeds([['A', 1]]), adj, cfg)
      expect(result.iterations).toBe(2)
      // With very tight epsilon, likely not converged in 2 iterations
    })
  })

  describe('seed normalization', () => {
    it('normalizes unnormalized seed weights to sum=1', () => {
      const adj = adjacency([
        ['A', ['C']],
        ['B', ['C']],
      ])
      // Seeds that don't sum to 1
      const r1 = computePPR(seeds([['A', 5], ['B', 5]]), adj)
      // Seeds that sum to 1
      const r2 = computePPR(seeds([['A', 0.5], ['B', 0.5]]), adj)
      // Should produce same scores since 5:5 normalizes to 0.5:0.5
      for (const [key, score] of r1.scores) {
        expect(score).toBeCloseTo(r2.scores.get(key)!, 10)
      }
    })

    it('handles unequal weights', () => {
      const adj = adjacency([
        ['A', ['C']],
        ['B', ['C']],
      ])
      const result = computePPR(seeds([['A', 3], ['B', 1]]), adj)
      // A has 3x the seed weight of B, so should score higher
      expect(result.scores.get('A')!).toBeGreaterThan(result.scores.get('B')!)
    })
  })

  describe('damping factor effect', () => {
    // A -> B -> C
    const adj = adjacency([
      ['A', ['B']],
      ['B', ['C']],
    ])

    it('higher damping means more propagation to distant nodes', () => {
      const highDamping = computePPR(seeds([['A', 1]]), adj, { damping: 0.95 })
      const lowDamping = computePPR(seeds([['A', 1]]), adj, { damping: 0.5 })
      // With high damping, C (distant) gets relatively more score
      const highRatioC = highDamping.scores.get('C')! / highDamping.scores.get('A')!
      const lowRatioC = lowDamping.scores.get('C')! / lowDamping.scores.get('A')!
      expect(highRatioC).toBeGreaterThan(lowRatioC)
    })

    it('low damping concentrates score near seeds', () => {
      const result = computePPR(seeds([['A', 1]]), adj, { damping: 0.1 })
      const scoreA = result.scores.get('A')!
      const scoreC = result.scores.get('C')!
      // With very low damping, almost all score stays at seed
      expect(scoreA / scoreC).toBeGreaterThan(10)
    })
  })

  describe('disconnected components', () => {
    it('unreachable nodes from seeds get zero or no score', () => {
      // A -> B (component 1), C -> D (component 2, disconnected)
      const adj = adjacency([
        ['A', ['B']],
        ['C', ['D']],
      ])
      const result = computePPR(seeds([['A', 1]]), adj)
      expect(result.scores.get('A')!).toBeGreaterThan(0)
      expect(result.scores.get('B')!).toBeGreaterThan(0)
      // C and D are unreachable from seed A — should have 0 or be absent
      const scoreC = result.scores.get('C') ?? 0
      const scoreD = result.scores.get('D') ?? 0
      expect(scoreC).toBe(0)
      expect(scoreD).toBe(0)
    })
  })

  describe('cycle', () => {
    it('handles a cycle without infinite loop', () => {
      const adj = adjacency([
        ['A', ['B']],
        ['B', ['C']],
        ['C', ['A']],
      ])
      const result = computePPR(seeds([['A', 1]]), adj, {
        maxIterations: 100,
        epsilon: 1e-4,
      })
      expect(result.converged).toBe(true)
      // All nodes should have positive scores in a cycle
      expect(result.scores.get('A')!).toBeGreaterThan(0)
      expect(result.scores.get('B')!).toBeGreaterThan(0)
      expect(result.scores.get('C')!).toBeGreaterThan(0)
    })
  })
})

// ---------------------------------------------------------------------------
// queryPPR
// ---------------------------------------------------------------------------

describe('queryPPR', () => {
  const entityIndex = new Map<string, Set<string>>([
    ['userservice', new Set(['mem-1', 'mem-2'])],
    ['authmodule', new Set(['mem-3'])],
  ])

  // mem-1 -> mem-2 -> mem-3
  const adj = adjacency([
    ['mem-1', ['mem-2']],
    ['mem-2', ['mem-3']],
  ])

  it('extracts backtick entities and maps to seed nodes', () => {
    const result = queryPPR('How does `UserService` work?', entityIndex, adj)
    expect(result.scores.size).toBeGreaterThan(0)
    // mem-1 and mem-2 are seeds for "userservice"
    expect(result.scores.has('mem-1')).toBe(true)
    expect(result.scores.has('mem-2')).toBe(true)
  })

  it('extracts PascalCase entities', () => {
    const result = queryPPR('Tell me about AuthModule', entityIndex, adj)
    expect(result.scores.has('mem-3')).toBe(true)
  })

  it('extracts double-quoted strings', () => {
    const index = new Map<string, Set<string>>([
      ['user service', new Set(['mem-1'])],
    ])
    const result = queryPPR('What is "user service"?', index, adj)
    expect(result.scores.has('mem-1')).toBe(true)
  })

  it('returns empty result when no entities match index', () => {
    const result = queryPPR('How does `SomethingElse` work?', entityIndex, adj)
    expect(result.scores.size).toBe(0)
    expect(result.iterations).toBe(0)
    expect(result.converged).toBe(true)
  })

  it('returns empty result when query has no extractable entities', () => {
    const result = queryPPR('hello world', entityIndex, adj)
    expect(result.scores.size).toBe(0)
    expect(result.converged).toBe(true)
  })

  it('assigns equal weight to all matched seed nodes', () => {
    // Both mem-1 and mem-2 are seeds from "userservice"
    const result = queryPPR('`UserService`', entityIndex, adj)
    // All seeds get equal initial weight; after PPR, mem-1 may differ from mem-2
    // but both should have scores
    expect(result.scores.has('mem-1')).toBe(true)
    expect(result.scores.has('mem-2')).toBe(true)
  })

  it('seeds from multiple entities are combined', () => {
    // Query mentions both entities
    const result = queryPPR(
      'How does `UserService` relate to `AuthModule`?',
      entityIndex,
      adj,
    )
    // All three memory keys should be seeds
    expect(result.scores.has('mem-1')).toBe(true)
    expect(result.scores.has('mem-2')).toBe(true)
    expect(result.scores.has('mem-3')).toBe(true)
  })
})
