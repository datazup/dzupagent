import { describe, it, expect } from 'vitest'
import { KeywordFallbackSearch, createKeywordFallbackSearch } from '../semantic-search.js'
import type { RegisteredAgent } from '../types.js'
import type { ForgeCapability } from '../../identity/index.js'

// --- Helpers ---

function makeCap(name: string, description?: string, tags?: string[]): ForgeCapability {
  return { name, version: '1.0.0', description: description ?? `Cap: ${name}`, tags }
}

function makeAgent(id: string, name: string, caps: ForgeCapability[]): RegisteredAgent {
  return {
    id,
    name,
    description: `Agent ${name}`,
    protocols: ['a2a'],
    capabilities: caps,
    health: { status: 'healthy' },
    registeredAt: new Date(),
    lastUpdatedAt: new Date(),
  }
}

// --- Tests ---

describe('KeywordFallbackSearch', () => {
  it('returns empty results for empty index', async () => {
    const search = new KeywordFallbackSearch()
    const embedding = await search.embedQuery('code review')
    const results = await search.search(embedding, 10)
    expect(results).toEqual([])
  })

  it('finds agents by capability name match', async () => {
    const search = new KeywordFallbackSearch()

    const agent1 = makeAgent('a1', 'code-reviewer', [
      makeCap('code.review', 'Reviews code for quality'),
    ])
    const agent2 = makeAgent('a2', 'test-writer', [
      makeCap('testing.unit', 'Writes unit tests'),
    ])

    search.indexAgent(agent1)
    search.indexAgent(agent2)

    const embedding = await search.embedQuery('code review quality')
    const results = await search.search(embedding, 10)

    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.agentId).toBe('a1')
  })

  it('scores by relevance — more matching terms = higher score', async () => {
    const search = new KeywordFallbackSearch()

    const agent1 = makeAgent('a1', 'full-reviewer', [
      makeCap('code.review', 'Reviews code thoroughly for quality and security'),
    ])
    const agent2 = makeAgent('a2', 'partial-match', [
      makeCap('code.lint', 'Lints code files'),
    ])

    search.indexAgent(agent1)
    search.indexAgent(agent2)

    const embedding = await search.embedQuery('code review quality security')
    const results = await search.search(embedding, 10)

    expect(results.length).toBe(2)
    // Agent with more matching terms should score higher
    expect(results[0]!.agentId).toBe('a1')
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score)
  })

  it('handles tags in scoring', async () => {
    const search = new KeywordFallbackSearch()

    const agent = makeAgent('a1', 'tagged-agent', [
      makeCap('code.review', 'Reviews code', ['typescript', 'javascript', 'python']),
    ])
    search.indexAgent(agent)

    const embedding = await search.embedQuery('typescript code review')
    const results = await search.search(embedding, 10)

    expect(results.length).toBe(1)
    expect(results[0]!.agentId).toBe('a1')
  })

  it('removeAgent removes from index', async () => {
    const search = new KeywordFallbackSearch()

    const agent = makeAgent('a1', 'removable', [makeCap('test.cap')])
    search.indexAgent(agent)

    let embedding = await search.embedQuery('removable test')
    let results = await search.search(embedding, 10)
    expect(results.length).toBe(1)

    search.removeAgent('a1')

    embedding = await search.embedQuery('removable test')
    results = await search.search(embedding, 10)
    expect(results).toEqual([])
  })

  it('respects limit parameter', async () => {
    const search = new KeywordFallbackSearch()

    for (let i = 0; i < 5; i++) {
      search.indexAgent(makeAgent(`a${i}`, `agent-${i}`, [
        makeCap('code.review', 'Reviews code'),
      ]))
    }

    const embedding = await search.embedQuery('code review')
    const results = await search.search(embedding, 2)
    expect(results.length).toBe(2)
  })

  it('returns no results for unrelated query', async () => {
    const search = new KeywordFallbackSearch()
    search.indexAgent(makeAgent('a1', 'code-agent', [makeCap('code.review')]))

    const embedding = await search.embedQuery('basketball tournament')
    const results = await search.search(embedding, 10)
    expect(results).toEqual([])
  })
})

describe('createKeywordFallbackSearch', () => {
  it('returns a SemanticSearchProvider instance', () => {
    const provider = createKeywordFallbackSearch()
    expect(typeof provider.embedQuery).toBe('function')
    expect(typeof provider.search).toBe('function')
    expect(typeof provider.indexAgent).toBe('function')
    expect(typeof provider.removeAgent).toBe('function')
  })
})
