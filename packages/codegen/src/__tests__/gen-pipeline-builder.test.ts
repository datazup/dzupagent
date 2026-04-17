import { describe, it, expect } from 'vitest'
import { GenPipelineBuilder } from '../pipeline/gen-pipeline-builder.js'

describe('GenPipelineBuilder', () => {
  it('starts with no phases', () => {
    const builder = new GenPipelineBuilder()
    expect(builder.getPhases()).toHaveLength(0)
    expect(builder.getPhaseNames()).toHaveLength(0)
  })

  it('adds a generation phase', () => {
    const builder = new GenPipelineBuilder()
    builder.addPhase({ name: 'gen-backend', promptType: 'backend' })
    const phases = builder.getPhases()
    expect(phases).toHaveLength(1)
    expect(phases[0]!.name).toBe('gen-backend')
    expect(phases[0]!.type).toBe('generation')
  })

  it('adds a sub-agent phase', () => {
    const builder = new GenPipelineBuilder()
    builder.addSubAgentPhase({
      name: 'sub-gen',
      promptType: 'frontend',
      subagentConfig: { model: 'fast' },
    })
    const phases = builder.getPhases()
    expect(phases[0]!.type).toBe('subagent')
    expect(phases[0]!.subagentConfig).toEqual({ model: 'fast' })
  })

  it('adds a validation phase with defaults', () => {
    const builder = new GenPipelineBuilder()
    builder.addValidationPhase({ dimensions: [], threshold: 0.8 })
    const phases = builder.getPhases()
    expect(phases[0]!.name).toBe('validate')
    expect(phases[0]!.type).toBe('validation')
    expect(phases[0]!.threshold).toBe(0.8)
  })

  it('adds a validation phase with custom name', () => {
    const builder = new GenPipelineBuilder()
    builder.addValidationPhase({ name: 'quality-check', dimensions: [], threshold: 0.7 })
    expect(builder.getPhase('quality-check')).toBeDefined()
  })

  it('adds a fix phase with defaults', () => {
    const builder = new GenPipelineBuilder()
    builder.addFixPhase()
    const fix = builder.getPhase('fix')!
    expect(fix.type).toBe('fix')
    expect(fix.maxAttempts).toBe(3)
    expect(fix.escalation).toBeDefined()
  })

  it('adds a fix phase with custom config', () => {
    const builder = new GenPipelineBuilder()
    builder.addFixPhase({ name: 'retry', maxAttempts: 5 })
    expect(builder.getPhase('retry')!.maxAttempts).toBe(5)
  })

  it('adds a review phase with defaults', () => {
    const builder = new GenPipelineBuilder()
    builder.addReviewPhase()
    const review = builder.getPhase('review')!
    expect(review.type).toBe('review')
    expect(review.autoApprove).toBe(false)
  })

  it('adds a review phase with auto-approve', () => {
    const builder = new GenPipelineBuilder()
    builder.addReviewPhase({ autoApprove: true })
    expect(builder.getPhase('review')!.autoApprove).toBe(true)
  })

  it('getPhaseNames returns names in order', () => {
    const builder = new GenPipelineBuilder()
    builder.addPhase({ name: 'a', promptType: 'x' })
    builder.addPhase({ name: 'b', promptType: 'y' })
    builder.addFixPhase({ name: 'c' })
    expect(builder.getPhaseNames()).toEqual(['a', 'b', 'c'])
  })

  it('getPhase returns undefined for unknown name', () => {
    const builder = new GenPipelineBuilder()
    expect(builder.getPhase('nope')).toBeUndefined()
  })

  it('getGenerationPhases returns only generation and subagent phases', () => {
    const builder = new GenPipelineBuilder()
    builder.addPhase({ name: 'gen', promptType: 'x' })
    builder.addSubAgentPhase({ name: 'sub', promptType: 'y' })
    builder.addValidationPhase({ dimensions: [], threshold: 0.8 })
    builder.addFixPhase()
    const genPhases = builder.getGenerationPhases()
    expect(genPhases).toHaveLength(2)
    expect(genPhases.map(p => p.name)).toEqual(['gen', 'sub'])
  })

  it('withGuardrails adds a guardrail phase and stores config', () => {
    const builder = new GenPipelineBuilder()
    const config = { enabled: true, conventions: [], minScore: 70 }
    builder.withGuardrails(config as never)
    expect(builder.getGuardrailConfig()).toBeDefined()
    const phase = builder.getPhases().find(p => p.type === 'guardrail')
    expect(phase).toBeDefined()
    expect(phase!.name).toBe('guardrail-gate')
  })

  it('getGuardrailConfig returns undefined when not set', () => {
    const builder = new GenPipelineBuilder()
    expect(builder.getGuardrailConfig()).toBeUndefined()
  })

  it('supports fluent chaining across methods', () => {
    const builder = new GenPipelineBuilder()
    const result = builder
      .addPhase({ name: 'gen', promptType: 'x' })
      .addValidationPhase({ dimensions: [], threshold: 0.8 })
      .addFixPhase()
      .addReviewPhase()

    expect(result).toBe(builder)
    expect(builder.getPhases()).toHaveLength(4)
  })
})
