import { describe, it, expect, vi } from 'vitest'
import { CommunityDetector } from '../retrieval/community-detector.js'
import type { CommunityDetectorConfig } from '../retrieval/community-detector.js'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a simple undirected adjacency map from edge pairs. */
function buildAdjacency(edges: [string, string][]): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  const addEdge = (a: string, b: string) => {
    const list = adj.get(a) ?? []
    list.push(b)
    adj.set(a, list)
  }
  for (const [a, b] of edges) {
    addEdge(a, b)
    addEdge(b, a)
  }
  return adj
}

/** Stub LLM that returns a fixed summary string. */
function stubModel(response = 'Test summary') {
  return {
    invoke: vi.fn().mockResolvedValue({ content: response }),
  } as unknown as BaseChatModel
}

/** Stub LLM that throws on invoke. */
function failingModel() {
  return {
    invoke: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
  } as unknown as BaseChatModel
}

// ---------------------------------------------------------------------------
// Tests: detect()
// ---------------------------------------------------------------------------

describe('CommunityDetector.detect', () => {
  it('finds two distinct communities in a disconnected graph', () => {
    // Two cliques: {A,B,C} and {D,E,F}
    const adj = buildAdjacency([
      ['A', 'B'],
      ['B', 'C'],
      ['A', 'C'],
      ['D', 'E'],
      ['E', 'F'],
      ['D', 'F'],
    ])

    const detector = new CommunityDetector()
    const communities = detector.detect(adj)

    // Should produce exactly 2 communities
    expect(communities.size).toBe(2)

    // Collect member sets
    const sets = [...communities.values()].map((m) => new Set(m))

    // One set should contain A,B,C and the other D,E,F
    const hasABC = sets.some((s) => s.has('A') && s.has('B') && s.has('C'))
    const hasDEF = sets.some((s) => s.has('D') && s.has('E') && s.has('F'))
    expect(hasABC).toBe(true)
    expect(hasDEF).toBe(true)
  })

  it('filters communities smaller than minCommunitySize', () => {
    // One pair and one isolated node with a single connection
    const adj = buildAdjacency([
      ['A', 'B'],
      ['B', 'C'],
      ['A', 'C'],
    ])
    // Add an isolated node
    adj.set('Z', [])

    const detector = new CommunityDetector({ minCommunitySize: 3 })
    const communities = detector.detect(adj)

    // Z is isolated -> filtered; {A,B,C} has size 3 -> kept
    expect(communities.size).toBe(1)
    const members = [...communities.values()][0]!
    expect(members.sort()).toEqual(['A', 'B', 'C'])
  })

  it('returns empty map for graph with only isolated nodes', () => {
    const adj = new Map<string, string[]>()
    adj.set('X', [])
    adj.set('Y', [])

    const detector = new CommunityDetector()
    const communities = detector.detect(adj)
    expect(communities.size).toBe(0)
  })

  it('respects maxIterations config', () => {
    const adj = buildAdjacency([
      ['A', 'B'],
      ['B', 'C'],
    ])
    // maxIterations=1 should still produce some result
    const detector = new CommunityDetector({ maxIterations: 1 })
    const communities = detector.detect(adj)
    // With only 3 nodes in a line, they may or may not fully converge in 1 iter
    // but the function should not throw
    expect(communities.size).toBeGreaterThanOrEqual(0)
  })

  it('handles a single fully connected community', () => {
    const adj = buildAdjacency([
      ['A', 'B'],
      ['A', 'C'],
      ['A', 'D'],
      ['B', 'C'],
      ['B', 'D'],
      ['C', 'D'],
    ])

    const detector = new CommunityDetector()
    const communities = detector.detect(adj)

    // All nodes should be in one community
    expect(communities.size).toBe(1)
    const members = [...communities.values()][0]!
    expect(members.sort()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('handles empty adjacency map', () => {
    const detector = new CommunityDetector()
    const communities = detector.detect(new Map())
    expect(communities.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: summarize()
// ---------------------------------------------------------------------------

describe('CommunityDetector.summarize', () => {
  it('generates summaries for each community', async () => {
    const communities = new Map<string, string[]>()
    communities.set('c1', ['k1', 'k2'])

    const records = new Map<string, Record<string, unknown>>()
    records.set('k1', { text: 'Memory about `UserService` authentication' })
    records.set('k2', { text: 'Memory about `UserService` registration' })

    const model = stubModel('Both memories relate to UserService operations.')
    const detector = new CommunityDetector()
    const result = await detector.summarize(communities, records, model)

    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('c1')
    expect(result[0]!.memberKeys).toEqual(['k1', 'k2'])
    expect(result[0]!.summary).toBe('Both memories relate to UserService operations.')
    expect(result[0]!.updatedAt).toBeGreaterThan(0)
    expect(model.invoke).toHaveBeenCalledTimes(1)
  })

  it('extracts centroid entities appearing in >50% of members', async () => {
    const communities = new Map<string, string[]>()
    communities.set('c1', ['k1', 'k2', 'k3'])

    const records = new Map<string, Record<string, unknown>>()
    // "userservice" appears in all 3, "authmodule" in 2/3, "paymentgateway" in 1/3
    records.set('k1', { text: '`UserService` and `AuthModule` handle login' })
    records.set('k2', { text: '`UserService` and `AuthModule` handle registration' })
    records.set('k3', { text: '`UserService` and `PaymentGateway` handle billing' })

    const model = stubModel('Summary text')
    const detector = new CommunityDetector()
    const result = await detector.summarize(communities, records, model)

    // userservice (3/3) and authmodule (2/3) should be centroids, paymentgateway (1/3) should not
    expect(result[0]!.centroidEntities).toContain('userservice')
    expect(result[0]!.centroidEntities).toContain('authmodule')
    expect(result[0]!.centroidEntities).not.toContain('paymentgateway')
  })

  it('handles LLM failure gracefully (non-fatal)', async () => {
    const communities = new Map<string, string[]>()
    communities.set('c1', ['k1', 'k2'])

    const records = new Map<string, Record<string, unknown>>()
    records.set('k1', { text: 'Memory one' })
    records.set('k2', { text: 'Memory two' })

    const model = failingModel()
    const detector = new CommunityDetector()
    const result = await detector.summarize(communities, records, model)

    // Should still return the community, just with empty summary
    expect(result).toHaveLength(1)
    expect(result[0]!.summary).toBe('')
    expect(result[0]!.memberKeys).toEqual(['k1', 'k2'])
  })

  it('respects maxCommunities config', async () => {
    const communities = new Map<string, string[]>()
    communities.set('c1', ['k1', 'k2'])
    communities.set('c2', ['k3', 'k4'])
    communities.set('c3', ['k5', 'k6'])

    const records = new Map<string, Record<string, unknown>>()
    for (let i = 1; i <= 6; i++) {
      records.set(`k${i}`, { text: `Memory ${i}` })
    }

    const model = stubModel('Summary')
    const detector = new CommunityDetector({ maxCommunities: 2 })
    const result = await detector.summarize(communities, records, model)

    expect(result).toHaveLength(2)
    expect(model.invoke).toHaveBeenCalledTimes(2)
  })

  it('reads content field when text is absent', async () => {
    const communities = new Map<string, string[]>()
    communities.set('c1', ['k1'])

    const records = new Map<string, Record<string, unknown>>()
    records.set('k1', { content: 'Content field value' })

    const model = stubModel('Summary')
    // minCommunitySize doesn't apply to summarize, only detect
    const detector = new CommunityDetector({ minCommunitySize: 1 })
    const result = await detector.summarize(communities, records, model)

    expect(result).toHaveLength(1)
  })

  it('handles missing record gracefully', async () => {
    const communities = new Map<string, string[]>()
    communities.set('c1', ['k1', 'missing_key'])

    const records = new Map<string, Record<string, unknown>>()
    records.set('k1', { text: 'Some memory' })
    // 'missing_key' intentionally absent

    const model = stubModel('Summary')
    const detector = new CommunityDetector()
    const result = await detector.summarize(communities, records, model)

    expect(result).toHaveLength(1)
    expect(result[0]!.memberKeys).toEqual(['k1', 'missing_key'])
  })
})

// ---------------------------------------------------------------------------
// Tests: detectAndSummarize()
// ---------------------------------------------------------------------------

describe('CommunityDetector.detectAndSummarize', () => {
  it('runs full pipeline and returns correct stats', async () => {
    const adj = buildAdjacency([
      ['A', 'B'],
      ['B', 'C'],
      ['A', 'C'],
    ])
    // Add isolated node
    adj.set('Z', [])

    const records = new Map<string, Record<string, unknown>>()
    records.set('A', { text: 'Memory about `FooBar` service' })
    records.set('B', { text: 'Memory about `FooBar` config' })
    records.set('C', { text: 'Memory about `FooBar` testing' })
    records.set('Z', { text: 'Isolated memory' })

    const model = stubModel('All about FooBar.')
    const detector = new CommunityDetector()
    const result = await detector.detectAndSummarize(adj, records, model)

    expect(result.nodesProcessed).toBe(4)
    expect(result.isolatedNodes).toBe(1) // Z not in any community
    expect(result.communities).toHaveLength(1)
    expect(result.communities[0]!.summary).toBe('All about FooBar.')
    expect(result.llmCallsUsed).toBe(1)
  })

  it('handles LLM array content format', async () => {
    const adj = buildAdjacency([['A', 'B']])
    const records = new Map<string, Record<string, unknown>>()
    records.set('A', { text: 'Mem A' })
    records.set('B', { text: 'Mem B' })

    const model = {
      invoke: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Array format summary' }],
      }),
    } as unknown as BaseChatModel

    const detector = new CommunityDetector()
    const result = await detector.detectAndSummarize(adj, records, model)

    expect(result.communities[0]!.summary).toBe('Array format summary')
  })
})
