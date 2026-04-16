import { describe, it, expect } from 'vitest'
import { PolicyEvaluator } from '../security/policy/policy-evaluator.js'
import { InMemoryPolicyStore } from '../security/policy/policy-types.js'
import type {
  PolicySet,
  PolicyContext,
  PolicyRule,
} from '../security/policy/policy-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicySet(rules: PolicyRule[], overrides?: Partial<PolicySet>): PolicySet {
  return {
    id: 'test-set',
    name: 'Test Policy Set',
    version: 1,
    rules,
    active: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeContext(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    principal: { type: 'agent', id: 'agent-1' },
    action: 'runs.create',
    resource: 'project/my-app',
    environment: {},
    ...overrides,
  }
}

function allowRule(id: string, actions: string[], extra?: Partial<PolicyRule>): PolicyRule {
  return { id, effect: 'allow', actions, ...extra }
}

function denyRule(id: string, actions: string[], extra?: Partial<PolicyRule>): PolicyRule {
  return { id, effect: 'deny', actions, ...extra }
}

// ---------------------------------------------------------------------------
// PolicyEvaluator — extended coverage
// ---------------------------------------------------------------------------

describe('PolicyEvaluator — extended coverage', () => {
  const evaluator = new PolicyEvaluator()

  // -----------------------------------------------------------------------
  // Empty rule set
  // -----------------------------------------------------------------------

  describe('empty rule set', () => {
    it('denies by default with empty rules array', () => {
      const ps = makePolicySet([])
      const decision = evaluator.evaluate(ps, makeContext())
      expect(decision.effect).toBe('deny')
      expect(decision.matchedRules).toHaveLength(0)
      expect(decision.decidingRule).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // Condition operator edge cases
  // -----------------------------------------------------------------------

  describe('condition operator edge cases', () => {
    it('gt returns false when actual is not a number', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.val', operator: 'gt', value: 10 }],
        }),
      ])
      const ctx = makeContext({ environment: { val: 'not-a-number' } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('gt returns false when expected is not a number', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.val', operator: 'gt', value: 'ten' as unknown as number }],
        }),
      ])
      const ctx = makeContext({ environment: { val: 20 } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('lt returns false when actual is not a number', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.val', operator: 'lt', value: 10 }],
        }),
      ])
      const ctx = makeContext({ environment: { val: true } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('lte returns false for non-numeric types', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.val', operator: 'lte', value: 10 }],
        }),
      ])
      const ctx = makeContext({ environment: { val: null } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('gte returns false for non-numeric types', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.val', operator: 'gte', value: 10 }],
        }),
      ])
      const ctx = makeContext({ environment: { val: undefined } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('in returns false when expected is not an array', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.val', operator: 'in', value: 'not-array' }],
        }),
      ])
      const ctx = makeContext({ environment: { val: 'something' } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('not_in returns false when expected is not an array', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.val', operator: 'not_in', value: 'not-array' }],
        }),
      ])
      const ctx = makeContext({ environment: { val: 'something' } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('contains returns false when actual is neither string nor array', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.val', operator: 'contains', value: 'x' }],
        }),
      ])
      const ctx = makeContext({ environment: { val: 42 } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('contains returns false when actual is null', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.val', operator: 'contains', value: 'x' }],
        }),
      ])
      const ctx = makeContext({ environment: { val: null } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('glob returns false when actual is not a string', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.val', operator: 'glob', value: '*' }],
        }),
      ])
      const ctx = makeContext({ environment: { val: 123 } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('regex returns false on invalid regex pattern', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.val', operator: 'regex', value: '([invalid' }],
        }),
      ])
      const ctx = makeContext({ environment: { val: 'test' } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('regex returns false when actual is not a string', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.val', operator: 'regex', value: '.*' }],
        }),
      ])
      const ctx = makeContext({ environment: { val: 42 } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('eq handles undefined field (missing from context)', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.nonexistent', operator: 'eq', value: undefined }],
        }),
      ])
      const ctx = makeContext({ environment: {} })
      // undefined === undefined -> true
      expect(evaluator.evaluate(ps, ctx).effect).toBe('allow')
    })

    it('neq detects difference between undefined and a value', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.nonexistent', operator: 'neq', value: 'something' }],
        }),
      ])
      const ctx = makeContext({ environment: {} })
      // undefined !== 'something' -> true
      expect(evaluator.evaluate(ps, ctx).effect).toBe('allow')
    })
  })

  // -----------------------------------------------------------------------
  // Field resolution
  // -----------------------------------------------------------------------

  describe('field resolution', () => {
    it('resolves deeply nested dotted paths', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.a.b.c', operator: 'eq', value: 'deep' }],
        }),
      ])
      const ctx = makeContext({ environment: { a: { b: { c: 'deep' } } } as Record<string, unknown> })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('allow')
    })

    it('returns undefined for path through non-object', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.a.b', operator: 'eq', value: undefined }],
        }),
      ])
      const ctx = makeContext({ environment: { a: 'string-not-object' } })
      // Can't traverse through a string, so field resolves to undefined
      expect(evaluator.evaluate(ps, ctx).effect).toBe('allow')
    })

    it('resolves top-level principal fields via dotted path', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'principal.id', operator: 'eq', value: 'agent-1' }],
        }),
      ])
      expect(evaluator.evaluate(ps, makeContext()).effect).toBe('allow')
    })

    it('resolves action field directly', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'action', operator: 'eq', value: 'runs.create' }],
        }),
      ])
      expect(evaluator.evaluate(ps, makeContext()).effect).toBe('allow')
    })
  })

  // -----------------------------------------------------------------------
  // Resource matching edge cases
  // -----------------------------------------------------------------------

  describe('resource matching edge cases', () => {
    it('denies when rule specifies resources but context has none', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], { resources: ['project/*'] }),
      ])
      const ctx = makeContext({ resource: undefined })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })

    it('matches with ** glob pattern for deep paths', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], { resources: ['org/**'] }),
      ])
      const ctx = makeContext({ resource: 'org/team/project' })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('allow')
    })
  })

  // -----------------------------------------------------------------------
  // Principal matching edge cases
  // -----------------------------------------------------------------------

  describe('principal matching edge cases', () => {
    it('rule without principals matches any principal', () => {
      const ps = makePolicySet([allowRule('r1', ['runs.create'])])
      const ctx = makeContext({ principal: { type: 'service', id: 'svc-1' } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('allow')
    })

    it('empty types array still matches (types check skipped)', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], { principals: { types: [] } }),
      ])
      expect(evaluator.evaluate(ps, makeContext()).effect).toBe('allow')
    })

    it('empty ids array still matches (ids check skipped)', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], { principals: { ids: [] } }),
      ])
      expect(evaluator.evaluate(ps, makeContext()).effect).toBe('allow')
    })

    it('empty roles array still matches (roles check skipped)', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], { principals: { roles: [] } }),
      ])
      expect(evaluator.evaluate(ps, makeContext()).effect).toBe('allow')
    })

    it('principal with no roles fails role check', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], { principals: { roles: ['admin'] } }),
      ])
      // principal has no roles field
      const ctx = makeContext({ principal: { type: 'agent', id: 'a1' } })
      expect(evaluator.evaluate(ps, ctx).effect).toBe('deny')
    })
  })

  // -----------------------------------------------------------------------
  // Multiple matching rules
  // -----------------------------------------------------------------------

  describe('multiple matching rules', () => {
    it('returns all matching rules in matchedRules', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.*'], { priority: 1 }),
        allowRule('r2', ['*'], { priority: 2 }),
        allowRule('r3', ['runs.create'], { priority: 3 }),
      ])
      const decision = evaluator.evaluate(ps, makeContext())
      expect(decision.matchedRules).toHaveLength(3)
      expect(decision.decidingRule?.id).toBe('r3') // highest priority
    })

    it('deny in lower-priority rule still overrides all allows', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], { priority: 100 }),
        allowRule('r2', ['runs.create'], { priority: 50 }),
        denyRule('r3', ['runs.create'], { priority: 1 }),
      ])
      const decision = evaluator.evaluate(ps, makeContext())
      expect(decision.effect).toBe('deny')
      expect(decision.decidingRule?.id).toBe('r3')
    })
  })

  // -----------------------------------------------------------------------
  // Glob matching edge cases
  // -----------------------------------------------------------------------

  describe('glob matching', () => {
    it('escapes regex special chars in glob pattern', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.path', operator: 'glob', value: 'file(1).txt' }],
        }),
      ])
      // Should match exactly
      expect(evaluator.evaluate(ps, makeContext({ environment: { path: 'file(1).txt' } })).effect).toBe('allow')
      // Should not match without parens
      expect(evaluator.evaluate(ps, makeContext({ environment: { path: 'file1.txt' } })).effect).toBe('deny')
    })

    it('single * does not cross dot boundaries in glob condition', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.path', operator: 'glob', value: 'a.*' }],
        }),
      ])
      expect(evaluator.evaluate(ps, makeContext({ environment: { path: 'a.b' } })).effect).toBe('allow')
      // * should not match across dots
      expect(evaluator.evaluate(ps, makeContext({ environment: { path: 'a.b.c' } })).effect).toBe('deny')
    })

    it('** crosses dot boundaries in glob condition', () => {
      const ps = makePolicySet([
        allowRule('r1', ['runs.create'], {
          conditions: [{ field: 'environment.path', operator: 'glob', value: 'a.**' }],
        }),
      ])
      expect(evaluator.evaluate(ps, makeContext({ environment: { path: 'a.b.c.d' } })).effect).toBe('allow')
    })
  })

  // -----------------------------------------------------------------------
  // Validation edge cases
  // -----------------------------------------------------------------------

  describe('validation edge cases', () => {
    it('validates condition with missing field', () => {
      const ps = makePolicySet([
        {
          id: 'r1',
          effect: 'allow' as const,
          actions: ['x'],
          conditions: [{ field: '', operator: 'eq', value: 1 }],
        },
      ])
      const result = evaluator.validate(ps)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('missing field'))).toBe(true)
    })

    it('validates condition with missing operator', () => {
      const ps = makePolicySet([
        {
          id: 'r1',
          effect: 'allow' as const,
          actions: ['x'],
          conditions: [{ field: 'a', operator: '' as 'eq', value: 1 }],
        },
      ])
      const result = evaluator.validate(ps)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('missing operator'))).toBe(true)
    })

    it('validates rules not being an array', () => {
      const ps = {
        id: 'ps1',
        name: 'Bad',
        version: 1,
        rules: 'not-an-array',
        active: true,
        createdAt: '',
        updatedAt: '',
      } as unknown as PolicySet
      const result = evaluator.validate(ps)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('rules must be an array'))).toBe(true)
    })

    it('validates a clean policy set with multiple valid rules', () => {
      const ps = makePolicySet([
        allowRule('r1', ['a']),
        denyRule('r2', ['b']),
        allowRule('r3', ['c'], { priority: 10, expiresAt: '2099-12-31T23:59:59Z' }),
      ])
      const result = evaluator.validate(ps)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // InMemoryPolicyStore — extended
  // -----------------------------------------------------------------------

  describe('InMemoryPolicyStore — extended', () => {
    it('getVersions returns empty array for unknown id', async () => {
      const store = new InMemoryPolicyStore()
      const versions = await store.getVersions('nonexistent')
      expect(versions).toEqual([])
    })

    it('save stores a copy, not a reference', async () => {
      const store = new InMemoryPolicyStore()
      const ps = makePolicySet([allowRule('r1', ['x'])])
      await store.save(ps)

      // Mutate the original
      ps.name = 'Mutated'
      const retrieved = await store.get('test-set')
      expect(retrieved?.name).toBe('Test Policy Set')
    })

    it('list returns empty array when no policies stored', async () => {
      const store = new InMemoryPolicyStore()
      const all = await store.list()
      expect(all).toEqual([])
    })

    it('delete then list is consistent', async () => {
      const store = new InMemoryPolicyStore()
      await store.save(makePolicySet([], { id: 'a' }))
      await store.save(makePolicySet([], { id: 'b' }))
      await store.delete('a')
      const all = await store.list()
      expect(all).toHaveLength(1)
      expect(all[0]?.id).toBe('b')
    })
  })
})
