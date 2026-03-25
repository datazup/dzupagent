import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SemanticConsolidator, consolidateWithLLM } from '../semantic-consolidation.js'
import type { SemanticConsolidationConfig } from '../semantic-consolidation.js'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Helpers: mock store + mock LLM
// ---------------------------------------------------------------------------

interface MockStoreRecord {
  key: string
  value: Record<string, unknown>
}

function createMockStore(records: MockStoreRecord[] = []) {
  const data = new Map<string, Record<string, unknown>>()
  for (const r of records) {
    data.set(r.key, r.value)
  }

  const store = {
    search: vi.fn().mockImplementation((_ns: string[], opts?: { query?: string; limit?: number }) => {
      const items = [...data.entries()].map(([key, value]) => ({ key, value }))
      if (opts?.query) {
        // For semantic search, return all items (the mock doesn't do real similarity)
        return Promise.resolve(items.slice(0, opts.limit ?? items.length))
      }
      return Promise.resolve(items.slice(0, opts?.limit ?? items.length))
    }),
    put: vi.fn().mockImplementation((_ns: string[], key: string, value: Record<string, unknown>) => {
      data.set(key, value)
      return Promise.resolve()
    }),
    delete: vi.fn().mockImplementation((_ns: string[], key: string) => {
      data.delete(key)
      return Promise.resolve()
    }),
    get: vi.fn().mockImplementation((_ns: string[], key: string) => {
      const value = data.get(key)
      return Promise.resolve(value ? { key, value } : undefined)
    }),
    _data: data,
  }

  return store as unknown as BaseStore & { _data: Map<string, Record<string, unknown>> }
}

function createMockModel(responses: string[]) {
  let callIndex = 0
  const invoke = vi.fn().mockImplementation(() => {
    const idx = callIndex++
    const content = idx < responses.length ? responses[idx] : '{"action":"add","reason":"fallback"}'
    return Promise.resolve({ content })
  })

  return { invoke } as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
}

function jsonResp(action: string, reason: string, mergedContent?: string): string {
  const obj: Record<string, string> = { action, reason }
  if (mergedContent !== undefined) obj['mergedContent'] = mergedContent
  return JSON.stringify(obj)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SemanticConsolidator', () => {
  const namespace = ['tenant1', 'lessons']

  describe('empty namespace', () => {
    it('returns zero counts when namespace is empty', async () => {
      const store = createMockStore([])
      const model = createMockModel([])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      expect(result.before).toBe(0)
      expect(result.after).toBe(0)
      expect(result.actions).toHaveLength(0)
      expect(result.llmCallsUsed).toBe(0)
      expect(result.contradictions).toHaveLength(0)
    })
  })

  describe('NOOP action (duplicates)', () => {
    it('removes duplicate record A when LLM says NOOP', async () => {
      const store = createMockStore([
        { key: 'rec-1', value: { text: 'Always use strict mode in TypeScript' } },
        { key: 'rec-2', value: { text: 'TypeScript strict mode should always be enabled' } },
      ])
      const model = createMockModel([
        jsonResp('noop', 'Both records say the same thing about strict mode'),
      ])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      expect(result.before).toBe(2)
      expect(result.after).toBe(1)
      expect(store.delete).toHaveBeenCalledWith(namespace, 'rec-1')
      expect(result.actions[0]?.decision.action).toBe('noop')
    })
  })

  describe('MERGE action', () => {
    it('merges two records into one with combined content', async () => {
      const store = createMockStore([
        { key: 'rec-1', value: { text: 'Use Prisma for database access' } },
        { key: 'rec-2', value: { text: 'Prisma should be used with strict typing' } },
      ])
      const merged = 'Use Prisma for database access with strict typing enabled'
      const model = createMockModel([
        jsonResp('merge', 'Both discuss Prisma usage, can be combined', merged),
      ])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      expect(result.before).toBe(2)
      expect(result.after).toBe(1)
      // rec-2 should be updated with merged content
      expect(store.put).toHaveBeenCalledWith(
        namespace,
        'rec-2',
        expect.objectContaining({ text: merged, consolidatedAt: expect.any(String) }),
      )
      // rec-1 should be deleted
      expect(store.delete).toHaveBeenCalledWith(namespace, 'rec-1')
    })
  })

  describe('UPDATE action', () => {
    it('updates target record and removes source', async () => {
      const store = createMockStore([
        { key: 'rec-1', value: { text: 'Node 18 is the current LTS' } },
        { key: 'rec-2', value: { text: 'Node 16 is the current LTS' } },
      ])
      const model = createMockModel([
        jsonResp('update', 'rec-1 has newer info', 'Node 18 is the current LTS version'),
      ])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      expect(result.after).toBe(1)
      expect(store.put).toHaveBeenCalledWith(
        namespace,
        'rec-2',
        expect.objectContaining({ text: 'Node 18 is the current LTS version' }),
      )
      expect(store.delete).toHaveBeenCalledWith(namespace, 'rec-1')
    })
  })

  describe('DELETE action', () => {
    it('deletes obsolete record A', async () => {
      const store = createMockStore([
        { key: 'old', value: { text: 'Use var for variable declarations' } },
        { key: 'new', value: { text: 'Use const/let for variable declarations' } },
      ])
      const model = createMockModel([
        jsonResp('delete', 'Record A is obsolete advice'),
      ])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      expect(result.after).toBe(1)
      expect(store.delete).toHaveBeenCalledWith(namespace, 'old')
    })
  })

  describe('ADD action', () => {
    it('keeps both records when they contain different information', async () => {
      const store = createMockStore([
        { key: 'rec-1', value: { text: 'Always validate user input' } },
        { key: 'rec-2', value: { text: 'Use rate limiting on API endpoints' } },
      ])
      const model = createMockModel([
        jsonResp('add', 'Different topics, both valuable'),
      ])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      expect(result.before).toBe(2)
      expect(result.after).toBe(2)
      expect(store.delete).not.toHaveBeenCalled()
    })
  })

  describe('CONTRADICT action', () => {
    it('flags contradicting records with metadata', async () => {
      const store = createMockStore([
        { key: 'rec-1', value: { text: 'Use REST for all APIs' } },
        { key: 'rec-2', value: { text: 'Use GraphQL for all APIs' } },
      ])
      const model = createMockModel([
        jsonResp('contradict', 'Opposing recommendations about API style'),
      ])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      expect(result.before).toBe(2)
      expect(result.after).toBe(2) // Neither deleted
      expect(result.contradictions).toHaveLength(1)
      expect(result.contradictions[0]?.keys).toEqual(['rec-1', 'rec-2'])
      // Both records should be flagged with _contradicts metadata
      expect(store.put).toHaveBeenCalledWith(
        namespace,
        'rec-1',
        expect.objectContaining({ _contradicts: 'rec-2' }),
      )
      expect(store.put).toHaveBeenCalledWith(
        namespace,
        'rec-2',
        expect.objectContaining({ _contradicts: 'rec-1' }),
      )
    })
  })

  describe('maxLLMCalls limit', () => {
    it('stops making LLM calls after reaching the limit', async () => {
      const records = Array.from({ length: 10 }, (_, i) => ({
        key: `rec-${i}`,
        value: { text: `Memory record number ${i} with unique content` },
      }))
      const store = createMockStore(records)
      const model = createMockModel(
        Array.from({ length: 50 }, () => jsonResp('add', 'keep both')),
      )
      const consolidator = new SemanticConsolidator({ model, maxLLMCalls: 3 })

      const result = await consolidator.consolidate(store, namespace)

      expect(result.llmCallsUsed).toBeLessThanOrEqual(3)
      expect(model.invoke).toHaveBeenCalledTimes(result.llmCallsUsed)
    })
  })

  describe('LLM failure handling', () => {
    it('skips pairs when LLM call fails', async () => {
      const store = createMockStore([
        { key: 'rec-1', value: { text: 'First record' } },
        { key: 'rec-2', value: { text: 'Second record' } },
      ])
      const model = {
        invoke: vi.fn().mockRejectedValue(new Error('API timeout')),
      } as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      // Should complete without throwing, with no actions executed
      expect(result.before).toBe(2)
      expect(result.after).toBe(2)
      expect(result.actions).toHaveLength(0)
    })

    it('skips pairs when LLM returns unparseable response', async () => {
      const store = createMockStore([
        { key: 'rec-1', value: { text: 'First record' } },
        { key: 'rec-2', value: { text: 'Second record' } },
      ])
      const model = createMockModel(['This is not JSON at all'])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      expect(result.before).toBe(2)
      expect(result.after).toBe(2)
      expect(result.actions).toHaveLength(0)
    })

    it('handles LLM response wrapped in markdown code blocks', async () => {
      const store = createMockStore([
        { key: 'rec-1', value: { text: 'Duplicate A' } },
        { key: 'rec-2', value: { text: 'Duplicate B' } },
      ])
      const model = createMockModel([
        '```json\n{"action":"noop","reason":"same content"}\n```',
      ])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      expect(result.actions).toHaveLength(1)
      expect(result.actions[0]?.decision.action).toBe('noop')
    })

    it('handles invalid action in LLM response', async () => {
      const store = createMockStore([
        { key: 'rec-1', value: { text: 'Record A' } },
        { key: 'rec-2', value: { text: 'Record B' } },
      ])
      const model = createMockModel([
        '{"action":"explode","reason":"not a valid action"}',
      ])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      // Invalid action should be skipped
      expect(result.actions).toHaveLength(0)
      expect(result.after).toBe(2)
    })
  })

  describe('pair deduplication', () => {
    it('does not compare the same pair twice (A-B and B-A)', async () => {
      const store = createMockStore([
        { key: 'rec-1', value: { text: 'Record alpha' } },
        { key: 'rec-2', value: { text: 'Record beta' } },
      ])
      const model = createMockModel([
        jsonResp('add', 'different content'),
        jsonResp('add', 'different content'), // should not be called
      ])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      // Only 1 LLM call for the pair, not 2
      expect(result.llmCallsUsed).toBe(1)
    })
  })

  describe('records with empty text', () => {
    it('skips records without text content', async () => {
      const store = createMockStore([
        { key: 'rec-1', value: { data: 123 } }, // no text field — extractText returns JSON
        { key: 'rec-2', value: { text: '' } },   // empty text
        { key: 'rec-3', value: { text: 'Valid record' } },
      ])
      const model = createMockModel([
        jsonResp('add', 'keep'),
      ])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      // rec-2 has empty text and should be skipped
      // rec-1 has JSON text from extractText, so it is compared with rec-3
      expect(result.before).toBe(3)
    })
  })

  describe('semantic search failure', () => {
    it('continues when semantic search throws for a record', async () => {
      let searchCallCount = 0
      const store = {
        search: vi.fn().mockImplementation(() => {
          searchCallCount++
          if (searchCallCount === 1) {
            // First call (load all records) succeeds
            return Promise.resolve([
              { key: 'rec-1', value: { text: 'Record A' } },
              { key: 'rec-2', value: { text: 'Record B' } },
            ])
          }
          // Subsequent semantic search calls fail
          return Promise.reject(new Error('Embedding service unavailable'))
        }),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(undefined),
      } as unknown as BaseStore
      const model = createMockModel([])
      const consolidator = new SemanticConsolidator({ model })

      const result = await consolidator.consolidate(store, namespace)

      // Should not throw, and no LLM calls since search failed
      expect(result.before).toBe(2)
      expect(result.after).toBe(2)
      expect(result.llmCallsUsed).toBe(0)
    })
  })
})

describe('consolidateWithLLM', () => {
  it('is a convenience wrapper that returns a result', async () => {
    const store = createMockStore([])
    const model = createMockModel([])
    const config: SemanticConsolidationConfig = { model }

    const result = await consolidateWithLLM(store, ['ns'], config)

    expect(result.before).toBe(0)
    expect(result.after).toBe(0)
    expect(result.namespace).toEqual(['ns'])
  })
})
