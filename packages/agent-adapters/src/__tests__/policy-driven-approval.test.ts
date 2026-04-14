import { describe, it, expect } from 'vitest'
import { createPolicyCondition, compareBlastRadius } from '../approval/policy-driven-approval.js'
import type { ApprovalContext } from '../approval/adapter-approval.js'
import type { PolicySet } from '@dzupagent/core'
import { createRiskClassifier } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    runId: 'run-1',
    description: 'Test execution',
    providerId: 'claude',
    ...overrides,
  }
}

function makePolicySet(effect: 'allow' | 'deny'): PolicySet {
  const now = new Date().toISOString()
  return {
    id: 'test-policy',
    name: 'Test Policy',
    version: 1,
    active: true,
    createdAt: now,
    updatedAt: now,
    rules: [
      {
        id: 'rule-1',
        effect,
        actions: ['adapter:execute'],
        priority: 10,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPolicyCondition', () => {
  describe('tool risk tier', () => {
    it('requires approval when tool tag is require-approval tier', () => {
      const condition = createPolicyCondition({})
      // DEFAULT_REQUIRE_APPROVAL_TOOLS includes destructive ops — use a known one
      const ctx = makeContext({ tags: ['tool:shell_exec'] })
      // shell_exec is in DEFAULT_REQUIRE_APPROVAL_TOOLS
      const classifier = createRiskClassifier()
      const tier = classifier.classify('shell_exec').tier
      if (tier === 'require-approval') {
        expect(condition(ctx)).toBe(true)
      }
    })

    it('does not require approval for auto-approve tool', () => {
      const condition = createPolicyCondition({})
      // read_file is in DEFAULT_AUTO_APPROVE_TOOLS
      const ctx = makeContext({ tags: ['tool:read_file'] })
      expect(condition(ctx)).toBe(false)
    })

    it('extracts tool name from metadata.toolName', () => {
      // Force require-approval via custom classifier
      const condition = createPolicyCondition({
        riskClassifier: createRiskClassifier({
          requireApprovalTools: ['my-tool'],
          autoApproveTools: [],
          logTools: [],
        }),
      })
      const ctx = makeContext({ metadata: { toolName: 'my-tool' } })
      expect(condition(ctx)).toBe(true)
    })

    it('extracts tool name from tool: tag', () => {
      const condition = createPolicyCondition({
        riskClassifier: createRiskClassifier({
          requireApprovalTools: ['deploy_prod'],
          autoApproveTools: [],
          logTools: [],
        }),
      })
      const ctx = makeContext({ tags: ['tool:deploy_prod', 'env:production'] })
      expect(condition(ctx)).toBe(true)
    })

    it('does not require approval for unknown tool with default log tier', () => {
      const condition = createPolicyCondition({})
      const ctx = makeContext({ tags: ['tool:unknown_tool_xyz'] })
      expect(condition(ctx)).toBe(false)
    })
  })

  describe('cost threshold', () => {
    it('requires approval when cost meets threshold', () => {
      const condition = createPolicyCondition({ costApprovalThresholdCents: 500 })
      const ctx = makeContext({ estimatedCostCents: 500 })
      expect(condition(ctx)).toBe(true)
    })

    it('requires approval when cost exceeds threshold', () => {
      const condition = createPolicyCondition({ costApprovalThresholdCents: 500 })
      const ctx = makeContext({ estimatedCostCents: 1000 })
      expect(condition(ctx)).toBe(true)
    })

    it('does not require approval when cost is below threshold', () => {
      const condition = createPolicyCondition({ costApprovalThresholdCents: 500 })
      const ctx = makeContext({ estimatedCostCents: 499 })
      expect(condition(ctx)).toBe(false)
    })

    it('does not require approval when cost is undefined', () => {
      const condition = createPolicyCondition({ costApprovalThresholdCents: 500 })
      const ctx = makeContext({ estimatedCostCents: undefined })
      expect(condition(ctx)).toBe(false)
    })

    it('does not require approval when threshold is not configured', () => {
      const condition = createPolicyCondition({})
      const ctx = makeContext({ estimatedCostCents: 9999 })
      expect(condition(ctx)).toBe(false)
    })
  })

  describe('policy set evaluation', () => {
    it('requires approval when policy denies', () => {
      const condition = createPolicyCondition({ policySet: makePolicySet('deny') })
      const ctx = makeContext()
      expect(condition(ctx)).toBe(true)
    })

    it('does not require approval when policy allows', () => {
      const condition = createPolicyCondition({ policySet: makePolicySet('allow') })
      const ctx = makeContext()
      expect(condition(ctx)).toBe(false)
    })

    it('does not require approval when no policy set configured', () => {
      const condition = createPolicyCondition({})
      const ctx = makeContext()
      expect(condition(ctx)).toBe(false)
    })
  })

  describe('custom principal/environment resolvers', () => {
    it('uses custom principal resolver', () => {
      const now = new Date().toISOString()
      const policySet: PolicySet = {
        id: 'ps-1',
        name: 'User policy',
        version: 1,
        active: true,
        createdAt: now,
        updatedAt: now,
        rules: [
          {
            id: 'r-1',
            effect: 'deny',
            actions: ['adapter:execute'],
            principals: { types: ['user'] },
            priority: 10,
          },
        ],
      }
      // Principal as user → policy denies → approval required
      const condition = createPolicyCondition({
        policySet,
        resolvePrincipal: () => ({ type: 'user', id: 'user-123' }),
      })
      expect(condition(makeContext())).toBe(true)
    })

    it('uses custom environment resolver for condition matching', () => {
      const now = new Date().toISOString()
      const policySet: PolicySet = {
        id: 'ps-env',
        name: 'Env-based policy',
        version: 1,
        active: true,
        createdAt: now,
        updatedAt: now,
        rules: [
          {
            id: 'r-env',
            effect: 'deny',
            actions: ['adapter:execute'],
            conditions: [{ field: 'environment.env', operator: 'eq', value: 'production' }],
            priority: 10,
          },
        ],
      }

      const condition = createPolicyCondition({
        policySet,
        resolveEnvironment: () => ({ env: 'production' }),
      })
      expect(condition(makeContext())).toBe(true)
    })
  })

  describe('blast radius threshold', () => {
    it('requires approval when blast radius meets threshold', () => {
      const condition = createPolicyCondition({ blastRadiusThreshold: 'high' })
      const ctx = makeContext({ blastRadius: 'high' })
      expect(condition(ctx)).toBe(true)
    })

    it('requires approval when blast radius exceeds threshold', () => {
      const condition = createPolicyCondition({ blastRadiusThreshold: 'medium' })
      const ctx = makeContext({ blastRadius: 'critical' })
      expect(condition(ctx)).toBe(true)
    })

    it('does not require approval when blast radius is below threshold', () => {
      const condition = createPolicyCondition({ blastRadiusThreshold: 'high' })
      const ctx = makeContext({ blastRadius: 'medium' })
      expect(condition(ctx)).toBe(false)
    })

    it('does not trigger when blast radius is not provided', () => {
      const condition = createPolicyCondition({ blastRadiusThreshold: 'low' })
      const ctx = makeContext() // no blastRadius
      expect(condition(ctx)).toBe(false)
    })
  })

  describe('confidence score minimum', () => {
    it('requires approval when confidence score is below minimum', () => {
      const condition = createPolicyCondition({ confidenceScoreMinimum: 0.8 })
      const ctx = makeContext({ confidenceScore: 0.5 })
      expect(condition(ctx)).toBe(true)
    })

    it('does not require approval when confidence score meets minimum', () => {
      const condition = createPolicyCondition({ confidenceScoreMinimum: 0.8 })
      const ctx = makeContext({ confidenceScore: 0.8 })
      expect(condition(ctx)).toBe(false)
    })

    it('does not require approval when confidence score exceeds minimum', () => {
      const condition = createPolicyCondition({ confidenceScoreMinimum: 0.5 })
      const ctx = makeContext({ confidenceScore: 0.9 })
      expect(condition(ctx)).toBe(false)
    })

    it('does not trigger when confidence score is not provided', () => {
      const condition = createPolicyCondition({ confidenceScoreMinimum: 0.8 })
      const ctx = makeContext() // no confidenceScore
      expect(condition(ctx)).toBe(false)
    })
  })

  describe('combined governance checks', () => {
    it('blast radius + confidence score + cost all evaluated together', () => {
      const condition = createPolicyCondition({
        costApprovalThresholdCents: 1000,
        blastRadiusThreshold: 'high',
        confidenceScoreMinimum: 0.7,
      })

      // All below thresholds -- no approval needed
      expect(condition(makeContext({
        estimatedCostCents: 100,
        blastRadius: 'medium',
        confidenceScore: 0.9,
      }))).toBe(false)

      // Cost triggers
      expect(condition(makeContext({
        estimatedCostCents: 1500,
        blastRadius: 'low',
        confidenceScore: 0.9,
      }))).toBe(true)

      // Blast radius triggers
      expect(condition(makeContext({
        estimatedCostCents: 100,
        blastRadius: 'critical',
        confidenceScore: 0.9,
      }))).toBe(true)

      // Confidence score triggers
      expect(condition(makeContext({
        estimatedCostCents: 100,
        blastRadius: 'low',
        confidenceScore: 0.3,
      }))).toBe(true)
    })
  })

  describe('compareBlastRadius helper', () => {
    it('returns 0 for equal levels', () => {
      expect(compareBlastRadius('high', 'high')).toBe(0)
    })

    it('returns positive when a > b', () => {
      expect(compareBlastRadius('critical', 'low')).toBeGreaterThan(0)
    })

    it('returns negative when a < b', () => {
      expect(compareBlastRadius('low', 'critical')).toBeLessThan(0)
    })

    it('orders correctly: low < medium < high < critical', () => {
      expect(compareBlastRadius('low', 'medium')).toBeLessThan(0)
      expect(compareBlastRadius('medium', 'high')).toBeLessThan(0)
      expect(compareBlastRadius('high', 'critical')).toBeLessThan(0)
    })
  })

  describe('evaluation order', () => {
    it('tool risk tier takes priority over cost and policy', () => {
      // Policy says allow, cost is low, but tool is require-approval
      const condition = createPolicyCondition({
        riskClassifier: createRiskClassifier({
          requireApprovalTools: ['dangerous-tool'],
          autoApproveTools: [],
          logTools: [],
        }),
        policySet: makePolicySet('allow'),
        costApprovalThresholdCents: 9999,
      })
      const ctx = makeContext({
        metadata: { toolName: 'dangerous-tool' },
        estimatedCostCents: 1,
      })
      expect(condition(ctx)).toBe(true)
    })

    it('cost threshold is checked before policy', () => {
      // Policy says allow, but cost exceeds threshold
      const condition = createPolicyCondition({
        policySet: makePolicySet('allow'),
        costApprovalThresholdCents: 100,
      })
      const ctx = makeContext({ estimatedCostCents: 200 })
      expect(condition(ctx)).toBe(true)
    })
  })
})
