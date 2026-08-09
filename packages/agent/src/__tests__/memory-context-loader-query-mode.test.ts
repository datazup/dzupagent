/**
 * Query-conditioned memory context loading (MC-QR).
 *
 * Covers both modes of the standard loader path, the vector-fusion route that
 * only `'query'` mode can reach, and every degradation back to the namespace
 * read. The Arrow path is deliberately untouched by this feature and has its
 * own suites.
 */
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'
import { MemoryService, createStore } from '@dzupagent/memory'

import { AgentMemoryContextLoader } from '../agent/memory-context-loader.js'
import { deriveMemoryQuery } from '../agent/memory-context-loader-standard.js'

function formatForPrompt(
  records: Array<Record<string, unknown>>,
  options?: { maxItems?: number; maxCharsPerItem?: number },
): string {
  if (records.length === 0) return ''
  const maxItems = options?.maxItems ?? records.length
  return [
    '## Memory Context',
    ...records
      .slice(0, maxItems)
      .map((record) => `- ${String(record['text'] ?? '')}`),
  ].join('\n')
}

describe('deriveMemoryQuery', () => {
  it('returns the newest human message text', () => {
    const query = deriveMemoryQuery([
      new HumanMessage('first question'),
      new AIMessage('an answer'),
      new HumanMessage('  latest question  '),
    ])
    expect(query).toBe('latest question')
  })

  it('ignores non-human and blank messages', () => {
    const query = deriveMemoryQuery([
      new HumanMessage('real question'),
      new HumanMessage('   '),
      new AIMessage('an answer'),
      new SystemMessage('a directive'),
    ])
    expect(query).toBe('real question')
  })

  it('truncates to the configured character cap', () => {
    const query = deriveMemoryQuery([new HumanMessage('x'.repeat(1000))], 10)
    expect(query).toBe('x'.repeat(10))
  })

  it('serialises structured content rather than dropping it', () => {
    const query = deriveMemoryQuery([
      new HumanMessage({ content: [{ type: 'text', text: 'multimodal ask' }] }),
    ])
    expect(query).toContain('multimodal ask')
  })

  it('returns an empty string when the window holds no user text', () => {
    expect(deriveMemoryQuery([new AIMessage('only assistant turns')])).toBe('')
    expect(deriveMemoryQuery([])).toBe('')
  })
})

describe('AgentMemoryContextLoader — memoryContextMode', () => {
  function createMemory() {
    return {
      get: vi.fn(async () => [{ text: 'whole namespace record' }]),
      search: vi.fn(async () => [{ text: 'query matched record' }]),
      searchWithStatus: vi.fn(async () => ({
        results: [{ text: 'query matched record' }],
        searchFailed: false,
      })),
      formatForPrompt: vi.fn(formatForPrompt),
    }
  }

  function createLoader(
    memory: ReturnType<typeof createMemory>,
    overrides: Record<string, unknown> = {},
  ) {
    return new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 42,
      ...overrides,
    })
  }

  it('defaults to the namespace read and never touches search', async () => {
    const memory = createMemory()
    const loader = createLoader(memory)

    await expect(
      loader.load([new HumanMessage('what did we decide?')]),
    ).resolves.toMatchObject({
      context: '## Memory Context\n- whole namespace record',
    })
    expect(memory.get).toHaveBeenCalledWith('facts', { project: 'demo' })
    expect(memory.searchWithStatus).not.toHaveBeenCalled()
    expect(memory.search).not.toHaveBeenCalled()
  })

  it('treats an explicit namespace mode identically to the default', async () => {
    const memory = createMemory()
    const loader = createLoader(memory, { memoryContextMode: 'namespace' })

    await expect(
      loader.load([new HumanMessage('what did we decide?')]),
    ).resolves.toMatchObject({
      context: '## Memory Context\n- whole namespace record',
    })
    expect(memory.searchWithStatus).not.toHaveBeenCalled()
  })

  it('queries the memory service with the newest user message in query mode', async () => {
    const memory = createMemory()
    const loader = createLoader(memory, { memoryContextMode: 'query' })

    await expect(
      loader.load([
        new HumanMessage('stale question'),
        new AIMessage('an answer'),
        new HumanMessage('what did we decide about retries?'),
      ]),
    ).resolves.toMatchObject({
      context: '## Memory Context\n- query matched record',
    })

    expect(memory.get).not.toHaveBeenCalled()
    expect(memory.searchWithStatus).toHaveBeenCalledTimes(1)
    const call = memory.searchWithStatus.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
      string,
      number,
      unknown,
    ]
    expect(call[0]).toBe('facts')
    expect(call[1]).toEqual({ project: 'demo' })
    expect(call[2]).toBe('what did we decide about retries?')
    // Budget-derived limit: never above the standard per-prompt item cap.
    expect(call[3]).toBeGreaterThan(0)
    expect(call[3]).toBeLessThanOrEqual(10)
  })

  it('honours the per-agent item cap when deriving the search limit', async () => {
    const memory = createMemory()
    const loader = createLoader(memory, {
      memoryContextMode: 'query',
      limits: { standardMaxItems: 3 },
    })

    await loader.load([new HumanMessage('question')])
    expect(memory.searchWithStatus.mock.calls[0]?.[3]).toBe(3)
  })

  it('truncates the derived query to memoryQueryMaxChars', async () => {
    const memory = createMemory()
    const loader = createLoader(memory, {
      memoryContextMode: 'query',
      memoryQueryMaxChars: 8,
    })

    await loader.load([new HumanMessage('abcdefghijklmnop')])
    expect(memory.searchWithStatus.mock.calls[0]?.[2]).toBe('abcdefgh')
  })

  it('forwards the run read-context to the search call', async () => {
    const memory = createMemory()
    const loader = createLoader(memory, {
      memoryContextMode: 'query',
      memoryReadContext: { runId: 'run-7' },
    })

    await loader.load([new HumanMessage('question')])
    expect(memory.searchWithStatus.mock.calls[0]?.[4]).toEqual({ runId: 'run-7' })
  })

  it('returns an empty context when the search legitimately matches nothing', async () => {
    const memory = createMemory()
    memory.searchWithStatus.mockResolvedValue({ results: [], searchFailed: false })
    const loader = createLoader(memory, { memoryContextMode: 'query' })

    await expect(
      loader.load([new HumanMessage('question')]),
    ).resolves.toMatchObject({ context: null })
    // A successful empty search is "nothing relevant", not a failure — falling
    // back to the whole namespace here would silently undo query mode.
    expect(memory.get).not.toHaveBeenCalled()
  })

  it('uses plain search when the service exposes no searchWithStatus', async () => {
    const memory = createMemory()
    const withoutStatus: Record<string, unknown> = { ...memory }
    delete withoutStatus['searchWithStatus']
    const loader = createLoader(
      withoutStatus as unknown as ReturnType<typeof createMemory>,
      { memoryContextMode: 'query' },
    )

    await expect(
      loader.load([new HumanMessage('question')]),
    ).resolves.toMatchObject({
      context: '## Memory Context\n- query matched record',
    })
    expect(memory.search).toHaveBeenCalledTimes(1)
  })
})

describe('AgentMemoryContextLoader — query-mode degradation', () => {
  function createMemory(
    searchWithStatus: ReturnType<typeof vi.fn>,
  ): Record<string, unknown> {
    return {
      get: vi.fn(async () => [{ text: 'whole namespace record' }]),
      searchWithStatus,
      formatForPrompt: vi.fn(formatForPrompt),
    }
  }

  function loadWith(
    memory: Record<string, unknown>,
    messages: Parameters<AgentMemoryContextLoader['load']>[0],
    onFallbackDetail: ReturnType<typeof vi.fn>,
  ) {
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory: memory as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      memoryContextMode: 'query',
      estimateConversationTokens: () => 42,
      onFallbackDetail,
    })
    return loader.load(messages)
  }

  it('falls back to the namespace read when the search throws', async () => {
    const onFallbackDetail = vi.fn()
    const memory = createMemory(
      vi.fn(async () => {
        throw new Error('vector backend unreachable')
      }),
    )

    await expect(
      loadWith(memory, [new HumanMessage('question')], onFallbackDetail),
    ).resolves.toMatchObject({
      context: '## Memory Context\n- whole namespace record',
    })
    expect(memory['get']).toHaveBeenCalledTimes(1)
    expect(onFallbackDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'memory_query_search_failure',
        provider: 'memory-query',
        namespace: 'facts',
        detail: 'vector backend unreachable',
      }),
    )
  })

  it('falls back when the search reports the store as unreadable', async () => {
    const onFallbackDetail = vi.fn()
    const memory = createMemory(
      vi.fn(async () => ({ results: [], searchFailed: true })),
    )

    await expect(
      loadWith(memory, [new HumanMessage('question')], onFallbackDetail),
    ).resolves.toMatchObject({
      context: '## Memory Context\n- whole namespace record',
    })
    expect(onFallbackDetail).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'memory_query_search_failure' }),
    )
  })

  it('falls back when no query can be derived from the window', async () => {
    const onFallbackDetail = vi.fn()
    const searchWithStatus = vi.fn(async () => ({
      results: [],
      searchFailed: false,
    }))
    const memory = createMemory(searchWithStatus)

    await expect(
      loadWith(memory, [new AIMessage('assistant only')], onFallbackDetail),
    ).resolves.toMatchObject({
      context: '## Memory Context\n- whole namespace record',
    })
    expect(searchWithStatus).not.toHaveBeenCalled()
    expect(onFallbackDetail).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'memory_query_empty' }),
    )
  })

  it('falls back when the memory service exposes no search method at all', async () => {
    const onFallbackDetail = vi.fn()
    const memory: Record<string, unknown> = {
      get: vi.fn(async () => [{ text: 'whole namespace record' }]),
      formatForPrompt: vi.fn(formatForPrompt),
    }

    await expect(
      loadWith(memory, [new HumanMessage('question')], onFallbackDetail),
    ).resolves.toMatchObject({
      context: '## Memory Context\n- whole namespace record',
    })
    expect(onFallbackDetail).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'memory_query_unsupported' }),
    )
  })

  it('leaves memory read errors to the caller in query mode too', async () => {
    // The namespace fallback itself throwing must stay a thrown error so
    // message-preparation's non-fatal handler emits agent:context_fallback.
    const memory: Record<string, unknown> = {
      get: vi.fn(async () => {
        throw new Error('store down')
      }),
      searchWithStatus: vi.fn(async () => ({ results: [], searchFailed: true })),
      formatForPrompt: vi.fn(formatForPrompt),
    }

    await expect(
      loadWith(memory, [new HumanMessage('question')], vi.fn()),
    ).rejects.toThrow('store down')
  })
})

describe('AgentMemoryContextLoader — vector fusion reaches the prompt', () => {
  /**
   * Proves the end-to-end claim of the feature: a semantic store configured on
   * MemoryService only influences the prompt through the search path, so only
   * `memoryContextMode: 'query'` can surface a vector-only hit.
   */
  async function buildMemoryService() {
    const store = await createStore({ type: 'memory' })
    const semanticStore = {
      search: vi.fn(async () => [
        {
          id: 'vector-only-1',
          text: 'the retry budget was raised to five',
          score: 0.94,
          metadata: { source: 'vector' },
        },
      ]),
      upsert: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      ensureCollection: vi.fn(async () => undefined),
    }
    const memory = new MemoryService(
      store,
      [{ name: 'facts', scopeKeys: ['project'], searchable: true }],
      { semanticStore },
    )
    await memory.put('facts', { project: 'demo' }, 'k1', {
      text: 'unrelated keyword record',
    })
    return { memory, semanticStore }
  }

  it('surfaces vector-fused records in query mode', async () => {
    const { memory, semanticStore } = await buildMemoryService()
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      memoryContextMode: 'query',
      estimateConversationTokens: () => 42,
    })

    const { context } = await loader.load([
      new HumanMessage('what is the retry budget?'),
    ])

    expect(semanticStore.search).toHaveBeenCalledWith(
      'memory_facts',
      'what is the retry budget?',
      expect.any(Number),
      {
        and: [
          { field: '_ns', op: 'eq', value: 'facts' },
          { field: 'project', op: 'eq', value: 'demo' },
        ],
      },
    )
    expect(context).toContain('the retry budget was raised to five')
  })

  it('never reaches the semantic store in namespace mode', async () => {
    const { memory, semanticStore } = await buildMemoryService()
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 42,
    })

    const { context } = await loader.load([
      new HumanMessage('what is the retry budget?'),
    ])

    expect(semanticStore.search).not.toHaveBeenCalled()
    expect(context).not.toContain('the retry budget was raised to five')
  })
})
