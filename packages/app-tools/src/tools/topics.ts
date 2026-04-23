import type { DomainToolDefinition } from '../types.js'
import type { ExecutableDomainTool } from './shared.js'

/**
 * topics.* — knowledge topic catalog tools.
 *
 * The topic catalog is injected as a map so callers can seed it from a static
 * list, a database, or a remote service. A small token-based scoring function
 * is used for `topics.search` so the stub returns meaningful results without
 * pulling in a full-text search dependency.
 */

export interface TopicRecord {
  id: string
  title: string
  summary?: string
  tags?: string[]
}

export interface TopicSearchResult {
  id: string
  title: string
  score: number
  summary?: string
}

/**
 * Score a topic against a query using a case-insensitive token overlap.
 * Returns 0 when nothing matches. Exact title matches are boosted.
 */
function scoreTopic(topic: TopicRecord, query: string): number {
  if (query.trim() === '') return 0
  const haystack = [topic.title, topic.summary ?? '', ...(topic.tags ?? [])]
    .join(' ')
    .toLowerCase()
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return 0
  let matches = 0
  for (const t of tokens) {
    if (haystack.includes(t)) matches += 1
  }
  const base = matches / tokens.length
  const titleBoost = topic.title.toLowerCase() === query.toLowerCase() ? 0.5 : 0
  return Math.min(1, base + titleBoost)
}

// ---------------------------------------------------------------------------
// topics.list
// ---------------------------------------------------------------------------

interface ListInput {
  tag?: string
}

interface ListOutput {
  topics: TopicRecord[]
}

function buildTopicsList(
  catalog: ReadonlyMap<string, TopicRecord>,
): ExecutableDomainTool<ListInput, ListOutput> {
  const definition: DomainToolDefinition = {
    name: 'topics.list',
    description: 'List known topics, optionally filtered by tag.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tag: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['topics'],
      properties: {
        topics: { type: 'array' },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'topics',
  }

  return {
    definition,
    async execute(input: ListInput): Promise<ListOutput> {
      const all = Array.from(catalog.values())
      const filtered =
        input.tag !== undefined
          ? all.filter((t) => (t.tags ?? []).includes(input.tag as string))
          : all
      return { topics: filtered.sort((a, b) => a.title.localeCompare(b.title)) }
    },
  }
}

// ---------------------------------------------------------------------------
// topics.search
// ---------------------------------------------------------------------------

interface SearchInput {
  query: string
  limit?: number
}

interface SearchOutput {
  results: TopicSearchResult[]
  query: string
}

function buildTopicsSearch(
  catalog: ReadonlyMap<string, TopicRecord>,
): ExecutableDomainTool<SearchInput, SearchOutput> {
  const definition: DomainToolDefinition = {
    name: 'topics.search',
    description: 'Search topics by query using token-overlap scoring.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['results', 'query'],
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'title', 'score'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              score: { type: 'number' },
              summary: { type: 'string' },
            },
          },
        },
        query: { type: 'string' },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'topics',
  }

  return {
    definition,
    async execute(input: SearchInput): Promise<SearchOutput> {
      const limit = input.limit ?? 10
      const scored: TopicSearchResult[] = []
      for (const topic of catalog.values()) {
        const score = scoreTopic(topic, input.query)
        if (score > 0) {
          const result: TopicSearchResult = { id: topic.id, title: topic.title, score }
          if (topic.summary !== undefined) result.summary = topic.summary
          scored.push(result)
        }
      }
      scored.sort((a, b) => b.score - a.score)
      return { results: scored.slice(0, limit), query: input.query }
    },
  }
}

// ---------------------------------------------------------------------------
// topics.get
// ---------------------------------------------------------------------------

interface GetInput {
  id: string
}

interface GetOutput {
  topic: TopicRecord | null
}

function buildTopicsGet(
  catalog: ReadonlyMap<string, TopicRecord>,
): ExecutableDomainTool<GetInput, GetOutput> {
  const definition: DomainToolDefinition = {
    name: 'topics.get',
    description: 'Fetch a single topic by id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['topic'],
      properties: {
        topic: {},
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'topics',
  }

  return {
    definition,
    async execute(input: GetInput): Promise<GetOutput> {
      return { topic: catalog.get(input.id) ?? null }
    },
  }
}

export function buildTopicsTools(
  catalog: ReadonlyMap<string, TopicRecord>,
): ExecutableDomainTool[] {
  return [
    buildTopicsList(catalog) as unknown as ExecutableDomainTool,
    buildTopicsSearch(catalog) as unknown as ExecutableDomainTool,
    buildTopicsGet(catalog) as unknown as ExecutableDomainTool,
  ]
}
