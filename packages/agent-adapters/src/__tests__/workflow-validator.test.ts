import { describe, it, expect } from 'vitest'
import { TemplateResolver } from '../workflow/template-resolver.js'
import { WorkflowValidator } from '../workflow/workflow-validator.js'
import type { AdapterWorkflowNode } from '../workflow/workflow-validator.js'

describe('WorkflowValidator', () => {
  const resolver = new TemplateResolver()
  const validator = new WorkflowValidator(resolver)

  // -------------------------------------------------------------------------
  // validateUniqueIds
  // -------------------------------------------------------------------------

  describe('validateUniqueIds()', () => {
    it('passes when all step IDs are unique', () => {
      const nodes: AdapterWorkflowNode[] = [
        { type: 'step', config: { id: 'a', prompt: 'A' } },
        { type: 'step', config: { id: 'b', prompt: 'B' } },
      ]
      const errors = validator.validateUniqueIds(nodes)
      expect(errors).toEqual([])
    })

    it('catches duplicate step IDs', () => {
      const nodes: AdapterWorkflowNode[] = [
        { type: 'step', config: { id: 'dup', prompt: 'First' } },
        { type: 'step', config: { id: 'dup', prompt: 'Second' } },
      ]
      const errors = validator.validateUniqueIds(nodes)
      expect(errors).toHaveLength(1)
      expect(errors[0]!.stepId).toBe('dup')
      expect(errors[0]!.severity).toBe('error')
      expect(errors[0]!.message).toContain('Duplicate')
    })

    it('detects duplicates across step and parallel nodes', () => {
      const nodes: AdapterWorkflowNode[] = [
        { type: 'step', config: { id: 'shared', prompt: 'Step' } },
        {
          type: 'parallel',
          steps: [
            { id: 'shared', prompt: 'Parallel' },
            { id: 'unique', prompt: 'Parallel 2' },
          ],
          mergeStrategy: 'merge',
        },
      ]
      const errors = validator.validateUniqueIds(nodes)
      expect(errors).toHaveLength(1)
      expect(errors[0]!.stepId).toBe('shared')
    })

    it('detects duplicates in branch nodes', () => {
      const nodes: AdapterWorkflowNode[] = [
        { type: 'step', config: { id: 'x', prompt: 'X' } },
        {
          type: 'branch',
          condition: () => 'a',
          branches: {
            a: [{ id: 'x', prompt: 'In branch A' }],
            b: [{ id: 'y', prompt: 'In branch B' }],
          },
        },
      ]
      const errors = validator.validateUniqueIds(nodes)
      expect(errors).toHaveLength(1)
      expect(errors[0]!.stepId).toBe('x')
    })
  })

  // -------------------------------------------------------------------------
  // validateTemplates
  // -------------------------------------------------------------------------

  describe('validateTemplates()', () => {
    it('produces no warnings for valid templates', () => {
      const nodes: AdapterWorkflowNode[] = [
        { type: 'step', config: { id: 'research', prompt: 'Do research' } },
        { type: 'step', config: { id: 'summarize', prompt: 'Summarize: {{state.research}}' } },
      ]
      const warnings = validator.validateTemplates(nodes)
      expect(warnings).toEqual([])
    })

    it('warns on unresolvable template references', () => {
      const nodes: AdapterWorkflowNode[] = [
        { type: 'step', config: { id: 'first', prompt: 'Result: {{state.nonexistent}}' } },
      ]
      const warnings = validator.validateTemplates(nodes)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]!.stepId).toBe('first')
      expect(warnings[0]!.severity).toBe('warning')
    })

    it('allows {{prev}} without prior steps', () => {
      const nodes: AdapterWorkflowNode[] = [
        { type: 'step', config: { id: 'first', prompt: '{{prev}}' } },
      ]
      const warnings = validator.validateTemplates(nodes)
      expect(warnings).toEqual([])
    })

    it('handles parallel steps correctly (IDs available after parallel)', () => {
      const nodes: AdapterWorkflowNode[] = [
        {
          type: 'parallel',
          steps: [
            { id: 'p1', prompt: 'Parallel 1' },
            { id: 'p2', prompt: 'Parallel 2' },
          ],
          mergeStrategy: 'merge',
        },
        { type: 'step', config: { id: 'merge', prompt: '{{state.p1}} and {{state.p2}}' } },
      ]
      const warnings = validator.validateTemplates(nodes)
      expect(warnings).toEqual([])
    })

    it('warns when referencing a step that comes later', () => {
      const nodes: AdapterWorkflowNode[] = [
        { type: 'step', config: { id: 'early', prompt: 'Ref: {{state.late}}' } },
        { type: 'step', config: { id: 'late', prompt: 'Late step' } },
      ]
      const warnings = validator.validateTemplates(nodes)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]!.stepId).toBe('early')
    })

    it('handles branch templates with available state', () => {
      const nodes: AdapterWorkflowNode[] = [
        { type: 'step', config: { id: 'setup', prompt: 'Setup' } },
        {
          type: 'branch',
          condition: () => 'a',
          branches: {
            a: [{ id: 'branch_a', prompt: 'Use: {{state.setup}}' }],
            b: [{ id: 'branch_b', prompt: 'Use: {{state.setup}}' }],
          },
        },
      ]
      const warnings = validator.validateTemplates(nodes)
      expect(warnings).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // validate (full)
  // -------------------------------------------------------------------------

  describe('validate()', () => {
    it('passes a valid workflow', () => {
      const nodes: AdapterWorkflowNode[] = [
        { type: 'step', config: { id: 'a', prompt: 'Hello' } },
        { type: 'step', config: { id: 'b', prompt: '{{prev}}' } },
      ]
      const result = validator.validate(nodes)
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('reports errors for duplicates and is invalid', () => {
      const nodes: AdapterWorkflowNode[] = [
        { type: 'step', config: { id: 'dup', prompt: 'A' } },
        { type: 'step', config: { id: 'dup', prompt: 'B' } },
      ]
      const result = validator.validate(nodes)
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
    })

    it('separates errors and warnings', () => {
      const nodes: AdapterWorkflowNode[] = [
        { type: 'step', config: { id: 'dup', prompt: '{{state.unknown}}' } },
        { type: 'step', config: { id: 'dup', prompt: '{{state.unknown2}}' } },
      ]
      const result = validator.validate(nodes)
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.warnings.length).toBeGreaterThan(0)
      expect(result.errors.every((e) => e.severity === 'error')).toBe(true)
      expect(result.warnings.every((w) => w.severity === 'warning')).toBe(true)
    })
  })
})
