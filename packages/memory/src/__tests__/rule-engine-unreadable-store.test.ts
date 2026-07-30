/* eslint-disable no-restricted-syntax -- These are BaseStore doubles, not memory
 * services. The whole point of this file is a store whose reads REJECT, which
 * createMemoryHarness() (a real MemoryService over a working InMemoryStore)
 * cannot express. Assertions read the backing Map and put() effects, never a
 * spy call count, so the rule's rationale does not apply here. */
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

/** A store whose reads fail but whose writes succeed, isolating the read path. */
function unreadableStore(data = new Map<string, Record<string, unknown>>()) {
  return {
    store: {
      search: vi.fn().mockRejectedValue(new Error('store unavailable')),
      put: vi.fn(async (_ns: string[], key: string, value: Record<string, unknown>) => {
        data.set(key, value)
      }),
      delete: vi.fn(async () => {}),
      get: vi.fn().mockRejectedValue(new Error('store unavailable')),
    } as unknown as BaseStore,
    data,
  }
}

describe('DynamicRuleEngine — an unreadable store is not an empty one', () => {
  let m: ReturnType<typeof mockStore>
  let engine: DynamicRuleEngine

  beforeEach(() => {
    m = mockStore()
    engine = new DynamicRuleEngine({ store: m.store })
  })

  describe('retrieveRulesForContext', () => {
    it('reports rulesUnavailable when the store cannot be read', async () => {
      const bad = new DynamicRuleEngine({ store: unreadableStore().store })

      const result = await bad.retrieveRulesForContext({})

      expect(result.rulesUnavailable).toBe(true)
      expect(result.rules).toEqual([])
    })

    it('reports rulesUnavailable as false for a genuinely empty store', async () => {
      // The converse. Without this, `rulesUnavailable: true` on every call
      // would also satisfy the test above.
      const result = await engine.retrieveRulesForContext({})

      expect(result.rulesUnavailable).toBe(false)
      expect(result.rules).toEqual([])
    })

    it('reports rulesUnavailable as false when rules are returned', async () => {
      await engine.addRule({ content: 'validate all inputs', scope: ['n1'] })

      const result = await engine.retrieveRulesForContext({ nodeId: 'n1' })

      expect(result.rulesUnavailable).toBe(false)
      expect(result.rules).toHaveLength(1)
    })

    it('distinguishes an outage from a cold start, which are otherwise identical', async () => {
      // Both produce zero rules and an empty prompt section. The only thing
      // separating "we know of no rules" from "we could not look" is the flag,
      // so a consumer must never conclude "no rules" from length alone.
      const coldStart = await engine.retrieveRulesForContext({})
      const outage = await new DynamicRuleEngine({
        store: unreadableStore().store,
      }).retrieveRulesForContext({})

      expect(coldStart.rules).toEqual(outage.rules)
      expect(engine.formatForPrompt(coldStart.rules)).toBe(
        engine.formatForPrompt(outage.rules),
      )
      expect(coldStart.rulesUnavailable).not.toBe(outage.rulesUnavailable)
    })
  })

  describe('getRulesForContext — the pinned contract still holds', () => {
    it('still resolves to a bare array on store failure', async () => {
      const bad = new DynamicRuleEngine({ store: unreadableStore().store })
      await expect(bad.getRulesForContext({})).resolves.toEqual([])
    })

    it('still returns matching rules', async () => {
      await engine.addRule({ content: 'always lint', scope: ['n1'] })
      const rules = await engine.getRulesForContext({ nodeId: 'n1' })
      expect(rules).toHaveLength(1)
    })
  })

  describe('storeWithDedup — does not duplicate against an unreadable corpus', () => {
    it('does not write when novelty cannot be verified', async () => {
      const u = unreadableStore()
      const bad = new DynamicRuleEngine({ store: u.store })

      await bad.addRule({ content: 'always validate Zod schemas', scope: [] })

      // Writing here would create a duplicate of a rule that may already
      // exist, inflating the corpus on every outage.
      expect(u.data.size).toBe(0)
    })

    it('still resolves rather than throwing when the store is unreadable', async () => {
      const bad = new DynamicRuleEngine({ store: unreadableStore().store })
      await expect(
        bad.addRule({ content: 'x', scope: [] }),
      ).resolves.toBeDefined()
    })

    it('still writes when the corpus is readable and the rule is new', async () => {
      // The converse of the no-write assertion: proves the guard rejects only
      // the unreadable case, not every write.
      await engine.addRule({ content: 'a distinctive new rule', scope: [] })
      expect(m.data.size).toBe(1)
    })
  })
})
