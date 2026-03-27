import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LessonPipeline } from '../lesson-pipeline.js'
import type { Lesson } from '../lesson-pipeline.js'
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Mock store factory (mirrors observational-memory.test.ts pattern)
// ---------------------------------------------------------------------------

function createMockStore() {
  const data = new Map<string, Record<string, unknown>>()

  const store = {
    search: vi.fn().mockImplementation((_ns: string[], opts?: { query?: string; limit?: number }) => {
      const items = [...data.entries()].map(([key, value]) => ({ key, value }))
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

  return store as unknown as BaseStore & {
    _data: Map<string, Record<string, unknown>>
    put: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    search: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LessonPipeline', () => {
  let store: ReturnType<typeof createMockStore>
  let pipeline: LessonPipeline

  beforeEach(() => {
    store = createMockStore()
    pipeline = new LessonPipeline({ store })
  })

  // ---- extractFromRecovery ------------------------------------------------

  describe('extractFromRecovery', () => {
    it('should extract a lesson from a successful recovery', async () => {
      const lesson = await pipeline.extractFromRecovery({
        runId: 'run-1',
        nodeId: 'gen_backend',
        errorType: 'TypeCheckError',
        errorMessage: 'Property x does not exist',
        strategy: 'add missing type import',
        outcome: 'success',
      })

      expect(lesson.type).toBe('error_resolution')
      expect(lesson.confidence).toBe(0.8)
      expect(lesson.summary).toContain('Resolved TypeCheckError')
      expect(lesson.summary).toContain('gen_backend')
      expect(lesson.summary).toContain('add missing type import')
      expect(lesson.applicableContext).toContain('gen_backend')
      expect(lesson.applicableContext).toContain('TypeCheckError')
      expect(lesson.evidence.runId).toBe('run-1')
      expect(lesson.evidence.strategyUsed).toBe('add missing type import')
      expect(lesson.applyCount).toBe(0)
      expect(lesson.id).toMatch(/^lesson_\d+_\w+$/)

      // Verify it was stored
      expect(store.put).toHaveBeenCalled()
      const storedCount = await pipeline.count()
      expect(storedCount).toBe(1)
    })

    it('should extract a lesson from a failed recovery', async () => {
      const lesson = await pipeline.extractFromRecovery({
        runId: 'run-2',
        nodeId: 'gen_tests',
        errorType: 'TimeoutError',
        errorMessage: 'Test execution timed out',
        strategy: 'increase timeout',
        outcome: 'failure',
      })

      expect(lesson.type).toBe('failed_recovery')
      expect(lesson.confidence).toBe(0.4)
      expect(lesson.summary).toContain('failed')
      expect(lesson.summary).toContain('TimeoutError')
    })
  })

  // ---- extractFromSuccess -------------------------------------------------

  describe('extractFromSuccess', () => {
    it('should extract lessons from high-scoring runs', async () => {
      const lessons = await pipeline.extractFromSuccess({
        runId: 'run-3',
        overallScore: 0.95,
        patterns: [
          'Used explicit return types on all functions',
          'Split large files into focused modules',
        ],
      })

      expect(lessons).toHaveLength(2)
      expect(lessons[0]!.type).toBe('successful_pattern')
      expect(lessons[0]!.summary).toBe('Used explicit return types on all functions')
      expect(lessons[0]!.confidence).toBe(0.95)
      expect(lessons[1]!.summary).toBe('Split large files into focused modules')
    })

    it('should skip extraction for low-scoring runs (< 0.85)', async () => {
      const lessons = await pipeline.extractFromSuccess({
        runId: 'run-4',
        overallScore: 0.7,
        patterns: ['Some pattern'],
      })

      expect(lessons).toHaveLength(0)
      // Store should not be called for lesson storage
      const count = await pipeline.count()
      expect(count).toBe(0)
    })

    it('should cap confidence at 1.0', async () => {
      const lessons = await pipeline.extractFromSuccess({
        runId: 'run-5',
        overallScore: 1.0,
        patterns: ['Perfect pattern'],
      })

      expect(lessons[0]!.confidence).toBeLessThanOrEqual(1.0)
    })

    it('should return empty array for empty patterns', async () => {
      const lessons = await pipeline.extractFromSuccess({
        runId: 'run-6',
        overallScore: 0.9,
        patterns: [],
      })

      expect(lessons).toHaveLength(0)
    })
  })

  // ---- Deduplication ------------------------------------------------------

  describe('deduplication', () => {
    it('should merge similar lessons instead of creating duplicates', async () => {
      // First lesson
      await pipeline.extractFromRecovery({
        runId: 'run-a',
        nodeId: 'gen_backend',
        errorType: 'TypeCheckError',
        errorMessage: 'Property x does not exist on type Y',
        strategy: 'add missing type import',
        outcome: 'success',
      })

      // Very similar lesson (same error type, same node, same strategy)
      await pipeline.extractFromRecovery({
        runId: 'run-b',
        nodeId: 'gen_backend',
        errorType: 'TypeCheckError',
        errorMessage: 'Property z does not exist on type W',
        strategy: 'add missing type import',
        outcome: 'success',
      })

      const count = await pipeline.count()
      // Should merge into one since summaries are very similar
      expect(count).toBe(1)

      // Confidence should have been boosted
      const lessons = await pipeline.retrieveForContext({ nodeId: 'gen_backend' })
      expect(lessons[0]!.confidence).toBeGreaterThan(0.8)
    })

    it('should not merge dissimilar lessons', async () => {
      await pipeline.extractFromRecovery({
        runId: 'run-a',
        nodeId: 'gen_backend',
        errorType: 'TypeCheckError',
        errorMessage: 'Property x does not exist',
        strategy: 'add missing type import',
        outcome: 'success',
      })

      await pipeline.extractFromRecovery({
        runId: 'run-b',
        nodeId: 'gen_tests',
        errorType: 'TimeoutError',
        errorMessage: 'Test timed out after 30s',
        strategy: 'increase timeout to 60s',
        outcome: 'success',
      })

      const count = await pipeline.count()
      expect(count).toBe(2)
    })
  })

  // ---- retrieveForContext -------------------------------------------------

  describe('retrieveForContext', () => {
    beforeEach(async () => {
      // Seed some lessons
      await pipeline.extractFromRecovery({
        runId: 'run-1',
        nodeId: 'gen_backend',
        errorType: 'TypeCheckError',
        errorMessage: 'Missing import',
        strategy: 'add import',
        outcome: 'success',
      })

      await pipeline.extractFromRecovery({
        runId: 'run-2',
        nodeId: 'gen_tests',
        errorType: 'AssertionError',
        errorMessage: 'Expected 200 got 404',
        strategy: 'fix route path',
        outcome: 'success',
      })

      await pipeline.extractFromRecovery({
        runId: 'run-3',
        nodeId: 'gen_frontend',
        errorType: 'RenderError',
        errorMessage: 'Component not found',
        strategy: 'register component',
        outcome: 'failure',
      })
    })

    it('should filter by nodeId', async () => {
      const lessons = await pipeline.retrieveForContext({ nodeId: 'gen_backend' })
      expect(lessons.length).toBeGreaterThanOrEqual(1)
      expect(lessons.every(l =>
        l.applicableContext.includes('gen_backend') ||
        l.summary.toLowerCase().includes('gen_backend'),
      )).toBe(true)
    })

    it('should filter by errorType', async () => {
      const lessons = await pipeline.retrieveForContext({ errorType: 'TypeCheckError' })
      expect(lessons.length).toBeGreaterThanOrEqual(1)
    })

    it('should return all lessons when no filter is provided', async () => {
      const lessons = await pipeline.retrieveForContext({})
      expect(lessons).toHaveLength(3)
    })

    it('should respect the limit parameter', async () => {
      const lessons = await pipeline.retrieveForContext({ limit: 1 })
      expect(lessons).toHaveLength(1)
    })

    it('should sort by confidence * recency (highest first)', async () => {
      const lessons = await pipeline.retrieveForContext({})
      // All have similar recency (created almost simultaneously), so
      // higher confidence should come first (success = 0.8, failure = 0.4)
      const confidences = lessons.map(l => l.confidence)
      for (let i = 0; i < confidences.length - 1; i++) {
        // Since recency is nearly identical, confidence ordering should hold
        expect(confidences[i]!).toBeGreaterThanOrEqual(confidences[i + 1]! - 0.01)
      }
    })
  })

  // ---- formatForPrompt ----------------------------------------------------

  describe('formatForPrompt', () => {
    it('should format lessons as markdown bullet list', () => {
      const lessons: Lesson[] = [
        {
          id: 'l1',
          type: 'error_resolution',
          summary: 'Always add explicit return types',
          details: 'Details...',
          applicableContext: ['gen_backend'],
          confidence: 0.9,
          evidence: { runId: 'r1' },
          createdAt: new Date().toISOString(),
          applyCount: 2,
        },
        {
          id: 'l2',
          type: 'successful_pattern',
          summary: 'Split routes into separate files',
          details: 'Details...',
          applicableContext: [],
          confidence: 0.75,
          evidence: { runId: 'r2' },
          createdAt: new Date().toISOString(),
          applyCount: 0,
        },
      ]

      const result = pipeline.formatForPrompt(lessons)

      expect(result).toContain('## Lessons Learned')
      expect(result).toContain('- [90%] Always add explicit return types')
      expect(result).toContain('- [75%] Split routes into separate files')
    })

    it('should return empty string for empty lessons', () => {
      expect(pipeline.formatForPrompt([])).toBe('')
    })

    it('should round confidence percentages', () => {
      const lessons: Lesson[] = [{
        id: 'l1',
        type: 'convention',
        summary: 'Test lesson',
        details: '',
        applicableContext: [],
        confidence: 0.333,
        evidence: { runId: 'r1' },
        createdAt: new Date().toISOString(),
        applyCount: 0,
      }]

      const result = pipeline.formatForPrompt(lessons)
      expect(result).toContain('[33%]')
    })
  })

  // ---- markApplied --------------------------------------------------------

  describe('markApplied', () => {
    it('should increment applyCount and set lastAppliedAt', async () => {
      const lesson = await pipeline.extractFromRecovery({
        runId: 'run-1',
        nodeId: 'gen_backend',
        errorType: 'TypeCheckError',
        errorMessage: 'Missing import',
        strategy: 'add import',
        outcome: 'success',
      })

      expect(lesson.applyCount).toBe(0)

      await pipeline.markApplied(lesson.id)

      // Retrieve the lesson to check updated values
      const lessons = await pipeline.retrieveForContext({ nodeId: 'gen_backend' })
      const updated = lessons.find(l => l.id === lesson.id)
      expect(updated).toBeDefined()
      expect(updated!.applyCount).toBe(1)
      expect(updated!.lastAppliedAt).toBeDefined()
    })

    it('should silently handle missing lesson IDs', async () => {
      // Should not throw
      await expect(pipeline.markApplied('nonexistent-id')).resolves.toBeUndefined()
    })

    it('should increment applyCount multiple times', async () => {
      const lesson = await pipeline.extractFromRecovery({
        runId: 'run-1',
        nodeId: 'gen_backend',
        errorType: 'SomeError',
        errorMessage: 'Something went wrong',
        strategy: 'fix it',
        outcome: 'success',
      })

      await pipeline.markApplied(lesson.id)
      await pipeline.markApplied(lesson.id)
      await pipeline.markApplied(lesson.id)

      const lessons = await pipeline.retrieveForContext({ nodeId: 'gen_backend' })
      const updated = lessons.find(l => l.id === lesson.id)
      expect(updated!.applyCount).toBe(3)
    })
  })

  // ---- count --------------------------------------------------------------

  describe('count', () => {
    it('should return 0 for empty store', async () => {
      expect(await pipeline.count()).toBe(0)
    })

    it('should return correct count after insertions', async () => {
      await pipeline.extractFromRecovery({
        runId: 'r1',
        nodeId: 'n1',
        errorType: 'E1',
        errorMessage: 'm1',
        strategy: 's1',
        outcome: 'success',
      })

      await pipeline.extractFromRecovery({
        runId: 'r2',
        nodeId: 'n2',
        errorType: 'E2',
        errorMessage: 'm2',
        strategy: 's2',
        outcome: 'failure',
      })

      expect(await pipeline.count()).toBe(2)
    })
  })

  // ---- Custom config ------------------------------------------------------

  describe('custom configuration', () => {
    it('should use custom namespace', async () => {
      const customPipeline = new LessonPipeline({
        store,
        namespace: ['custom', 'lessons'],
      })

      await customPipeline.extractFromRecovery({
        runId: 'r1',
        nodeId: 'n1',
        errorType: 'E1',
        errorMessage: 'm1',
        strategy: 's1',
        outcome: 'success',
      })

      // Verify store.put was called with the custom namespace
      expect(store.put).toHaveBeenCalledWith(
        ['custom', 'lessons'],
        expect.stringMatching(/^lesson_/),
        expect.objectContaining({ type: 'error_resolution' }),
      )
    })

    it('should use custom dedup threshold', async () => {
      const strictPipeline = new LessonPipeline({
        store,
        dedupThreshold: 0.99, // Very strict — almost nothing merges
      })

      await strictPipeline.extractFromRecovery({
        runId: 'r1',
        nodeId: 'gen_backend',
        errorType: 'TypeCheckError',
        errorMessage: 'Property x does not exist',
        strategy: 'add missing type import statement',
        outcome: 'success',
      })

      await strictPipeline.extractFromRecovery({
        runId: 'r2',
        nodeId: 'gen_frontend',
        errorType: 'RenderError',
        errorMessage: 'Component failed to mount',
        strategy: 'register component globally in main.ts',
        outcome: 'failure',
      })

      // With very strict threshold, both should be stored
      const count = await strictPipeline.count()
      expect(count).toBe(2)
    })
  })
})
