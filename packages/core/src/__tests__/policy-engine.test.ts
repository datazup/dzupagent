import { describe, it, expect } from 'vitest'
import { PolicyEvaluator } from '../security/policy/policy-evaluator.js'
import { InMemoryPolicyStore } from '../security/policy/policy-types.js'
import { PolicyTranslator } from '../security/policy/policy-translator.js'
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
// PolicyEvaluator
// ---------------------------------------------------------------------------

describe('PolicyEvaluator', () => {
  const evaluator = new PolicyEvaluator()

  // --- Core semantics ---

  it('default-deny when no rules match', () => {
    const ps = makePolicySet([allowRule('r1', ['tools.read'])])
    const decision = evaluator.evaluate(ps, makeContext())
    expect(decision.effect).toBe('deny')
    expect(decision.matchedRules).toHaveLength(0)
    expect(decision.decidingRule).toBeUndefined()
  })

  it('allows when a matching allow rule exists', () => {
    const ps = makePolicySet([allowRule('r1', ['runs.create'])])
    const decision = evaluator.evaluate(ps, makeContext())
    expect(decision.effect).toBe('allow')
    expect(decision.matchedRules).toHaveLength(1)
    expect(decision.decidingRule?.id).toBe('r1')
  })

  it('deny-overrides: deny wins over allow', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create']),
      denyRule('r2', ['runs.create']),
    ])
    const decision = evaluator.evaluate(ps, makeContext())
    expect(decision.effect).toBe('deny')
    expect(decision.decidingRule?.id).toBe('r2')
    expect(decision.matchedRules).toHaveLength(2)
  })

  it('deny-overrides even when allow has higher priority', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], { priority: 100 }),
      denyRule('r2', ['runs.create'], { priority: 1 }),
    ])
    const decision = evaluator.evaluate(ps, makeContext())
    expect(decision.effect).toBe('deny')
    expect(decision.decidingRule?.id).toBe('r2')
  })

  // --- Priority ordering ---

  it('uses highest-priority allow as deciding rule when no deny', () => {
    const ps = makePolicySet([
      allowRule('r-low', ['runs.*'], { priority: 1, description: 'low' }),
      allowRule('r-high', ['runs.*'], { priority: 10, description: 'high' }),
    ])
    const decision = evaluator.evaluate(ps, makeContext())
    expect(decision.effect).toBe('allow')
    expect(decision.decidingRule?.id).toBe('r-high')
  })

  // --- Principal matching ---

  it('matches principal by type', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], { principals: { types: ['agent'] } }),
    ])
    expect(evaluator.evaluate(ps, makeContext()).effect).toBe('allow')

    const ctx2 = makeContext({ principal: { type: 'user', id: 'user-1' } })
    expect(evaluator.evaluate(ps, ctx2).effect).toBe('deny')
  })

  it('matches principal by id', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], { principals: { ids: ['agent-1', 'agent-2'] } }),
    ])
    expect(evaluator.evaluate(ps, makeContext()).effect).toBe('allow')

    const ctx2 = makeContext({ principal: { type: 'agent', id: 'agent-99' } })
    expect(evaluator.evaluate(ps, ctx2).effect).toBe('deny')
  })

  it('matches principal by roles (any overlap)', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], { principals: { roles: ['admin', 'editor'] } }),
    ])
    const ctx = makeContext({ principal: { type: 'user', id: 'u1', roles: ['viewer', 'editor'] } })
    expect(evaluator.evaluate(ps, ctx).effect).toBe('allow')

    const ctx2 = makeContext({ principal: { type: 'user', id: 'u2', roles: ['viewer'] } })
    expect(evaluator.evaluate(ps, ctx2).effect).toBe('deny')
  })

  // --- Action matching ---

  it('matches actions exactly', () => {
    const ps = makePolicySet([allowRule('r1', ['runs.create'])])
    expect(evaluator.evaluate(ps, makeContext({ action: 'runs.create' })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ action: 'runs.delete' })).effect).toBe('deny')
  })

  it('matches actions with glob patterns', () => {
    const ps = makePolicySet([allowRule('r1', ['runs.*'])])
    expect(evaluator.evaluate(ps, makeContext({ action: 'runs.create' })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ action: 'runs.delete' })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ action: 'tools.read' })).effect).toBe('deny')
  })

  it('matches wildcard action *', () => {
    const ps = makePolicySet([allowRule('r1', ['*'])])
    expect(evaluator.evaluate(ps, makeContext({ action: 'anything' })).effect).toBe('allow')
  })

  // --- Resource matching ---

  it('matches when no resources specified (applies to all)', () => {
    const ps = makePolicySet([allowRule('r1', ['runs.create'])])
    expect(evaluator.evaluate(ps, makeContext()).effect).toBe('allow')
  })

  it('matches resource exactly', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], { resources: ['project/my-app'] }),
    ])
    expect(evaluator.evaluate(ps, makeContext()).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ resource: 'project/other' })).effect).toBe('deny')
  })

  it('matches resource with glob', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], { resources: ['project/*'] }),
    ])
    expect(evaluator.evaluate(ps, makeContext({ resource: 'project/my-app' })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ resource: 'org/foo' })).effect).toBe('deny')
  })

  // --- Condition operators ---

  it('condition operator: eq', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [{ field: 'environment.region', operator: 'eq', value: 'us-east' }],
      }),
    ])
    const ctx = makeContext({ environment: { region: 'us-east' } })
    expect(evaluator.evaluate(ps, ctx).effect).toBe('allow')

    const ctx2 = makeContext({ environment: { region: 'eu-west' } })
    expect(evaluator.evaluate(ps, ctx2).effect).toBe('deny')
  })

  it('condition operator: neq', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [{ field: 'environment.env', operator: 'neq', value: 'production' }],
      }),
    ])
    expect(evaluator.evaluate(ps, makeContext({ environment: { env: 'staging' } })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ environment: { env: 'production' } })).effect).toBe('deny')
  })

  it('condition operator: gt', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [{ field: 'environment.tokens', operator: 'gt', value: 100 }],
      }),
    ])
    expect(evaluator.evaluate(ps, makeContext({ environment: { tokens: 200 } })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ environment: { tokens: 50 } })).effect).toBe('deny')
  })

  it('condition operator: gte', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [{ field: 'environment.tokens', operator: 'gte', value: 100 }],
      }),
    ])
    expect(evaluator.evaluate(ps, makeContext({ environment: { tokens: 100 } })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ environment: { tokens: 99 } })).effect).toBe('deny')
  })

  it('condition operator: lt', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [{ field: 'environment.cost', operator: 'lt', value: 10 }],
      }),
    ])
    expect(evaluator.evaluate(ps, makeContext({ environment: { cost: 5 } })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ environment: { cost: 15 } })).effect).toBe('deny')
  })

  it('condition operator: lte', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [{ field: 'environment.cost', operator: 'lte', value: 10 }],
      }),
    ])
    expect(evaluator.evaluate(ps, makeContext({ environment: { cost: 10 } })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ environment: { cost: 11 } })).effect).toBe('deny')
  })

  it('condition operator: in', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [{ field: 'environment.env', operator: 'in', value: ['dev', 'staging'] }],
      }),
    ])
    expect(evaluator.evaluate(ps, makeContext({ environment: { env: 'staging' } })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ environment: { env: 'production' } })).effect).toBe('deny')
  })

  it('condition operator: not_in', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [{ field: 'environment.env', operator: 'not_in', value: ['production'] }],
      }),
    ])
    expect(evaluator.evaluate(ps, makeContext({ environment: { env: 'dev' } })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ environment: { env: 'production' } })).effect).toBe('deny')
  })

  it('condition operator: contains (string)', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [{ field: 'environment.path', operator: 'contains', value: '/api/' }],
      }),
    ])
    expect(evaluator.evaluate(ps, makeContext({ environment: { path: '/v1/api/users' } })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ environment: { path: '/v1/web/home' } })).effect).toBe('deny')
  })

  it('condition operator: contains (array)', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [{ field: 'environment.tags', operator: 'contains', value: 'important' }],
      }),
    ])
    expect(evaluator.evaluate(ps, makeContext({ environment: { tags: ['normal', 'important'] } })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ environment: { tags: ['normal'] } })).effect).toBe('deny')
  })

  it('condition operator: glob', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [{ field: 'environment.path', operator: 'glob', value: '/api/v*' }],
      }),
    ])
    expect(evaluator.evaluate(ps, makeContext({ environment: { path: '/api/v2' } })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ environment: { path: '/web/v2' } })).effect).toBe('deny')
  })

  it('condition operator: regex', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [{ field: 'environment.email', operator: 'regex', value: '^[^@]+@example\\.com$' }],
      }),
    ])
    expect(evaluator.evaluate(ps, makeContext({ environment: { email: 'alice@example.com' } })).effect).toBe('allow')
    expect(evaluator.evaluate(ps, makeContext({ environment: { email: 'alice@evil.com' } })).effect).toBe('deny')
  })

  // --- Expired rules ---

  it('skips expired rules', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], { expiresAt: '2020-01-01T00:00:00Z' }),
    ])
    expect(evaluator.evaluate(ps, makeContext()).effect).toBe('deny')
  })

  it('includes non-expired rules', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], { expiresAt: '2099-01-01T00:00:00Z' }),
    ])
    expect(evaluator.evaluate(ps, makeContext()).effect).toBe('allow')
  })

  // --- Evaluation time tracking ---

  it('tracks evaluation time in microseconds', () => {
    const ps = makePolicySet([allowRule('r1', ['runs.create'])])
    const decision = evaluator.evaluate(ps, makeContext())
    expect(typeof decision.evaluationTimeUs).toBe('number')
    expect(decision.evaluationTimeUs).toBeGreaterThanOrEqual(0)
  })

  // --- Validate ---

  it('validates a valid policy set', () => {
    const ps = makePolicySet([allowRule('r1', ['runs.create'])])
    const result = evaluator.validate(ps)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates invalid policy set: missing id', () => {
    const ps = makePolicySet([{ id: '', effect: 'allow', actions: ['x'] }])
    const result = evaluator.validate(ps)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('missing or invalid id'))).toBe(true)
  })

  it('validates invalid policy set: bad effect', () => {
    const ps = makePolicySet([{ id: 'r1', effect: 'maybe' as 'allow', actions: ['x'] }])
    const result = evaluator.validate(ps)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('effect must be'))).toBe(true)
  })

  it('validates invalid policy set: empty actions', () => {
    const ps = makePolicySet([{ id: 'r1', effect: 'allow', actions: [] }])
    const result = evaluator.validate(ps)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('actions must be a non-empty array'))).toBe(true)
  })

  it('validates invalid policy set: duplicate rule ids', () => {
    const ps = makePolicySet([
      allowRule('dup', ['x']),
      allowRule('dup', ['y']),
    ])
    const result = evaluator.validate(ps)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('duplicate id'))).toBe(true)
  })

  it('validates invalid policy set: invalid expiresAt', () => {
    const ps = makePolicySet([
      allowRule('r1', ['x'], { expiresAt: 'not-a-date' }),
    ])
    const result = evaluator.validate(ps)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('invalid expiresAt'))).toBe(true)
  })

  it('validates invalid policy set: missing PolicySet fields', () => {
    const ps = { id: '', name: '', version: 'x', rules: [], active: true, createdAt: '', updatedAt: '' } as unknown as PolicySet
    const result = evaluator.validate(ps)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('missing id'))).toBe(true)
    expect(result.errors.some((e) => e.includes('missing name'))).toBe(true)
    expect(result.errors.some((e) => e.includes('version must be a number'))).toBe(true)
  })

  // --- Multiple conditions (AND) ---

  it('requires all conditions to match (AND logic)', () => {
    const ps = makePolicySet([
      allowRule('r1', ['runs.create'], {
        conditions: [
          { field: 'environment.region', operator: 'eq', value: 'us-east' },
          { field: 'environment.cost', operator: 'lt', value: 100 },
        ],
      }),
    ])
    // Both match
    expect(evaluator.evaluate(ps, makeContext({ environment: { region: 'us-east', cost: 50 } })).effect).toBe('allow')
    // Only first matches
    expect(evaluator.evaluate(ps, makeContext({ environment: { region: 'us-east', cost: 200 } })).effect).toBe('deny')
    // Only second matches
    expect(evaluator.evaluate(ps, makeContext({ environment: { region: 'eu-west', cost: 50 } })).effect).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// InMemoryPolicyStore
// ---------------------------------------------------------------------------

describe('InMemoryPolicyStore', () => {
  it('save and get returns latest version', async () => {
    const store = new InMemoryPolicyStore()
    const ps1 = makePolicySet([], { version: 1 })
    const ps2 = makePolicySet([], { version: 2 })
    await store.save(ps1)
    await store.save(ps2)

    const latest = await store.get('test-set')
    expect(latest?.version).toBe(2)
  })

  it('get returns undefined for non-existent id', async () => {
    const store = new InMemoryPolicyStore()
    expect(await store.get('nope')).toBeUndefined()
  })

  it('list returns latest version of each set', async () => {
    const store = new InMemoryPolicyStore()
    await store.save(makePolicySet([], { id: 'a', version: 1 }))
    await store.save(makePolicySet([], { id: 'a', version: 2 }))
    await store.save(makePolicySet([], { id: 'b', version: 1 }))

    const all = await store.list()
    expect(all).toHaveLength(2)
    const a = all.find((p) => p.id === 'a')
    expect(a?.version).toBe(2)
  })

  it('getVersions returns all versions', async () => {
    const store = new InMemoryPolicyStore()
    await store.save(makePolicySet([], { version: 1 }))
    await store.save(makePolicySet([], { version: 2 }))
    await store.save(makePolicySet([], { version: 3 }))

    const versions = await store.getVersions('test-set')
    expect(versions).toHaveLength(3)
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3])
  })

  it('delete removes all versions and returns true', async () => {
    const store = new InMemoryPolicyStore()
    await store.save(makePolicySet([], { version: 1 }))
    const deleted = await store.delete('test-set')
    expect(deleted).toBe(true)
    expect(await store.get('test-set')).toBeUndefined()
  })

  it('delete returns false for non-existent id', async () => {
    const store = new InMemoryPolicyStore()
    expect(await store.delete('nope')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PolicyTranslator
// ---------------------------------------------------------------------------

describe('PolicyTranslator', () => {
  it('translate: parses LLM JSON response into PolicyTranslationResult', async () => {
    const mockRule: PolicyRule = {
      id: 'no-prod-delete',
      effect: 'deny',
      actions: ['runs.delete'],
      resources: ['production/*'],
      description: 'Deny deleting production runs',
    }
    const mockResponse = JSON.stringify({
      rule: mockRule,
      confidence: 0.92,
      explanation: 'This rule prevents deletion of production runs.',
    })

    const translator = new PolicyTranslator({
      llm: async () => mockResponse,
    })

    const result = await translator.translate('No one should be able to delete production runs')
    expect(result.rule.id).toBe('no-prod-delete')
    expect(result.rule.effect).toBe('deny')
    expect(result.confidence).toBe(0.92)
    expect(result.explanation).toBe('This rule prevents deletion of production runs.')
  })

  it('translate: throws POLICY_INVALID on non-JSON response', async () => {
    const translator = new PolicyTranslator({
      llm: async () => 'I cannot generate that policy.',
    })

    await expect(translator.translate('something')).rejects.toThrow('invalid JSON')
  })

  it('translate: throws POLICY_INVALID when rule field is missing', async () => {
    const translator = new PolicyTranslator({
      llm: async () => JSON.stringify({ notRule: {} }),
    })

    await expect(translator.translate('something')).rejects.toThrow('missing "rule" field')
  })

  it('translate: defaults confidence to 0.5 and explanation to empty string if absent', async () => {
    const translator = new PolicyTranslator({
      llm: async () => JSON.stringify({ rule: { id: 'r1', effect: 'allow', actions: ['x'] } }),
    })

    const result = await translator.translate('allow x')
    expect(result.confidence).toBe(0.5)
    expect(result.explanation).toBe('')
  })

  it('explain: returns LLM explanation text', async () => {
    const translator = new PolicyTranslator({
      llm: async (prompt) => {
        expect(prompt).toContain('no-prod-delete')
        return '  This rule prevents deletion of production runs.  '
      },
    })

    const rule: PolicyRule = {
      id: 'no-prod-delete',
      effect: 'deny',
      actions: ['runs.delete'],
    }
    const explanation = await translator.explain(rule)
    expect(explanation).toBe('This rule prevents deletion of production runs.')
  })
})
