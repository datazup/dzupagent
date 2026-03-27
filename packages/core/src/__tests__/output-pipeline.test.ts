import { describe, it, expect } from 'vitest'
import { OutputPipeline, createDefaultPipeline } from '../security/output-pipeline.js'
import type { SanitizationStage } from '../security/output-pipeline.js'

describe('OutputPipeline', () => {
  it('runs all enabled stages in order', async () => {
    const order: string[] = []
    const stages: SanitizationStage[] = [
      {
        name: 'stage-a',
        process: (c) => { order.push('a'); return c.replace('hello', 'HELLO') },
      },
      {
        name: 'stage-b',
        process: (c) => { order.push('b'); return c.replace('HELLO', 'HI') },
      },
    ]
    const pipeline = new OutputPipeline({ stages })
    const result = await pipeline.process('hello world')

    expect(result.content).toBe('HI world')
    expect(order).toEqual(['a', 'b'])
    expect(result.appliedStages).toEqual(['stage-a', 'stage-b'])
    expect(result.truncated).toBe(false)
    expect(result.originalLength).toBe('hello world'.length)
  })

  it('skips disabled stages', async () => {
    const stages: SanitizationStage[] = [
      { name: 'active', process: (c) => c + '!' },
      { name: 'disabled', enabled: false, process: (c) => c + '?' },
    ]
    const pipeline = new OutputPipeline({ stages })
    const result = await pipeline.process('test')

    expect(result.content).toBe('test!')
    expect(result.appliedStages).toEqual(['active'])
  })

  it('only reports stages that modified content', async () => {
    const stages: SanitizationStage[] = [
      { name: 'noop', process: (c) => c },
      { name: 'modifier', process: (c) => c + '-modified' },
    ]
    const pipeline = new OutputPipeline({ stages })
    const result = await pipeline.process('data')

    expect(result.appliedStages).toEqual(['modifier'])
  })

  it('truncates content exceeding maxOutputLength', async () => {
    const pipeline = new OutputPipeline({ stages: [], maxOutputLength: 10 })
    const result = await pipeline.process('a'.repeat(20))

    expect(result.truncated).toBe(true)
    expect(result.content).toBe('a'.repeat(10) + '\n[TRUNCATED]')
  })

  it('does not truncate content within limit', async () => {
    const pipeline = new OutputPipeline({ stages: [], maxOutputLength: 100 })
    const result = await pipeline.process('short')

    expect(result.truncated).toBe(false)
    expect(result.content).toBe('short')
  })

  it('supports async stages', async () => {
    const stages: SanitizationStage[] = [
      {
        name: 'async-stage',
        process: async (c) => {
          await new Promise((r) => setTimeout(r, 1))
          return c.toUpperCase()
        },
      },
    ]
    const pipeline = new OutputPipeline({ stages })
    const result = await pipeline.process('hello')
    expect(result.content).toBe('HELLO')
  })

  it('addStage appends a new stage', async () => {
    const pipeline = new OutputPipeline({ stages: [] })
    pipeline.addStage({ name: 'added', process: (c) => c + '-added' })
    const result = await pipeline.process('base')
    expect(result.content).toBe('base-added')
  })

  it('setStageEnabled toggles a stage', async () => {
    const stages: SanitizationStage[] = [
      { name: 'togglable', process: (c) => c + '!' },
    ]
    const pipeline = new OutputPipeline({ stages })

    pipeline.setStageEnabled('togglable', false)
    const result1 = await pipeline.process('test')
    expect(result1.content).toBe('test')

    pipeline.setStageEnabled('togglable', true)
    const result2 = await pipeline.process('test')
    expect(result2.content).toBe('test!')
  })

  it('setStageEnabled ignores unknown stage names', () => {
    const pipeline = new OutputPipeline({ stages: [] })
    // Should not throw
    pipeline.setStageEnabled('nonexistent', true)
  })
})

describe('createDefaultPipeline', () => {
  it('creates a pipeline with PII and secrets stages enabled by default', async () => {
    const pipeline = createDefaultPipeline()
    const result = await pipeline.process('Email: test@example.com, key = AKIAIOSFODNN7EXAMPLE')

    expect(result.content).toContain('[REDACTED:email]')
    expect(result.content).toContain('[REDACTED:')
    expect(result.content).not.toContain('test@example.com')
  })

  it('disables PII stage when enablePII is false', async () => {
    const pipeline = createDefaultPipeline({ enablePII: false })
    const result = await pipeline.process('Email: test@example.com')

    expect(result.content).toContain('test@example.com')
  })

  it('disables secrets stage when enableSecrets is false', async () => {
    const pipeline = createDefaultPipeline({ enableSecrets: false })
    const result = await pipeline.process('key = AKIAIOSFODNN7EXAMPLE')

    expect(result.content).toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('applies custom deny list patterns', async () => {
    const pipeline = createDefaultPipeline({
      customDenyList: ['forbidden\\w*', 'banned'],
    })
    const result = await pipeline.process('This is forbidden_word and banned content.')

    expect(result.content).toContain('[BLOCKED]')
    expect(result.content).not.toContain('forbidden_word')
    expect(result.content).not.toContain('banned')
  })

  it('respects custom maxLength', async () => {
    const pipeline = createDefaultPipeline({ maxLength: 5 })
    const result = await pipeline.process('a'.repeat(20))

    expect(result.truncated).toBe(true)
    expect(result.content).toBe('a'.repeat(5) + '\n[TRUNCATED]')
  })

  it('does not add content-policy stage when no deny list provided', async () => {
    const pipeline = createDefaultPipeline()
    // Just ensure the clean text passes unchanged
    const result = await pipeline.process('Nothing special here.')
    expect(result.content).toBe('Nothing special here.')
    expect(result.appliedStages).toHaveLength(0)
  })
})
