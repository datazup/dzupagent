import { describe, it, expect } from 'vitest'
import {
  SkillNotFoundError,
  ChainValidationError,
  StepExecutionError,
  ConditionEvaluationError,
  WorkflowParseError,
} from '../skill-chain-executor/errors.js'

describe('SkillNotFoundError', () => {
  it('has correct message and properties', () => {
    const err = new SkillNotFoundError('my-skill', ['skill-a', 'skill-b'])
    expect(err.message).toContain('my-skill')
    expect(err.message).toContain('not found')
    expect(err.message).toContain('skill-a')
    expect(err.message).toContain('skill-b')
    expect(err.skillId).toBe('my-skill')
    expect(err.availableSkills).toEqual(['skill-a', 'skill-b'])
    expect(err.code).toBe('TOOL_NOT_FOUND')
  })

  it('is an instance of Error', () => {
    const err = new SkillNotFoundError('x', [])
    expect(err).toBeInstanceOf(Error)
  })

  it('handles empty available skills', () => {
    const err = new SkillNotFoundError('x', [])
    expect(err.message).toContain('x')
    expect(err.availableSkills).toEqual([])
  })
})

describe('ChainValidationError', () => {
  it('has correct message and properties', () => {
    const validationResult = {
      valid: false,
      missingSkills: ['skill-x', 'skill-y'],
      errors: [],
      warnings: [],
      resolvedSteps: [],
    }
    const err = new ChainValidationError('my-chain', validationResult)
    expect(err.message).toContain('my-chain')
    expect(err.message).toContain('validation failed')
    expect(err.message).toContain('skill-x')
    expect(err.chainName).toBe('my-chain')
    expect(err.validationResult).toBe(validationResult)
    expect(err.code).toBe('VALIDATION_FAILED')
  })
})

describe('StepExecutionError', () => {
  it('includes step index and skill ID', () => {
    const cause = new Error('inner error')
    const err = new StepExecutionError(2, 'analyze', cause, { partial: true })
    expect(err.message).toContain('Step 2')
    expect(err.message).toContain('analyze')
    expect(err.message).toContain('inner error')
    expect(err.stepIndex).toBe(2)
    expect(err.skillId).toBe('analyze')
    expect(err.partialState).toEqual({ partial: true })
    expect(err.code).toBe('PIPELINE_PHASE_FAILED')
  })

  it('handles non-Error cause', () => {
    const err = new StepExecutionError(0, 'build', 'string error', {})
    expect(err.message).toContain('string error')
  })

  it('handles non-Error cause (object)', () => {
    const err = new StepExecutionError(0, 'build', { code: 42 }, {})
    expect(err.message).toContain('[object Object]')
  })
})

describe('ConditionEvaluationError', () => {
  it('includes step index and skill ID', () => {
    const cause = new Error('condition failed')
    const err = new ConditionEvaluationError(1, 'filter', cause)
    expect(err.message).toContain('step 1')
    expect(err.message).toContain('filter')
    expect(err.message).toContain('condition failed')
    expect(err.stepIndex).toBe(1)
    expect(err.skillId).toBe('filter')
    expect(err.code).toBe('VALIDATION_FAILED')
  })

  it('handles non-Error cause', () => {
    const err = new ConditionEvaluationError(3, 'check', 'bad condition')
    expect(err.message).toContain('bad condition')
  })
})

describe('WorkflowParseError', () => {
  it('has correct properties', () => {
    const candidates = [
      { text: 'analyze > build', confidence: 0.8, skills: ['analyze', 'build'] },
    ]
    const err = new WorkflowParseError('bad input', 'ambiguous command', candidates)
    expect(err.message).toContain('ambiguous command')
    expect(err.inputText).toBe('bad input')
    expect(err.parseReason).toBe('ambiguous command')
    expect(err.candidateInterpretations).toEqual(candidates)
    expect(err.code).toBe('INVALID_CONFIG')
  })

  it('handles empty candidates', () => {
    const err = new WorkflowParseError('?', 'unrecognized', [])
    expect(err.candidateInterpretations).toEqual([])
  })
})
