import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RecoveryFeedback } from '../self-correction/recovery-feedback.js'
import type { RecoveryLesson } from '../self-correction/recovery-feedback.js'
import type { BaseStore } from '@langchain/langgraph'

function makeMockStore(): BaseStore & {
  _data: Map<string, Record<string, unknown>>
  _searchResults: Array<{ value: Record<string, unknown> }>
} {
  const data = new Map<string, Record<string, unknown>>()
  let searchResults: Array<{ value: Record<string, unknown> }> = []

  return {
    _data: data,
    _searchResults: searchResults,
    async put(namespace: string[], key: string, value: Record<string, unknown>) {
      data.set(`${namespace.join('/')}/${key}`, value)
    },
    async get(namespace: string[], key: string) {
      return data.get(`${namespace.join('/')}/${key}`) ?? null
    },
    async delete(namespace: string[], key: string) {
      data.delete(`${namespace.join('/')}/${key}`)
    },
    async search(_namespace: string[], opts?: { filter?: Record<string, unknown>; limit?: number }) {
      return searchResults.filter(r => {
        if (opts?.filter) {
          for (const [k, v] of Object.entries(opts.filter)) {
            if ((r.value as Record<string, unknown>)[k] !== v) return false
          }
        }
        return true
      }).slice(0, opts?.limit ?? 100)
    },
    // Allow test to set search results
    set _setSearchResults(results: Array<{ value: Record<string, unknown> }>) {
      searchResults = results
    },
    async batch() { return [] },
    async start() {},
    async stop() {},
  } as unknown as BaseStore & {
    _data: Map<string, Record<string, unknown>>
    _searchResults: Array<{ value: Record<string, unknown> }>
  }
}

function makeLesson(overrides: Partial<RecoveryLesson> = {}): RecoveryLesson {
  return {
    id: 'lesson-1',
    errorType: 'build_failure',
    errorFingerprint: 'fp-123',
    nodeId: 'node-a',
    strategy: 'retry',
    outcome: 'success',
    summary: 'Retried and it worked',
    timestamp: new Date('2025-01-15T10:00:00Z'),
    ...overrides,
  }
}

describe('RecoveryFeedback', () => {
  describe('no store (no-op mode)', () => {
    it('recordOutcome is a no-op', async () => {
      const feedback = new RecoveryFeedback()
      // Should not throw
      await feedback.recordOutcome(makeLesson())
    })

    it('retrieveSimilar returns empty array', async () => {
      const feedback = new RecoveryFeedback()
      const result = await feedback.retrieveSimilar('build_failure', 'node-a')
      expect(result).toEqual([])
    })

    it('getSuccessRate returns zero stats', async () => {
      const feedback = new RecoveryFeedback()
      const result = await feedback.getSuccessRate('build_failure')
      expect(result).toEqual({ total: 0, successes: 0, rate: 0 })
    })
  })

  describe('with store', () => {
    let store: ReturnType<typeof makeMockStore>
    let feedback: RecoveryFeedback

    beforeEach(() => {
      store = makeMockStore()
      feedback = new RecoveryFeedback({ store })
    })

    it('recordOutcome persists lesson to store', async () => {
      const lesson = makeLesson()
      await feedback.recordOutcome(lesson)

      expect(store._data.size).toBe(1)
      const stored = [...store._data.values()][0]!
      expect(stored['id']).toBe('lesson-1')
      expect(stored['errorType']).toBe('build_failure')
      expect(stored['outcome']).toBe('success')
      expect(typeof stored['timestamp']).toBe('string') // ISO string
    })

    it('recordOutcome uses custom namespace', async () => {
      const fb = new RecoveryFeedback({
        store,
        namespace: ['custom', 'ns'],
      })

      await fb.recordOutcome(makeLesson())

      const key = [...store._data.keys()][0]!
      expect(key).toContain('custom/ns')
    })

    it('retrieveSimilar filters by errorType', async () => {
      // Set up search results
      ;(store as unknown as { _setSearchResults: Array<{ value: Record<string, unknown> }> })._setSearchResults = [
        {
          value: {
            id: 'l1',
            errorType: 'build_failure',
            errorFingerprint: 'fp-1',
            nodeId: 'node-a',
            strategy: 'retry',
            outcome: 'success',
            summary: 'Worked',
            timestamp: '2025-01-15T10:00:00Z',
          },
        },
        {
          value: {
            id: 'l2',
            errorType: 'build_failure',
            errorFingerprint: 'fp-2',
            nodeId: 'node-b',
            strategy: 'rollback',
            outcome: 'failure',
            summary: 'Failed',
            timestamp: '2025-01-14T10:00:00Z',
          },
        },
      ]

      const results = await feedback.retrieveSimilar('build_failure', 'node-a', 5)

      expect(results.length).toBe(2)
      // Same-node lessons should sort first
      expect(results[0]!.nodeId).toBe('node-a')
      // Results should be deserialized properly
      expect(results[0]!.timestamp).toBeInstanceOf(Date)
    })

    it('retrieveSimilar respects limit', async () => {
      ;(store as unknown as { _setSearchResults: Array<{ value: Record<string, unknown> }> })._setSearchResults = [
        {
          value: {
            id: 'l1', errorType: 'build_failure', errorFingerprint: 'fp-1',
            nodeId: 'node-a', strategy: 'retry', outcome: 'success',
            summary: 'Worked', timestamp: '2025-01-15T10:00:00Z',
          },
        },
        {
          value: {
            id: 'l2', errorType: 'build_failure', errorFingerprint: 'fp-2',
            nodeId: 'node-b', strategy: 'rollback', outcome: 'failure',
            summary: 'Failed', timestamp: '2025-01-14T10:00:00Z',
          },
        },
        {
          value: {
            id: 'l3', errorType: 'build_failure', errorFingerprint: 'fp-3',
            nodeId: 'node-c', strategy: 'skip', outcome: 'success',
            summary: 'Skipped', timestamp: '2025-01-13T10:00:00Z',
          },
        },
      ]

      const results = await feedback.retrieveSimilar('build_failure', 'node-a', 2)
      expect(results.length).toBe(2)
    })

    it('retrieveSimilar skips items with missing id', async () => {
      ;(store as unknown as { _setSearchResults: Array<{ value: Record<string, unknown> }> })._setSearchResults = [
        { value: { errorType: 'build_failure', nodeId: 'node-a' } }, // No id
        {
          value: {
            id: 'l1', errorType: 'build_failure', errorFingerprint: 'fp-1',
            nodeId: 'node-a', strategy: 'retry', outcome: 'success',
            summary: 'Worked', timestamp: '2025-01-15T10:00:00Z',
          },
        },
      ]

      const results = await feedback.retrieveSimilar('build_failure', 'node-a')
      expect(results.length).toBe(1)
      expect(results[0]!.id).toBe('l1')
    })

    it('getSuccessRate calculates correct rate', async () => {
      ;(store as unknown as { _setSearchResults: Array<{ value: Record<string, unknown> }> })._setSearchResults = [
        { value: { id: 'l1', errorType: 'build_failure', outcome: 'success' } },
        { value: { id: 'l2', errorType: 'build_failure', outcome: 'failure' } },
        { value: { id: 'l3', errorType: 'build_failure', outcome: 'success' } },
        { value: { id: 'l4', errorType: 'build_failure', outcome: 'success' } },
      ]

      const rate = await feedback.getSuccessRate('build_failure')
      expect(rate.total).toBe(4)
      expect(rate.successes).toBe(3)
      expect(rate.rate).toBeCloseTo(0.75)
    })

    it('getSuccessRate returns zero rate for no data', async () => {
      ;(store as unknown as { _setSearchResults: Array<{ value: Record<string, unknown> }> })._setSearchResults = []

      const rate = await feedback.getSuccessRate('timeout')
      expect(rate).toEqual({ total: 0, successes: 0, rate: 0 })
    })

    it('getSuccessRate skips items with missing outcome', async () => {
      ;(store as unknown as { _setSearchResults: Array<{ value: Record<string, unknown> }> })._setSearchResults = [
        { value: { id: 'l1', errorType: 'build_failure', outcome: 'success' } },
        { value: { id: 'l2', errorType: 'build_failure' } }, // No outcome
      ]

      const rate = await feedback.getSuccessRate('build_failure')
      expect(rate.total).toBe(1)
      expect(rate.successes).toBe(1)
      expect(rate.rate).toBe(1)
    })
  })

  describe('generateLessonId', () => {
    it('generates unique IDs', () => {
      const feedback = new RecoveryFeedback()
      const id1 = feedback.generateLessonId()
      const id2 = feedback.generateLessonId()

      expect(id1).not.toBe(id2)
      expect(id1).toContain('lesson_')
      expect(id2).toContain('lesson_')
    })

    it('increments counter', () => {
      const feedback = new RecoveryFeedback()
      const id1 = feedback.generateLessonId()
      const id2 = feedback.generateLessonId()

      // Counter increments, so they differ in the suffix
      expect(id1).not.toBe(id2)
    })
  })
})
