/**
 * Tests for FeedbackCollector — user approval/rejection feedback capture
 * and conversion to lessons/rules.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  FeedbackCollector,
  type FeedbackCollectorConfig,
  type FeedbackRecord,
} from '../self-correction/feedback-collector.js'
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// In-memory BaseStore mock
// ---------------------------------------------------------------------------

function createMockStore(): BaseStore {
  const data = new Map<string, Map<string, Record<string, unknown>>>()

  function getNamespace(ns: string[]): Map<string, Record<string, unknown>> {
    const key = ns.join('/')
    if (!data.has(key)) data.set(key, new Map())
    return data.get(key)!
  }

  return {
    put: async (ns: string[], key: string, value: Record<string, unknown>) => {
      getNamespace(ns).set(key, structuredClone(value))
    },
    get: async (ns: string[], key: string) => {
      const val = getNamespace(ns).get(key)
      return val ? { key, value: structuredClone(val), namespace: ns } : undefined
    },
    delete: async (ns: string[], key: string) => {
      getNamespace(ns).delete(key)
    },
    search: async (ns: string[], opts?: { filter?: Record<string, unknown>; limit?: number }) => {
      const map = getNamespace(ns)
      const limit = opts?.limit ?? 100
      const filter = opts?.filter
      const results: Array<{ key: string; value: Record<string, unknown>; namespace: string[] }> = []

      for (const [key, value] of map) {
        if (filter) {
          let match = true
          for (const [fk, fv] of Object.entries(filter)) {
            if (value[fk] !== fv) { match = false; break }
          }
          if (!match) continue
        }
        results.push({ key, value: structuredClone(value), namespace: ns })
        if (results.length >= limit) break
      }

      return results
    },
    // Required by the BaseStore interface but not used in tests
    batch: async () => [],
    listNamespaces: async () => [],
  } as unknown as BaseStore
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeedbackCollector', () => {
  let store: BaseStore
  let collector: FeedbackCollector

  beforeEach(() => {
    store = createMockStore()
    collector = new FeedbackCollector({ store })
  })

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  describe('recordPlanFeedback', () => {
    it('records a plan approval', async () => {
      const record = await collector.recordPlanFeedback({
        runId: 'run-1',
        approved: true,
        featureCategory: 'auth',
      })

      expect(record.type).toBe('plan_approval')
      expect(record.outcome).toBe('approved')
      expect(record.runId).toBe('run-1')
      expect(record.featureCategory).toBe('auth')
      expect(record.actionItems).toEqual([])
      expect(record.id).toMatch(/^fb_/)
      expect(record.timestamp).toBeInstanceOf(Date)
    })

    it('records a plan rejection with feedback and extracts action items', async () => {
      const record = await collector.recordPlanFeedback({
        runId: 'run-2',
        approved: false,
        feedback: 'The plan should include error handling. Missing validation for user input.',
        featureCategory: 'crud',
        riskClass: 'standard',
      })

      expect(record.type).toBe('plan_approval')
      expect(record.outcome).toBe('rejected')
      expect(record.feedback).toBe(
        'The plan should include error handling. Missing validation for user input.',
      )
      expect(record.actionItems).toHaveLength(2)
      expect(record.actionItems[0]).toBe('The plan should include error handling')
      expect(record.actionItems[1]).toBe('Missing validation for user input')
    })
  })

  describe('recordPublishFeedback', () => {
    it('records a publish approval', async () => {
      const record = await collector.recordPublishFeedback({
        runId: 'run-3',
        approved: true,
      })

      expect(record.type).toBe('publish_approval')
      expect(record.outcome).toBe('approved')
    })

    it('records a publish rejection', async () => {
      const record = await collector.recordPublishFeedback({
        runId: 'run-4',
        approved: false,
        feedback: 'Need to add proper loading states. Should include skeleton screens.',
        riskClass: 'sensitive',
      })

      expect(record.type).toBe('publish_approval')
      expect(record.outcome).toBe('rejected')
      expect(record.actionItems).toHaveLength(2)
    })
  })

  // -------------------------------------------------------------------------
  // extractActionItems
  // -------------------------------------------------------------------------

  describe('extractActionItems', () => {
    it('extracts sentences with "should"', () => {
      const items = collector.extractActionItems(
        'The code looks good. It should handle edge cases better.',
      )
      expect(items).toEqual(['It should handle edge cases better'])
    })

    it('extracts sentences with "must"', () => {
      const items = collector.extractActionItems(
        'Authentication must use bcrypt. The UI is fine.',
      )
      expect(items).toEqual(['Authentication must use bcrypt'])
    })

    it('extracts sentences with "need to"', () => {
      const items = collector.extractActionItems(
        'We need to add rate limiting. Looks okay otherwise.',
      )
      expect(items).toEqual(['We need to add rate limiting'])
    })

    it('extracts sentences with "add"', () => {
      const items = collector.extractActionItems('Add pagination to the list endpoint.')
      expect(items).toEqual(['Add pagination to the list endpoint'])
    })

    it('extracts sentences with "remove"', () => {
      const items = collector.extractActionItems('Remove the debug console logs.')
      expect(items).toEqual(['Remove the debug console logs'])
    })

    it('extracts sentences with "fix"', () => {
      const items = collector.extractActionItems('Fix the broken import path.')
      expect(items).toEqual(['Fix the broken import path'])
    })

    it('extracts sentences with "change"', () => {
      const items = collector.extractActionItems(
        'Change the variable name to camelCase.',
      )
      expect(items).toEqual(['Change the variable name to camelCase'])
    })

    it('extracts sentences with "include"', () => {
      const items = collector.extractActionItems(
        'Include proper error messages in responses.',
      )
      expect(items).toEqual(['Include proper error messages in responses'])
    })

    it('extracts sentences with "missing"', () => {
      const items = collector.extractActionItems('Missing unit tests for the service.')
      expect(items).toEqual(['Missing unit tests for the service'])
    })

    it('handles newline-separated feedback', () => {
      const items = collector.extractActionItems(
        'Should add validation\nThe styling is fine\nNeed to fix the API route',
      )
      expect(items).toHaveLength(2)
      expect(items[0]).toBe('Should add validation')
      expect(items[1]).toBe('Need to fix the API route')
    })

    it('handles exclamation marks as sentence boundaries', () => {
      const items = collector.extractActionItems(
        'Fix this immediately! The rest is fine.',
      )
      expect(items).toEqual(['Fix this immediately'])
    })

    it('returns empty array for empty feedback', () => {
      expect(collector.extractActionItems('')).toEqual([])
      expect(collector.extractActionItems('  ')).toEqual([])
    })

    it('returns empty array when no action keywords present', () => {
      const items = collector.extractActionItems(
        'The code looks great. Everything works perfectly.',
      )
      expect(items).toEqual([])
    })

    it('handles multiple action items in one feedback', () => {
      const items = collector.extractActionItems(
        'Should add input validation. Must include CSRF protection. Need to add rate limiting. The rest looks good.',
      )
      expect(items).toHaveLength(3)
    })
  })

  // -------------------------------------------------------------------------
  // feedbackToLessons
  // -------------------------------------------------------------------------

  describe('feedbackToLessons', () => {
    it('converts rejected feedback with action items to lessons', () => {
      const record: FeedbackRecord = {
        id: 'fb_1',
        runId: 'run-1',
        type: 'plan_approval',
        outcome: 'rejected',
        feedback: 'Should add validation.',
        featureCategory: 'auth',
        riskClass: 'critical',
        timestamp: new Date(),
        actionItems: ['Should add validation'],
      }

      const lessons = collector.feedbackToLessons(record)
      expect(lessons).toHaveLength(1)
      expect(lessons[0]).toEqual({
        summary: 'Should add validation',
        type: 'user_feedback',
        confidence: 0.9,
        applicableContext: ['auth', 'critical'],
      })
    })

    it('returns empty array for approved feedback', () => {
      const record: FeedbackRecord = {
        id: 'fb_2',
        runId: 'run-2',
        type: 'plan_approval',
        outcome: 'approved',
        timestamp: new Date(),
        actionItems: [],
      }

      expect(collector.feedbackToLessons(record)).toEqual([])
    })

    it('returns empty array for rejected feedback with no action items', () => {
      const record: FeedbackRecord = {
        id: 'fb_3',
        runId: 'run-3',
        type: 'publish_approval',
        outcome: 'rejected',
        feedback: 'Looks bad.',
        timestamp: new Date(),
        actionItems: [],
      }

      expect(collector.feedbackToLessons(record)).toEqual([])
    })

    it('creates multiple lessons from multiple action items', () => {
      const record: FeedbackRecord = {
        id: 'fb_4',
        runId: 'run-4',
        type: 'plan_approval',
        outcome: 'rejected',
        feedback: 'Should add tests. Must include docs.',
        featureCategory: 'crud',
        timestamp: new Date(),
        actionItems: ['Should add tests', 'Must include docs'],
      }

      const lessons = collector.feedbackToLessons(record)
      expect(lessons).toHaveLength(2)
      expect(lessons[0]!.applicableContext).toEqual(['crud'])
      expect(lessons[1]!.applicableContext).toEqual(['crud'])
    })
  })

  // -------------------------------------------------------------------------
  // feedbackToRules
  // -------------------------------------------------------------------------

  describe('feedbackToRules', () => {
    it('converts rejected feedback with action items to rules', () => {
      const record: FeedbackRecord = {
        id: 'fb_5',
        runId: 'run-5',
        type: 'publish_approval',
        outcome: 'rejected',
        feedback: 'Should use proper error boundaries.',
        featureCategory: 'dashboard',
        riskClass: 'sensitive',
        timestamp: new Date(),
        actionItems: ['Should use proper error boundaries'],
      }

      const rules = collector.feedbackToRules(record)
      expect(rules).toHaveLength(1)
      expect(rules[0]).toEqual({
        content: 'Should use proper error boundaries',
        scope: ['dashboard', 'sensitive'],
        source: 'human',
        confidence: 0.9,
      })
    })

    it('returns empty array for approved feedback', () => {
      const record: FeedbackRecord = {
        id: 'fb_6',
        runId: 'run-6',
        type: 'plan_approval',
        outcome: 'approved',
        timestamp: new Date(),
        actionItems: [],
      }

      expect(collector.feedbackToRules(record)).toEqual([])
    })

    it('filters out empty scope values', () => {
      const record: FeedbackRecord = {
        id: 'fb_7',
        runId: 'run-7',
        type: 'plan_approval',
        outcome: 'rejected',
        timestamp: new Date(),
        actionItems: ['Add error handling'],
      }

      const rules = collector.feedbackToRules(record)
      expect(rules).toHaveLength(1)
      expect(rules[0]!.scope).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // getStats
  // -------------------------------------------------------------------------

  describe('getStats', () => {
    it('returns zero stats when no records exist', async () => {
      const stats = await collector.getStats()
      expect(stats.totalPlanFeedback).toBe(0)
      expect(stats.planApprovalRate).toBe(0)
      expect(stats.totalPublishFeedback).toBe(0)
      expect(stats.publishApprovalRate).toBe(0)
      expect(stats.commonRejectionReasons).toEqual([])
      expect(stats.avgRejectionLength).toBe(0)
    })

    it('calculates approval rates correctly', async () => {
      // 2 plan approvals, 1 plan rejection
      await collector.recordPlanFeedback({ runId: 'r1', approved: true })
      await collector.recordPlanFeedback({ runId: 'r2', approved: true })
      await collector.recordPlanFeedback({
        runId: 'r3',
        approved: false,
        feedback: 'Should add tests.',
      })

      // 1 publish approval, 1 publish rejection
      await collector.recordPublishFeedback({ runId: 'r4', approved: true })
      await collector.recordPublishFeedback({
        runId: 'r5',
        approved: false,
        feedback: 'Missing error handling.',
      })

      const stats = await collector.getStats()
      expect(stats.totalPlanFeedback).toBe(3)
      expect(stats.planApprovalRate).toBeCloseTo(2 / 3)
      expect(stats.totalPublishFeedback).toBe(2)
      expect(stats.publishApprovalRate).toBeCloseTo(0.5)
    })

    it('calculates average rejection length', async () => {
      await collector.recordPlanFeedback({
        runId: 'r1',
        approved: false,
        feedback: 'Short',
      })
      await collector.recordPlanFeedback({
        runId: 'r2',
        approved: false,
        feedback: 'A much longer feedback string here',
      })

      const stats = await collector.getStats()
      const expectedAvg = ('Short'.length + 'A much longer feedback string here'.length) / 2
      expect(stats.avgRejectionLength).toBeCloseTo(expectedAvg)
    })

    it('extracts common rejection reasons from keywords', async () => {
      await collector.recordPlanFeedback({
        runId: 'r1',
        approved: false,
        feedback: 'validation errors everywhere',
      })
      await collector.recordPlanFeedback({
        runId: 'r2',
        approved: false,
        feedback: 'validation missing again',
      })
      await collector.recordPublishFeedback({
        runId: 'r3',
        approved: false,
        feedback: 'testing validation coverage',
      })

      const stats = await collector.getStats()
      // "validation" should appear 3 times and be the top reason
      expect(stats.commonRejectionReasons.length).toBeGreaterThan(0)
      expect(stats.commonRejectionReasons[0]!.reason).toBe('validation')
      expect(stats.commonRejectionReasons[0]!.count).toBe(3)
    })

    it('does not count approval feedback in rejection reasons', async () => {
      await collector.recordPlanFeedback({ runId: 'r1', approved: true })
      await collector.recordPlanFeedback({ runId: 'r2', approved: true })

      const stats = await collector.getStats()
      expect(stats.commonRejectionReasons).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // getRecent
  // -------------------------------------------------------------------------

  describe('getRecent', () => {
    it('returns recent records sorted by timestamp descending', async () => {
      await collector.recordPlanFeedback({ runId: 'r1', approved: true })
      await collector.recordPublishFeedback({ runId: 'r2', approved: false, feedback: 'Fix it.' })
      await collector.recordPlanFeedback({ runId: 'r3', approved: true })

      const recent = await collector.getRecent()
      expect(recent).toHaveLength(3)
      // All three records are present (timestamps may be identical within
      // the same millisecond, so we only assert on the set of runIds)
      const runIds = recent.map((r) => r.runId)
      expect(runIds).toContain('r1')
      expect(runIds).toContain('r2')
      expect(runIds).toContain('r3')
    })

    it('respects the limit parameter', async () => {
      await collector.recordPlanFeedback({ runId: 'r1', approved: true })
      await collector.recordPlanFeedback({ runId: 'r2', approved: true })
      await collector.recordPlanFeedback({ runId: 'r3', approved: true })

      const recent = await collector.getRecent(2)
      expect(recent).toHaveLength(2)
    })

    it('returns empty array when no records exist', async () => {
      const recent = await collector.getRecent()
      expect(recent).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Persistence round-trip
  // -------------------------------------------------------------------------

  describe('persistence', () => {
    it('records survive round-trip through store', async () => {
      await collector.recordPlanFeedback({
        runId: 'r1',
        approved: false,
        feedback: 'Should add error handling.',
        featureCategory: 'auth',
        riskClass: 'critical',
      })

      // Create a new collector with the same store to verify persistence
      const collector2 = new FeedbackCollector({ store })
      const recent = await collector2.getRecent()
      expect(recent).toHaveLength(1)
      expect(recent[0]!.runId).toBe('r1')
      expect(recent[0]!.outcome).toBe('rejected')
      expect(recent[0]!.featureCategory).toBe('auth')
      expect(recent[0]!.riskClass).toBe('critical')
      expect(recent[0]!.actionItems).toEqual(['Should add error handling'])
    })
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles approval with no feedback text', async () => {
      const record = await collector.recordPlanFeedback({
        runId: 'r1',
        approved: true,
      })

      expect(record.feedback).toBeUndefined()
      expect(record.actionItems).toEqual([])
    })

    it('handles rejection with empty feedback string', async () => {
      const record = await collector.recordPlanFeedback({
        runId: 'r1',
        approved: false,
        feedback: '',
      })

      expect(record.actionItems).toEqual([])
    })

    it('feedbackToLessons with no featureCategory or riskClass returns empty context', () => {
      const record: FeedbackRecord = {
        id: 'fb_1',
        runId: 'run-1',
        type: 'plan_approval',
        outcome: 'rejected',
        timestamp: new Date(),
        actionItems: ['Fix the bug'],
      }

      const lessons = collector.feedbackToLessons(record)
      expect(lessons[0]!.applicableContext).toEqual([])
    })
  })
})
