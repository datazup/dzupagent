import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DynamicRuleEngine } from '../rule-engine.js'
import type { Rule } from '../rule-engine.js'
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Mock store factory (mirrors lesson-pipeline.test.ts pattern)
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

describe('DynamicRuleEngine', () => {
  let store: ReturnType<typeof createMockStore>
  let engine: DynamicRuleEngine

  beforeEach(() => {
    store = createMockStore()
    engine = new DynamicRuleEngine({ store })
  })

  // ---- learnFromError ------------------------------------------------------

  describe('learnFromError', () => {
    it('should create a rule from an error and its resolution', async () => {
      const rule = await engine.learnFromError({
        errorType: 'ValidationError',
        errorMessage: 'Missing Zod schema for request body',
        resolution: 'always include Zod validation for request bodies',
        nodeId: 'gen_backend',
        taskType: 'payment',
      })

      expect(rule.source).toBe('error')
      expect(rule.confidence).toBe(0.7)
      expect(rule.content).toBe('When ValidationError occurs at gen_backend: always include Zod validation for request bodies')
      expect(rule.scope).toContain('gen_backend')
      expect(rule.scope).toContain('payment')
      expect(rule.applyCount).toBe(0)
      expect(rule.successRate).toBe(1)
      expect(rule.id).toMatch(/^rule_\d+_\w+$/)

      // Verify it was stored
      expect(store.put).toHaveBeenCalled()
      expect(await engine.count()).toBe(1)
    })

    it('should create a rule without taskType', async () => {
      const rule = await engine.learnFromError({
        errorType: 'TypeCheckError',
        errorMessage: 'Missing import',
        resolution: 'add missing import statement',
        nodeId: 'gen_backend',
      })

      expect(rule.scope).toEqual(['gen_backend'])
      expect(rule.scope).not.toContain(undefined)
    })
  })

  // ---- addRule -------------------------------------------------------------

  describe('addRule', () => {
    it('should add a human-defined rule with defaults', async () => {
      const rule = await engine.addRule({
        content: 'Always use strict TypeScript mode',
        scope: ['gen_backend', 'gen_frontend'],
      })

      expect(rule.source).toBe('human')
      expect(rule.confidence).toBe(0.8)
      expect(rule.content).toBe('Always use strict TypeScript mode')
      expect(rule.scope).toEqual(['gen_backend', 'gen_frontend'])
      expect(rule.applyCount).toBe(0)
      expect(rule.successRate).toBe(1)
      expect(await engine.count()).toBe(1)
    })

    it('should add a convention-sourced rule with custom confidence', async () => {
      const rule = await engine.addRule({
        content: 'Use camelCase for variable names',
        scope: ['gen_backend'],
        source: 'convention',
        confidence: 0.95,
      })

      expect(rule.source).toBe('convention')
      expect(rule.confidence).toBe(0.95)
    })

    it('should clamp confidence to [0, 1]', async () => {
      const rule = await engine.addRule({
        content: 'Test rule',
        scope: [],
        confidence: 1.5,
      })

      expect(rule.confidence).toBeLessThanOrEqual(1.0)
    })
  })

  // ---- getRulesForContext ---------------------------------------------------

  describe('getRulesForContext', () => {
    beforeEach(async () => {
      await engine.learnFromError({
        errorType: 'ValidationError',
        errorMessage: 'Missing Zod schema',
        resolution: 'add Zod validation',
        nodeId: 'gen_backend',
        taskType: 'payment',
      })

      await engine.addRule({
        content: 'Always use strict TypeScript mode',
        scope: ['gen_backend', 'gen_frontend'],
        confidence: 0.9,
      })

      await engine.addRule({
        content: 'Include aria labels on interactive elements',
        scope: ['gen_frontend'],
        confidence: 0.85,
      })
    })

    it('should filter by nodeId', async () => {
      const rules = await engine.getRulesForContext({ nodeId: 'gen_frontend' })
      expect(rules.length).toBe(2) // strict TS mode + aria labels
      expect(rules.every(r => r.scope.some(s => s.toLowerCase() === 'gen_frontend'))).toBe(true)
    })

    it('should filter by taskType', async () => {
      const rules = await engine.getRulesForContext({ taskType: 'payment' })
      expect(rules.length).toBe(1)
      expect(rules[0]!.content).toContain('Zod validation')
    })

    it('should return all rules above minConfidence when no filter provided', async () => {
      const rules = await engine.getRulesForContext({})
      expect(rules.length).toBe(3)
    })

    it('should respect the limit parameter', async () => {
      const rules = await engine.getRulesForContext({ limit: 1 })
      expect(rules.length).toBe(1)
    })

    it('should sort by confidence * successRate descending', async () => {
      const rules = await engine.getRulesForContext({})
      for (let i = 0; i < rules.length - 1; i++) {
        const scoreA = rules[i]!.confidence * rules[i]!.successRate
        const scoreB = rules[i + 1]!.confidence * rules[i + 1]!.successRate
        expect(scoreA).toBeGreaterThanOrEqual(scoreB)
      }
    })

    it('should exclude rules below minConfidence', async () => {
      // Add a low-confidence rule
      await engine.addRule({
        content: 'Maybe do this thing',
        scope: ['gen_backend'],
        confidence: 0.3,
      })

      const rules = await engine.getRulesForContext({ nodeId: 'gen_backend' })
      expect(rules.every(r => r.confidence >= 0.5)).toBe(true)
    })

    it('should respect custom minConfidence in config', async () => {
      const strictEngine = new DynamicRuleEngine({
        store,
        minConfidence: 0.85,
      })

      const rules = await strictEngine.getRulesForContext({})
      // Only the 0.9 and 0.85 rules should pass (not the 0.7 error rule)
      expect(rules.every(r => r.confidence >= 0.85)).toBe(true)
    })
  })

  // ---- formatForPrompt -----------------------------------------------------

  describe('formatForPrompt', () => {
    it('should format rules as markdown bullet list', () => {
      const rules: Rule[] = [
        {
          id: 'r1',
          source: 'error',
          content: 'Always validate payment inputs with Zod',
          scope: ['gen_backend'],
          confidence: 0.9,
          applyCount: 3,
          successRate: 0.85,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'r2',
          source: 'human',
          content: 'Use explicit return types',
          scope: ['gen_backend'],
          confidence: 0.75,
          applyCount: 1,
          successRate: 1,
          createdAt: new Date().toISOString(),
        },
      ]

      const result = engine.formatForPrompt(rules)

      expect(result).toContain('## Dynamic Rules')
      expect(result).toContain('- [90%] Always validate payment inputs with Zod')
      expect(result).toContain('- [75%] Use explicit return types')
    })

    it('should return empty string for empty rules', () => {
      expect(engine.formatForPrompt([])).toBe('')
    })

    it('should round confidence percentages', () => {
      const rules: Rule[] = [{
        id: 'r1',
        source: 'eval',
        content: 'Test rule',
        scope: [],
        confidence: 0.333,
        applyCount: 0,
        successRate: 1,
        createdAt: new Date().toISOString(),
      }]

      const result = engine.formatForPrompt(rules)
      expect(result).toContain('[33%]')
    })
  })

  // ---- recordApplication ---------------------------------------------------

  describe('recordApplication', () => {
    it('should update applyCount and successRate on success', async () => {
      const rule = await engine.learnFromError({
        errorType: 'ValidationError',
        errorMessage: 'Missing schema',
        resolution: 'add Zod validation',
        nodeId: 'gen_backend',
      })

      await engine.recordApplication(rule.id, true)

      const rules = await engine.getRulesForContext({ nodeId: 'gen_backend' })
      const updated = rules.find(r => r.id === rule.id)
      expect(updated).toBeDefined()
      expect(updated!.applyCount).toBe(1)
      expect(updated!.successRate).toBe(1) // 1 success out of 1
      expect(updated!.lastAppliedAt).toBeDefined()
    })

    it('should decrease successRate on failure', async () => {
      const rule = await engine.learnFromError({
        errorType: 'ValidationError',
        errorMessage: 'Missing schema',
        resolution: 'add Zod validation',
        nodeId: 'gen_backend',
      })

      await engine.recordApplication(rule.id, true)
      await engine.recordApplication(rule.id, false)

      const rules = await engine.getRulesForContext({ nodeId: 'gen_backend' })
      const updated = rules.find(r => r.id === rule.id)
      expect(updated!.applyCount).toBe(2)
      expect(updated!.successRate).toBe(0.5) // 1 success out of 2
    })

    it('should handle multiple applications correctly', async () => {
      const rule = await engine.learnFromError({
        errorType: 'TypeError',
        errorMessage: 'null reference',
        resolution: 'add null check',
        nodeId: 'gen_backend',
      })

      // 3 successes, 1 failure
      await engine.recordApplication(rule.id, true)
      await engine.recordApplication(rule.id, true)
      await engine.recordApplication(rule.id, true)
      await engine.recordApplication(rule.id, false)

      const rules = await engine.getRulesForContext({ nodeId: 'gen_backend' })
      const updated = rules.find(r => r.id === rule.id)
      expect(updated!.applyCount).toBe(4)
      expect(updated!.successRate).toBe(0.75) // 3 out of 4
    })

    it('should silently handle missing rule IDs', async () => {
      await expect(engine.recordApplication('nonexistent-id', true)).resolves.toBeUndefined()
    })
  })

  // ---- decayStaleRules -----------------------------------------------------

  describe('decayStaleRules', () => {
    it('should decay rules not applied within maxAgeDays', async () => {
      // Create a rule with old createdAt
      const rule = await engine.addRule({
        content: 'Old rule that has not been used',
        scope: ['gen_backend'],
        confidence: 0.8,
      })

      // Manually backdate the rule in the store
      const record = store._data.get(rule.id)!
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
      record['createdAt'] = oldDate
      record['lastAppliedAt'] = null

      const decayed = await engine.decayStaleRules(30, 0.9)
      expect(decayed).toBe(1)

      // Verify confidence was reduced
      const rules = await engine.getRulesForContext({})
      const updated = rules.find(r => r.id === rule.id)
      expect(updated!.confidence).toBeCloseTo(0.72, 1) // 0.8 * 0.9
    })

    it('should not decay recently applied rules', async () => {
      const rule = await engine.addRule({
        content: 'Recent rule',
        scope: ['gen_backend'],
        confidence: 0.8,
      })

      // Rule was just created, so it should not be decayed
      const decayed = await engine.decayStaleRules(30, 0.9)
      expect(decayed).toBe(0)

      const rules = await engine.getRulesForContext({})
      const found = rules.find(r => r.id === rule.id)
      expect(found!.confidence).toBe(0.8)
    })

    it('should delete rules with confidence below 0.1 after decay', async () => {
      const rule = await engine.addRule({
        content: 'Nearly dead rule',
        scope: ['gen_backend'],
        confidence: 0.09, // Will drop below 0.1 after decay
      })

      // Backdate
      const record = store._data.get(rule.id)!
      record['createdAt'] = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
      record['lastAppliedAt'] = null
      // Fix the confidence in the store record too
      record['confidence'] = 0.09

      const decayed = await engine.decayStaleRules(30, 0.9)
      expect(decayed).toBe(1)

      // Rule should be deleted
      expect(store.delete).toHaveBeenCalledWith(['rules'], rule.id)
      expect(store._data.has(rule.id)).toBe(false)
    })

    it('should use lastAppliedAt over createdAt when available', async () => {
      const rule = await engine.addRule({
        content: 'Rule applied recently',
        scope: ['gen_backend'],
        confidence: 0.8,
      })

      // Old creation, but recent application
      const record = store._data.get(rule.id)!
      record['createdAt'] = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
      record['lastAppliedAt'] = new Date().toISOString()

      const decayed = await engine.decayStaleRules(30, 0.9)
      expect(decayed).toBe(0)
    })
  })

  // ---- deduplication -------------------------------------------------------

  describe('deduplication', () => {
    it('should merge similar rules instead of creating duplicates', async () => {
      await engine.learnFromError({
        errorType: 'ValidationError',
        errorMessage: 'Missing Zod schema for request body',
        resolution: 'always add Zod validation for request bodies',
        nodeId: 'gen_backend',
      })

      // Very similar rule
      await engine.learnFromError({
        errorType: 'ValidationError',
        errorMessage: 'No Zod schema for request body present',
        resolution: 'always add Zod validation for request bodies',
        nodeId: 'gen_backend',
      })

      expect(await engine.count()).toBe(1)

      // Confidence should have been boosted
      const rules = await engine.getRulesForContext({ nodeId: 'gen_backend' })
      expect(rules[0]!.confidence).toBeGreaterThan(0.7)
    })

    it('should not merge dissimilar rules', async () => {
      await engine.learnFromError({
        errorType: 'ValidationError',
        errorMessage: 'Missing Zod schema',
        resolution: 'add Zod validation for all endpoints',
        nodeId: 'gen_backend',
      })

      await engine.learnFromError({
        errorType: 'RenderError',
        errorMessage: 'Component not found in registry',
        resolution: 'register component globally in main.ts',
        nodeId: 'gen_frontend',
      })

      expect(await engine.count()).toBe(2)
    })

    it('should cap merged confidence at 1.0', async () => {
      // Start with high confidence
      await engine.addRule({
        content: 'Always validate inputs with Zod schema validation',
        scope: ['gen_backend'],
        confidence: 0.95,
      })

      // Similar rule that triggers merge
      await engine.addRule({
        content: 'Always validate inputs with Zod schema validation checks',
        scope: ['gen_backend'],
        confidence: 0.95,
      })

      const rules = await engine.getRulesForContext({ nodeId: 'gen_backend' })
      expect(rules[0]!.confidence).toBeLessThanOrEqual(1.0)
    })
  })

  // ---- count ---------------------------------------------------------------

  describe('count', () => {
    it('should return 0 for empty store', async () => {
      expect(await engine.count()).toBe(0)
    })

    it('should return correct count after insertions', async () => {
      await engine.addRule({ content: 'Rule 1', scope: ['a'] })
      await engine.addRule({ content: 'Rule 2 completely different topic', scope: ['b'] })
      expect(await engine.count()).toBe(2)
    })
  })

  // ---- confidence filtering ------------------------------------------------

  describe('confidence filtering', () => {
    it('should filter out rules below the default minConfidence of 0.5', async () => {
      await engine.addRule({
        content: 'Low confidence rule about something',
        scope: ['gen_backend'],
        confidence: 0.3,
      })

      await engine.addRule({
        content: 'High confidence rule about something else',
        scope: ['gen_backend'],
        confidence: 0.8,
      })

      const rules = await engine.getRulesForContext({ nodeId: 'gen_backend' })
      expect(rules.length).toBe(1)
      expect(rules[0]!.confidence).toBe(0.8)
    })

    it('should use custom minConfidence from config', async () => {
      const strictEngine = new DynamicRuleEngine({
        store,
        minConfidence: 0.9,
      })

      await strictEngine.addRule({
        content: 'Medium confidence rule for testing',
        scope: ['gen_backend'],
        confidence: 0.85,
      })

      await strictEngine.addRule({
        content: 'High confidence rule for testing separately',
        scope: ['gen_backend'],
        confidence: 0.95,
      })

      const rules = await strictEngine.getRulesForContext({ nodeId: 'gen_backend' })
      expect(rules.length).toBe(1)
      expect(rules[0]!.confidence).toBe(0.95)
    })
  })

  // ---- custom namespace ----------------------------------------------------

  describe('custom configuration', () => {
    it('should use custom namespace', async () => {
      const customEngine = new DynamicRuleEngine({
        store,
        namespace: ['custom', 'rules'],
      })

      await customEngine.addRule({
        content: 'Custom namespace rule',
        scope: ['gen_backend'],
      })

      expect(store.put).toHaveBeenCalledWith(
        ['custom', 'rules'],
        expect.stringMatching(/^rule_/),
        expect.objectContaining({ content: 'Custom namespace rule' }),
      )
    })
  })
})
