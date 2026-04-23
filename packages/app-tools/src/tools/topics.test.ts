import { describe, expect, it } from 'vitest'
import { buildTopicsTools, type TopicRecord } from './topics.js'

/**
 * Focused test for topics.search result shape.
 *
 * The TopicSearchResult schema declares exactly: id, title, score, summary?
 * This test confirms the execute() return value has no extra or missing keys.
 */

const CATALOG: TopicRecord[] = [
  {
    id: 'billing',
    title: 'Billing',
    summary: 'Invoices, payments, refunds',
    tags: ['finance'],
  },
]

describe('topics.list — lenient filter behavior', () => {
  it('resolves with { topics: [] } when tag is a number (non-string never matches string arrays)', async () => {
    // documents lenient filter behavior — number coercion never matches string tags
    const catalog: TopicRecord[] = [
      { id: 'ts', title: 'TypeScript', tags: ['typescript'] },
    ]
    const catalogMap = new Map(catalog.map((t) => [t.id, t]))
    const tools = buildTopicsTools(catalogMap)
    const listTool = tools.find((t) => t.definition.name === 'topics.list')!
    const result = await listTool.execute({ tag: 42 as unknown as string })
    expect(result).toEqual({ topics: [] })
  })
})

describe('topics.search — invalid input rejection', () => {
  it('throws when query is not a string (schema constraint violated)', async () => {
    const catalogMap = new Map(CATALOG.map((t) => [t.id, t]))
    const tools = buildTopicsTools(catalogMap)
    const searchTool = tools.find((t) => t.definition.name === 'topics.search')!
    await expect(
      searchTool.execute({ query: 42 } as unknown as { query: string; limit?: number }),
    ).rejects.toThrow()
  })
})

describe('topics.search — result shape matches TopicSearchResult schema exactly', () => {
  it('each result contains exactly {id, title, score} when topic has no summary', async () => {
    const noSummaryCatalog: TopicRecord[] = [{ id: 't1', title: 'Testing', tags: ['qa'] }]
    const catalogMap = new Map(noSummaryCatalog.map((t) => [t.id, t]))
    const tools = buildTopicsTools(catalogMap)
    const searchTool = tools.find((t) => t.definition.name === 'topics.search')!

    const output = (await searchTool.execute({ query: 'Testing' })) as {
      results: Record<string, unknown>[]
      query: string
    }

    expect(output.results).toHaveLength(1)
    const hit = output.results[0]!

    // Assert exact keys — no extra keys beyond {id, title, score}
    expect(Object.keys(hit).sort()).toEqual(['id', 'score', 'title'])
    // Assert each field has the correct type
    expect(typeof hit['id']).toBe('string')
    expect(typeof hit['title']).toBe('string')
    expect(typeof hit['score']).toBe('number')
    // score must be > 0 (exact title match)
    expect(hit['score']).toBe(1)
  })

  it('each result contains exactly {id, title, score, summary} when topic has a summary', async () => {
    const catalogMap = new Map(CATALOG.map((t) => [t.id, t]))
    const tools = buildTopicsTools(catalogMap)
    const searchTool = tools.find((t) => t.definition.name === 'topics.search')!

    const output = (await searchTool.execute({ query: 'Billing' })) as {
      results: Record<string, unknown>[]
      query: string
    }

    expect(output.results).toHaveLength(1)
    const hit = output.results[0]!

    // Assert exact keys — no extra keys beyond {id, title, score, summary}
    expect(Object.keys(hit).sort()).toEqual(['id', 'score', 'summary', 'title'])
    expect(typeof hit['id']).toBe('string')
    expect(typeof hit['title']).toBe('string')
    expect(typeof hit['score']).toBe('number')
    expect(typeof hit['summary']).toBe('string')
  })
})
