import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExecutableDomainTool } from '../tools/builtin.js'
import type { TopicRecord, TopicSearchResult } from '../tools/topics.js'
import {
  createBuiltinToolRegistryFromIndex,
  loadTopicsFromKnowledgeIndex,
} from './knowledge-index-loader.js'

async function mkTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function getExecutor<TInput, TOutput>(
  executors: Map<string, ExecutableDomainTool>,
  name: string,
): ExecutableDomainTool<TInput, TOutput> {
  const exec = executors.get(name)
  if (!exec) throw new Error(`executor ${name} not registered`)
  return exec as unknown as ExecutableDomainTool<TInput, TOutput>
}

const FIXTURE_INDEX = {
  topicLandscape: {
    topics: [
      {
        id: 'topic-0001',
        name: 'Memory systems',
        aliases: ['Memory systems', 'Memory system'],
        tokenSet: ['memory', 'system'],
        explicitTopics: ['agent-memory-routing', 'memory-context-knowledge'],
      },
      {
        id: 'topic-0002',
        name: 'Swarm orchestration',
        aliases: ['Swarm orchestration'],
        tokenSet: ['swarm', 'orchestration'],
        explicitTopics: ['swarm-orchestration'],
      },
      {
        id: 'topic-0003',
        name: 'RAG vectors',
        aliases: ['Retrieval augmented generation', 'RAG vectors'],
        tokenSet: ['rag', 'vectors'],
        explicitTopics: ['rag-vectors'],
      },
    ],
  },
}

describe('loadTopicsFromKnowledgeIndex', () => {
  let tmp: string
  let indexPath: string

  beforeAll(async () => {
    tmp = await mkTempDir('knowledge-index-loader-')
    indexPath = path.join(tmp, 'review-knowledge-index.json')
    await fs.writeFile(indexPath, JSON.stringify(FIXTURE_INDEX), 'utf8')
  })

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('maps topicLandscape.topics entries to TopicRecord[]', async () => {
    const records = await loadTopicsFromKnowledgeIndex(indexPath)
    expect(records).toHaveLength(3)
    const byId = new Map(records.map((r) => [r.id, r]))
    expect(byId.get('topic-0001')?.title).toBe('Memory systems')
    expect(byId.get('topic-0002')?.title).toBe('Swarm orchestration')
    expect(byId.get('topic-0003')?.title).toBe('RAG vectors')

    const memory = byId.get('topic-0001')
    expect(memory?.tags).toContain('agent-memory-routing')
    expect(memory?.tags).toContain('memory')
    // summary should be a distinct alias (not equal to title)
    expect(memory?.summary).toBe('Memory system')
  })

  it('returns [] when the file is missing', async () => {
    const records = await loadTopicsFromKnowledgeIndex(
      path.join(tmp, 'does-not-exist.json'),
    )
    expect(records).toEqual([])
  })

  it('returns [] when the file is malformed JSON', async () => {
    const badPath = path.join(tmp, 'bad.json')
    await fs.writeFile(badPath, '{not valid json', 'utf8')
    const records = await loadTopicsFromKnowledgeIndex(badPath)
    expect(records).toEqual([])
  })

  it('falls back to featureClusters / topicClusters / clusters arrays', async () => {
    const altPath = path.join(tmp, 'alt-clusters.json')
    await fs.writeFile(
      altPath,
      JSON.stringify({
        featureClusters: [
          {
            id: 'feat-1',
            name: 'Auth',
            aliases: ['Authentication'],
            tokenSet: ['auth'],
            explicitTopics: ['security'],
          },
        ],
      }),
      'utf8',
    )
    const records = await loadTopicsFromKnowledgeIndex(altPath)
    expect(records).toEqual([
      {
        id: 'feat-1',
        title: 'Auth',
        summary: 'Authentication',
        tags: ['security', 'auth', 'authentication'],
      },
    ])
  })

  it('generates a slug id when raw id is missing', async () => {
    const slugPath = path.join(tmp, 'slug.json')
    await fs.writeFile(
      slugPath,
      JSON.stringify({
        topicLandscape: {
          topics: [{ name: 'Hello World', tokenSet: ['hello', 'world'] }],
        },
      }),
      'utf8',
    )
    const records = await loadTopicsFromKnowledgeIndex(slugPath)
    expect(records).toEqual([
      {
        id: 'hello-world',
        title: 'Hello World',
        summary: 'hello world',
        tags: ['hello', 'world'],
      },
    ])
  })

  it('skips entries without a usable title', async () => {
    const skipPath = path.join(tmp, 'skip.json')
    await fs.writeFile(
      skipPath,
      JSON.stringify({
        topicLandscape: {
          topics: [
            { id: 'x', name: '' },
            { id: 'y' },
            'not-an-object',
            null,
            { id: 'ok', name: 'Valid Topic' },
          ],
        },
      }),
      'utf8',
    )
    const records = await loadTopicsFromKnowledgeIndex(skipPath)
    expect(records).toHaveLength(1)
    expect(records[0]?.id).toBe('ok')
  })
})

describe('createBuiltinToolRegistryFromIndex', () => {
  let tmp: string
  let indexPath: string

  beforeAll(async () => {
    tmp = await mkTempDir('knowledge-index-registry-')
    indexPath = path.join(tmp, 'review-knowledge-index.json')
    await fs.writeFile(indexPath, JSON.stringify(FIXTURE_INDEX), 'utf8')
  })

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('seeds the topic catalog from the file and exposes it via topics.list', async () => {
    const { executors, topicCatalog } = await createBuiltinToolRegistryFromIndex({
      knowledgeIndexPath: indexPath,
    })
    expect(topicCatalog.size).toBe(3)
    const list = getExecutor<{ tag?: string }, { topics: TopicRecord[] }>(
      executors,
      'topics.list',
    )
    const result = await list.execute({})
    expect(result.topics.map((t) => t.id).sort()).toEqual([
      'topic-0001',
      'topic-0002',
      'topic-0003',
    ])
  })

  it('topics.search finds seeded entries', async () => {
    const { executors } = await createBuiltinToolRegistryFromIndex({
      knowledgeIndexPath: indexPath,
    })
    const search = getExecutor<
      { query: string; limit?: number },
      { results: TopicSearchResult[]; query: string }
    >(executors, 'topics.search')
    const result = await search.execute({ query: 'memory system' })
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.results[0]?.id).toBe('topic-0001')
    expect(result.results[0]?.score).toBeGreaterThan(0)
  })

  it('explicit opts.topics override file entries on id collision', async () => {
    const { topicCatalog } = await createBuiltinToolRegistryFromIndex({
      knowledgeIndexPath: indexPath,
      topics: [
        {
          id: 'topic-0001',
          title: 'Memory (overridden)',
          summary: 'pinned summary',
          tags: ['pinned'],
        },
      ],
    })
    expect(topicCatalog.size).toBe(3)
    const overridden = topicCatalog.get('topic-0001')
    expect(overridden?.title).toBe('Memory (overridden)')
    expect(overridden?.tags).toEqual(['pinned'])
  })

  it('returns a working registry even when the index file is missing', async () => {
    const { topicCatalog, registry } = await createBuiltinToolRegistryFromIndex({
      knowledgeIndexPath: path.join(tmp, 'missing.json'),
    })
    expect(topicCatalog.size).toBe(0)
    // Registry still registers non-topic builtins.
    expect(registry.list().map((d) => d.name)).toContain('topics.search')
  })
})
