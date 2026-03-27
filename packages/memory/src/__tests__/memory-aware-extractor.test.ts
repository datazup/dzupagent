import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import { MemoryAwareExtractor } from '../memory-aware-extractor.js'
import type { MemoryService } from '../memory-service.js'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockModel(observations: Array<{ text: string; category: string; confidence: number }>): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue({
      content: JSON.stringify(observations),
    }),
  } as unknown as BaseChatModel
}

function createMockMemoryService(
  searchResults: Record<string, unknown>[] = [],
): { service: MemoryService; putCalls: Array<{ ns: string; scope: Record<string, string>; key: string; value: Record<string, unknown> }> } {
  const putCalls: Array<{ ns: string; scope: Record<string, string>; key: string; value: Record<string, unknown> }> = []

  const service = {
    search: vi.fn().mockResolvedValue(searchResults),
    put: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key: string, value: Record<string, unknown>) => {
        putCalls.push({ ns, scope, key, value })
        return Promise.resolve()
      },
    ),
    get: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue(''),
  } as unknown as MemoryService

  return { service, putCalls }
}

function sampleMessages() {
  return [
    new HumanMessage('We should use PostgreSQL for the database'),
    new AIMessage('Good choice. PostgreSQL is well suited for this project.'),
    new HumanMessage('Also, we prefer Tailwind CSS 4 for styling'),
    new AIMessage('Noted. I will use Tailwind CSS 4 throughout.'),
  ]
}

const DEFAULT_SCOPE = { tenantId: 't1', projectId: 'p1' }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryAwareExtractor', () => {
  describe('shouldExtract', () => {
    it('delegates to inner ObservationExtractor', () => {
      const model = createMockModel([])
      const { service } = createMockMemoryService()

      const extractor = new MemoryAwareExtractor({
        model,
        memoryService: service,
        namespace: 'observations',
        scope: DEFAULT_SCOPE,
        minMessages: 5,
      })

      expect(extractor.shouldExtract(3)).toBe(false)
      expect(extractor.shouldExtract(5)).toBe(true)
    })
  })

  describe('extractAndStore — no duplicates', () => {
    it('stores all observations when memory is empty', async () => {
      const observations = [
        { text: 'Project uses PostgreSQL', category: 'fact', confidence: 0.95 },
        { text: 'Prefer Tailwind CSS 4', category: 'preference', confidence: 0.9 },
      ]
      const model = createMockModel(observations)
      const { service, putCalls } = createMockMemoryService([])

      const extractor = new MemoryAwareExtractor({
        model,
        memoryService: service,
        namespace: 'observations',
        scope: DEFAULT_SCOPE,
      })

      const result = await extractor.extractAndStore(sampleMessages())

      expect(result.totalExtracted).toBe(2)
      expect(result.added).toHaveLength(2)
      expect(result.skipped).toHaveLength(0)
      expect(putCalls).toHaveLength(2)

      // Verify stored metadata
      expect(putCalls[0].ns).toBe('observations')
      expect(putCalls[0].scope).toEqual(DEFAULT_SCOPE)
      expect(putCalls[0].value).toMatchObject({
        text: 'Project uses PostgreSQL',
        category: 'fact',
        confidence: 0.95,
        source: 'extracted',
      })
      expect(putCalls[0].key).toMatch(/^obs-\d+-0$/)
      expect(putCalls[1].key).toMatch(/^obs-\d+-1$/)
    })
  })

  describe('extractAndStore — with duplicates', () => {
    it('skips observations that match existing memory entries', async () => {
      const observations = [
        { text: 'Project uses PostgreSQL', category: 'fact', confidence: 0.95 },
        { text: 'Team prefers dark mode', category: 'preference', confidence: 0.8 },
      ]
      const model = createMockModel(observations)

      // First observation has a near-exact match in memory
      const { service, putCalls } = createMockMemoryService()
      const searchMock = vi.fn()
        .mockResolvedValueOnce([{ text: 'Project uses PostgreSQL database', key: 'obs-existing-1' }])
        .mockResolvedValueOnce([])
      ;(service as unknown as { search: typeof searchMock }).search = searchMock

      const extractor = new MemoryAwareExtractor({
        model,
        memoryService: service,
        namespace: 'observations',
        scope: DEFAULT_SCOPE,
        similarityThreshold: 0.6, // Lower threshold to catch the near-match
      })

      const result = await extractor.extractAndStore(sampleMessages())

      expect(result.totalExtracted).toBe(2)
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0].observation.text).toBe('Project uses PostgreSQL')
      expect(result.added).toHaveLength(1)
      expect(result.added[0].text).toBe('Team prefers dark mode')
      expect(putCalls).toHaveLength(1)
    })

    it('stores observation when existing entries are below similarity threshold', async () => {
      const observations = [
        { text: 'Project uses PostgreSQL', category: 'fact', confidence: 0.95 },
      ]
      const model = createMockModel(observations)

      // Memory has something totally different
      const { service, putCalls } = createMockMemoryService([
        { text: 'Team meets on Tuesdays', key: 'obs-unrelated' },
      ])

      const extractor = new MemoryAwareExtractor({
        model,
        memoryService: service,
        namespace: 'observations',
        scope: DEFAULT_SCOPE,
        similarityThreshold: 0.8,
      })

      const result = await extractor.extractAndStore(sampleMessages())

      expect(result.added).toHaveLength(1)
      expect(result.skipped).toHaveLength(0)
      expect(putCalls).toHaveLength(1)
    })
  })

  describe('extractAndStore — error resilience', () => {
    it('stores observation when search fails (best-effort dedup)', async () => {
      const observations = [
        { text: 'Use ESM modules', category: 'convention', confidence: 0.85 },
      ]
      const model = createMockModel(observations)
      const { service, putCalls } = createMockMemoryService()
      ;(service.search as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('search failed'))

      const extractor = new MemoryAwareExtractor({
        model,
        memoryService: service,
        namespace: 'observations',
        scope: DEFAULT_SCOPE,
      })

      const result = await extractor.extractAndStore(sampleMessages())

      // Search failed, so observation should be stored anyway
      expect(result.added).toHaveLength(1)
      expect(result.skipped).toHaveLength(0)
      expect(putCalls).toHaveLength(1)
    })

    it('counts observation as added even when put fails', async () => {
      const observations = [
        { text: 'Use strict TypeScript', category: 'convention', confidence: 0.9 },
      ]
      const model = createMockModel(observations)
      const { service } = createMockMemoryService([])
      ;(service.put as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('put failed'))

      const extractor = new MemoryAwareExtractor({
        model,
        memoryService: service,
        namespace: 'observations',
        scope: DEFAULT_SCOPE,
      })

      const result = await extractor.extractAndStore(sampleMessages())

      // Should still report as added (non-fatal put failure)
      expect(result.added).toHaveLength(1)
      expect(result.skipped).toHaveLength(0)
    })

    it('returns empty result when LLM extraction fails', async () => {
      const model = {
        invoke: vi.fn().mockRejectedValue(new Error('LLM down')),
      } as unknown as BaseChatModel
      const { service } = createMockMemoryService()

      const extractor = new MemoryAwareExtractor({
        model,
        memoryService: service,
        namespace: 'observations',
        scope: DEFAULT_SCOPE,
      })

      const result = await extractor.extractAndStore(sampleMessages())

      expect(result.totalExtracted).toBe(0)
      expect(result.added).toHaveLength(0)
      expect(result.skipped).toHaveLength(0)
    })
  })

  describe('reset and count', () => {
    it('tracks extraction count and resets', async () => {
      const observations = [
        { text: 'Fact one', category: 'fact', confidence: 0.9 },
        { text: 'Fact two', category: 'fact', confidence: 0.8 },
      ]
      const model = createMockModel(observations)
      const { service } = createMockMemoryService([])

      const extractor = new MemoryAwareExtractor({
        model,
        memoryService: service,
        namespace: 'observations',
        scope: DEFAULT_SCOPE,
      })

      expect(extractor.count).toBe(0)

      await extractor.extractAndStore(sampleMessages())
      expect(extractor.count).toBe(2)

      extractor.reset()
      expect(extractor.count).toBe(0)
    })
  })

  describe('deduplicationTopK config', () => {
    it('passes configured topK to memory search', async () => {
      const observations = [
        { text: 'Use Vitest for testing', category: 'convention', confidence: 0.9 },
      ]
      const model = createMockModel(observations)
      const { service } = createMockMemoryService([])

      const extractor = new MemoryAwareExtractor({
        model,
        memoryService: service,
        namespace: 'observations',
        scope: DEFAULT_SCOPE,
        deduplicationTopK: 7,
      })

      await extractor.extractAndStore(sampleMessages())

      expect(service.search).toHaveBeenCalledWith(
        'observations',
        DEFAULT_SCOPE,
        'Use Vitest for testing',
        7,
      )
    })
  })
})
