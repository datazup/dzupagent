import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DynamicRuleEngine } from '../rule-engine.js'
import type { BaseStore } from '@langchain/langgraph'

function mockStore() {
  const data = new Map<string, Record<string, unknown>>()
  return {
    store: {
      search: vi.fn(async (_ns: string[], opts?: { limit?: number }) => {
        const items = [...data.entries()].map(([key, value]) => ({ key, value }))
        return items.slice(0, opts?.limit ?? items.length)
      }),
      put: vi.fn(async (_ns: string[], key: string, value: Record<string, unknown>) => {
        data.set(key, value)
      }),
      delete: vi.fn(async (_ns: string[], key: string) => {
        data.delete(key)
      }),
      get: vi.fn(async (_ns: string[], key: string) => {
        const value = data.get(key)
        return value ? { key, value } : undefined
      }),
    } as unknown as BaseStore,
    data,
  }
}

function failingStore(): BaseStore {
  return {
    search: vi.fn().mockRejectedValue(new Error('boom')),
    put: vi.fn().mockRejectedValue(new Error('boom')),
    delete: vi.fn().mockRejectedValue(new Error('boom')),
    get: vi.fn().mockRejectedValue(new Error('boom')),
  } as unknown as BaseStore
}

describe('DynamicRuleEngine — branch targeting', () => {
  let m: ReturnType<typeof mockStore>
  let engine: DynamicRuleEngine

  beforeEach(() => {
    m = mockStore()
    engine = new DynamicRuleEngine({ store: m.store })
  })

  describe('addRule — clamping and defaults', () => {
    it('clamps confidence above 1 to 1', async () => {
      const r = await engine.addRule({
        content: 'x',
        scope: ['s'],
        confidence: 5,
      })
      expect(r.confidence).toBe(1)
    })

    it('clamps negative confidence to 0', async () => {
      const r = await engine.addRule({
        content: 'x',
        scope: ['s'],
        confidence: -0.5,
      })
      expect(r.confidence).toBe(0)
    })

    it('defaults source=human when not provided', async () => {
      const r = await engine.addRule({ content: 'x', scope: ['s'] })
      expect(r.source).toBe('human')
    })

    it('accepts source=convention', async () => {
      const r = await engine.addRule({
        content: 'x',
        scope: ['s'],
        source: 'convention',
      })
      expect(r.source).toBe('convention')
    })

    it('defaults confidence=0.8 when not provided', async () => {
      const r = await engine.addRule({ content: 'x', scope: ['s'] })
      expect(r.confidence).toBe(0.8)
    })
  })

  describe('learnFromError — scope composition', () => {
    it('includes taskType in scope when provided', async () => {
      const r = await engine.learnFromError({
        errorType: 'TimeoutError',
        errorMessage: 'took too long',
        resolution: 'increase timeout',
        nodeId: 'gen_backend',
        taskType: 'api-call',
      })
      expect(r.scope).toContain('gen_backend')
      expect(r.scope).toContain('api-call')
    })

    it('omits taskType from scope when undefined', async () => {
      const r = await engine.learnFromError({
        errorType: 'TimeoutError',
        errorMessage: 'took too long',
        resolution: 'increase timeout',
        nodeId: 'gen_backend',
      })
      expect(r.scope).toEqual(['gen_backend'])
    })
  })

  describe('getRulesForContext', () => {
    beforeEach(async () => {
      await engine.addRule({
        content: 'use Vue for frontend',
        scope: ['gen_frontend'],
        confidence: 0.9,
      })
      await engine.addRule({
        content: 'always Zod validation for backend',
        scope: ['gen_backend', 'api'],
        confidence: 0.8,
      })
      await engine.addRule({
        content: 'low confidence rule',
        scope: ['any'],
        confidence: 0.3,
      })
    })

    it('drops rules below minConfidence', async () => {
      const r = await engine.getRulesForContext({ nodeId: 'any' })
      expect(r.find((x) => x.content === 'low confidence rule')).toBeUndefined()
    })

    it('matches by nodeId (case-insensitive)', async () => {
      const r = await engine.getRulesForContext({ nodeId: 'GEN_BACKEND' })
      expect(r.find((x) => x.content.includes('Zod'))).toBeDefined()
    })

    it('matches by taskType', async () => {
      const r = await engine.getRulesForContext({ taskType: 'api' })
      expect(r.find((x) => x.content.includes('Zod'))).toBeDefined()
    })

    it('returns all (above minConfidence) when no filter', async () => {
      const r = await engine.getRulesForContext({})
      // Should include 2 (gen_frontend + gen_backend), exclude low-conf
      expect(r.length).toBe(2)
    })

    it('sorts by confidence * successRate descending', async () => {
      const r = await engine.getRulesForContext({})
      for (let i = 1; i < r.length; i++) {
        const prev = r[i - 1]!
        const cur = r[i]!
        expect(prev.confidence * prev.successRate).toBeGreaterThanOrEqual(
          cur.confidence * cur.successRate,
        )
      }
    })

    it('respects limit parameter', async () => {
      const r = await engine.getRulesForContext({ limit: 1 })
      expect(r).toHaveLength(1)
    })

    it('returns [] for unmatched filters', async () => {
      const r = await engine.getRulesForContext({ nodeId: 'no-such-node' })
      expect(r).toEqual([])
    })
  })

  describe('formatForPrompt', () => {
    it('returns empty for no rules', () => {
      expect(engine.formatForPrompt([])).toBe('')
    })

    it('renders percentage + content per rule', async () => {
      const rule = await engine.addRule({ content: 'x', scope: [], confidence: 0.9 })
      const out = engine.formatForPrompt([rule])
      expect(out).toContain('## Dynamic Rules')
      expect(out).toContain('90%')
    })
  })

  describe('recordApplication', () => {
    it('no-ops when rule missing', async () => {
      await expect(engine.recordApplication('nope', true)).resolves.toBeUndefined()
    })

    it('increments applyCount and updates successRate on success', async () => {
      const rule = await engine.addRule({ content: 'unique content apple', scope: [] })
      await engine.recordApplication(rule.id, true)
      const rules = await engine.getRulesForContext({})
      const updated = rules.find((r) => r.id === rule.id)!
      expect(updated.applyCount).toBe(1)
      expect(updated.successRate).toBe(1)
    })

    it('records failure correctly (success=false)', async () => {
      const rule = await engine.addRule({ content: 'banana unique', scope: [] })
      await engine.recordApplication(rule.id, false)
      const rules = await engine.getRulesForContext({})
      const updated = rules.find((r) => r.id === rule.id)!
      expect(updated.applyCount).toBe(1)
      expect(updated.successRate).toBe(0)
    })

    it('maintains running average over multiple applications', async () => {
      const rule = await engine.addRule({ content: 'cherry unique', scope: [] })
      await engine.recordApplication(rule.id, true)
      await engine.recordApplication(rule.id, false)
      const rules = await engine.getRulesForContext({})
      const updated = rules.find((r) => r.id === rule.id)!
      expect(updated.applyCount).toBe(2)
      expect(updated.successRate).toBeCloseTo(0.5, 2)
    })

    it('swallows errors from failing store', async () => {
      const bad = new DynamicRuleEngine({ store: failingStore() })
      await expect(bad.recordApplication('x', true)).resolves.toBeUndefined()
    })
  })

  describe('decayStaleRules', () => {
    it('returns 0 when store fails', async () => {
      const bad = new DynamicRuleEngine({ store: failingStore() })
      expect(await bad.decayStaleRules()).toBe(0)
    })

    it('does not decay recent rules', async () => {
      await engine.addRule({ content: 'fresh rule', scope: [] })
      const decayed = await engine.decayStaleRules(30, 0.9)
      expect(decayed).toBe(0)
    })

    it('decays old rules and keeps them above threshold', async () => {
      const rule = await engine.addRule({ content: 'old rule content', scope: [], confidence: 0.9 })
      // Manipulate stored record to look old
      const { data } = m
      const stored = data.get(rule.id)!
      stored['createdAt'] = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
      stored['lastAppliedAt'] = null

      const decayed = await engine.decayStaleRules(30, 0.5)
      expect(decayed).toBe(1)
      const updated = data.get(rule.id)!
      expect((updated['confidence'] as number) < 0.9).toBe(true)
    })

    it('deletes rules when decayed below 0.1', async () => {
      const rule = await engine.addRule({
        content: 'to-be-deleted rule',
        scope: [],
        confidence: 0.11,
      })
      const stored = m.data.get(rule.id)!
      stored['createdAt'] = new Date(0).toISOString()
      stored['lastAppliedAt'] = null

      await engine.decayStaleRules(30, 0.5)
      expect(m.data.has(rule.id)).toBe(false)
    })

    it('uses lastAppliedAt when present (instead of createdAt)', async () => {
      const rule = await engine.addRule({ content: 'uses last applied rule', scope: [] })
      const stored = m.data.get(rule.id)!
      stored['createdAt'] = new Date(0).toISOString()
      stored['lastAppliedAt'] = new Date().toISOString() // recent
      // With lastAppliedAt recent, rule should NOT decay
      const decayed = await engine.decayStaleRules(1, 0.5)
      expect(decayed).toBe(0)
    })
  })

  describe('count', () => {
    it('returns 0 on store error', async () => {
      const bad = new DynamicRuleEngine({ store: failingStore() })
      expect(await bad.count()).toBe(0)
    })
  })

  describe('storeWithDedup — branch cases', () => {
    it('boosts confidence of a similar existing rule (Jaccard >= threshold)', async () => {
      await engine.addRule({
        content: 'always validate Zod schemas for request bodies',
        scope: [],
        confidence: 0.5,
      })

      const dup = await engine.addRule({
        content: 'always validate Zod schemas for request bodies',
        scope: [],
        confidence: 0.5,
      })
      // First one should have had its confidence boosted
      const all = await engine.getRulesForContext({})
      const rule = all.find((r) => r.id === dup.id)!
      expect(rule.confidence).toBeGreaterThan(0.5)
    })

    it('stores as new when no similar rule exists', async () => {
      await engine.addRule({ content: 'first unique phrase', scope: [] })
      await engine.addRule({ content: 'totally separate topic', scope: [] })
      expect(await engine.count()).toBe(2)
    })

    it('swallows errors when loadAllRules throws', async () => {
      const bad = new DynamicRuleEngine({ store: failingStore() })
      await expect(
        bad.addRule({ content: 'x', scope: [] }),
      ).resolves.toBeDefined()
    })
  })
})
