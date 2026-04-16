import { describe, it, expect } from 'vitest'
import { createRiskClassifier } from '../security/risk-classifier.js'
import type { RiskTier } from '../security/risk-classifier.js'

describe('RiskClassifier', () => {
  describe('default configuration', () => {
    const classifier = createRiskClassifier()

    it('classifies read_file as auto', () => {
      const result = classifier.classify('read_file')
      expect(result.tier).toBe('auto')
      expect(result.toolName).toBe('read_file')
    })

    it('classifies list_files as auto', () => {
      expect(classifier.classify('list_files').tier).toBe('auto')
    })

    it('classifies git_status as auto', () => {
      expect(classifier.classify('git_status').tier).toBe('auto')
    })

    it('classifies git_diff as auto', () => {
      expect(classifier.classify('git_diff').tier).toBe('auto')
    })

    it('classifies write_file as log', () => {
      const result = classifier.classify('write_file')
      expect(result.tier).toBe('log')
    })

    it('classifies edit_file as log', () => {
      expect(classifier.classify('edit_file').tier).toBe('log')
    })

    it('classifies git_commit as log', () => {
      expect(classifier.classify('git_commit').tier).toBe('log')
    })

    it('classifies delete_file as require-approval', () => {
      const result = classifier.classify('delete_file')
      expect(result.tier).toBe('require-approval')
    })

    it('classifies git_push as require-approval', () => {
      expect(classifier.classify('git_push').tier).toBe('require-approval')
    })

    it('classifies execute_command as require-approval', () => {
      expect(classifier.classify('execute_command').tier).toBe('require-approval')
    })

    it('classifies db_query as require-approval', () => {
      expect(classifier.classify('db_query').tier).toBe('require-approval')
    })

    it('classifies unknown tools as log (default tier)', () => {
      const result = classifier.classify('some_unknown_tool')
      expect(result.tier).toBe('log')
      expect(result.reason).toContain('unclassified')
    })
  })

  describe('custom configuration', () => {
    it('uses custom auto-approve list', () => {
      const classifier = createRiskClassifier({
        autoApproveTools: ['my_safe_tool'],
      })
      expect(classifier.classify('my_safe_tool').tier).toBe('auto')
      // Default auto-approve tools should not be included
      expect(classifier.classify('read_file').tier).toBe('log')
    })

    it('uses custom default tier', () => {
      const classifier = createRiskClassifier({
        defaultTier: 'require-approval',
      })
      expect(classifier.classify('unknown_tool').tier).toBe('require-approval')
    })

    it('uses custom classifier function', () => {
      const classifier = createRiskClassifier({
        customClassifier: (toolName, args) => {
          if (toolName === 'conditional_tool' && args['dangerous'] === true) {
            return 'require-approval'
          }
          if (toolName === 'conditional_tool') {
            return 'auto'
          }
          return undefined
        },
      })

      expect(classifier.classify('conditional_tool', { dangerous: true }).tier).toBe('require-approval')
      expect(classifier.classify('conditional_tool', { dangerous: false }).tier).toBe('auto')
      // Unknown tool falls through custom classifier (returns undefined)
      expect(classifier.classify('other_tool').tier).toBe('log')
    })

    it('static classification takes priority over custom classifier', () => {
      const classifier = createRiskClassifier({
        requireApprovalTools: ['always_blocked'],
        customClassifier: () => 'auto',
      })
      // Static lookup runs first
      expect(classifier.classify('always_blocked').tier).toBe('require-approval')
    })
  })

  describe('classification result', () => {
    it('includes reason string', () => {
      const classifier = createRiskClassifier()
      const result = classifier.classify('read_file')
      expect(result.reason).toBeTruthy()
      expect(typeof result.reason).toBe('string')
    })

    it('includes toolName in result', () => {
      const classifier = createRiskClassifier()
      const result = classifier.classify('git_push')
      expect(result.toolName).toBe('git_push')
    })
  })
})
