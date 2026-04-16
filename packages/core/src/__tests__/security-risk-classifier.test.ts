import { describe, it, expect } from 'vitest'
import { createRiskClassifier } from '../security/risk-classifier.js'
import type { RiskTier, RiskClassification } from '../security/risk-classifier.js'
import {
  DEFAULT_AUTO_APPROVE_TOOLS,
  DEFAULT_LOG_TOOLS,
  DEFAULT_REQUIRE_APPROVAL_TOOLS,
} from '../security/tool-permission-tiers.js'

describe('RiskClassifier — extended coverage', () => {
  // -----------------------------------------------------------------------
  // Default tier completeness
  // -----------------------------------------------------------------------

  describe('all default auto-approve tools', () => {
    const classifier = createRiskClassifier()

    for (const tool of DEFAULT_AUTO_APPROVE_TOOLS) {
      it(`classifies "${tool}" as auto`, () => {
        const r = classifier.classify(tool)
        expect(r.tier).toBe('auto')
        expect(r.toolName).toBe(tool)
        expect(r.reason).toContain('auto-approve')
      })
    }
  })

  describe('all default log tools', () => {
    const classifier = createRiskClassifier()

    for (const tool of DEFAULT_LOG_TOOLS) {
      it(`classifies "${tool}" as log`, () => {
        const r = classifier.classify(tool)
        expect(r.tier).toBe('log')
        expect(r.toolName).toBe(tool)
        expect(r.reason).toContain('log list')
      })
    }
  })

  describe('all default require-approval tools', () => {
    const classifier = createRiskClassifier()

    for (const tool of DEFAULT_REQUIRE_APPROVAL_TOOLS) {
      it(`classifies "${tool}" as require-approval`, () => {
        const r = classifier.classify(tool)
        expect(r.tier).toBe('require-approval')
        expect(r.toolName).toBe(tool)
        expect(r.reason).toContain('require-approval')
      })
    }
  })

  // -----------------------------------------------------------------------
  // Priority: require-approval > log > auto
  // -----------------------------------------------------------------------

  describe('static tier priority ordering', () => {
    it('require-approval takes priority over log and auto if tool appears in multiple lists', () => {
      const classifier = createRiskClassifier({
        autoApproveTools: ['overlap_tool'],
        logTools: ['overlap_tool'],
        requireApprovalTools: ['overlap_tool'],
      })
      // require-approval is checked first in the code
      expect(classifier.classify('overlap_tool').tier).toBe('require-approval')
    })

    it('log takes priority over auto when tool appears in both', () => {
      const classifier = createRiskClassifier({
        autoApproveTools: ['dual_tool'],
        logTools: ['dual_tool'],
        requireApprovalTools: [],
      })
      expect(classifier.classify('dual_tool').tier).toBe('log')
    })
  })

  // -----------------------------------------------------------------------
  // Custom configuration — log and approval lists
  // -----------------------------------------------------------------------

  describe('custom log tools', () => {
    it('uses custom log list replacing defaults', () => {
      const classifier = createRiskClassifier({
        logTools: ['my_log_tool'],
      })
      expect(classifier.classify('my_log_tool').tier).toBe('log')
      expect(classifier.classify('my_log_tool').reason).toContain('log list')
      // write_file is no longer in the explicit log set, so its reason
      // should say "unclassified" (falls through to default tier which is still 'log')
      expect(classifier.classify('write_file').reason).toContain('unclassified')
    })
  })

  describe('custom require-approval tools', () => {
    it('uses custom approval list replacing defaults', () => {
      const classifier = createRiskClassifier({
        requireApprovalTools: ['nuclear_launch'],
      })
      expect(classifier.classify('nuclear_launch').tier).toBe('require-approval')
      // Default approval tool no longer in the explicit approval set
      expect(classifier.classify('delete_file').reason).toContain('unclassified')
    })
  })

  // -----------------------------------------------------------------------
  // Custom classifier edge cases
  // -----------------------------------------------------------------------

  describe('custom classifier edge cases', () => {
    it('custom classifier reason message includes tool name and tier', () => {
      const classifier = createRiskClassifier({
        customClassifier: (_name, _args) => 'require-approval',
      })
      const result = classifier.classify('dynamic_tool')
      expect(result.tier).toBe('require-approval')
      expect(result.reason).toContain('Custom classifier')
      expect(result.reason).toContain('dynamic_tool')
      expect(result.reason).toContain('require-approval')
    })

    it('custom classifier returning undefined falls through to default', () => {
      const classifier = createRiskClassifier({
        defaultTier: 'auto',
        customClassifier: () => undefined,
      })
      const result = classifier.classify('anything')
      expect(result.tier).toBe('auto')
      expect(result.reason).toContain('unclassified')
    })

    it('custom classifier receives args object', () => {
      let capturedArgs: Record<string, unknown> = {}
      const classifier = createRiskClassifier({
        customClassifier: (_name, args) => {
          capturedArgs = args
          return undefined
        },
      })
      classifier.classify('tool', { path: '/etc/passwd', force: true })
      expect(capturedArgs).toEqual({ path: '/etc/passwd', force: true })
    })

    it('classify without args defaults to empty object for custom classifier', () => {
      let capturedArgs: Record<string, unknown> | undefined
      const classifier = createRiskClassifier({
        customClassifier: (_name, args) => {
          capturedArgs = args
          return undefined
        },
      })
      classifier.classify('tool')
      expect(capturedArgs).toEqual({})
    })
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('empty tool name classifies to default tier', () => {
      const classifier = createRiskClassifier()
      const result = classifier.classify('')
      expect(result.tier).toBe('log')
      expect(result.toolName).toBe('')
    })

    it('tool name with special characters', () => {
      const classifier = createRiskClassifier({
        autoApproveTools: ['ns::read_file'],
      })
      expect(classifier.classify('ns::read_file').tier).toBe('auto')
    })

    it('empty configuration uses defaults', () => {
      const classifier = createRiskClassifier({})
      // Should still have default tools
      expect(classifier.classify('read_file').tier).toBe('auto')
      expect(classifier.classify('write_file').tier).toBe('log')
      expect(classifier.classify('delete_file').tier).toBe('require-approval')
    })

    it('no-arg createRiskClassifier works', () => {
      const classifier = createRiskClassifier()
      expect(classifier.classify('read_file').tier).toBe('auto')
    })

    it('all three default tiers produce distinct reasons', () => {
      const classifier = createRiskClassifier()
      const auto = classifier.classify('read_file')
      const log = classifier.classify('unknown_xyz')
      const approval = classifier.classify('delete_file')

      // Reasons should be different
      const reasons = new Set([auto.reason, log.reason, approval.reason])
      expect(reasons.size).toBe(3)
    })
  })
})
