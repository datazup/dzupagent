import { describe, it, expect } from 'vitest'
import { typedStep } from '../workflow/adapter-workflow.js'

describe('Typed Workflow State', () => {
  it('typedStep creates a step config with promptFn', () => {
    type MyState = { research: string }
    const step = typedStep<MyState>({
      id: 'plan',
      prompt: 'fallback',
      promptFn: (state) => `Plan from: ${state.research}`,
      tags: ['planning'],
    })
    expect(step.id).toBe('plan')
    expect(step.promptFn).toBeDefined()
    expect(step.promptFn!({ research: 'findings' })).toBe('Plan from: findings')
  })

  it('typedStep preserves all other config fields', () => {
    const step = typedStep({
      id: 'test',
      prompt: 'default',
      promptFn: () => 'dynamic',
      tags: ['code'],
      maxRetries: 3,
      timeoutMs: 5000,
    })
    expect(step.tags).toEqual(['code'])
    expect(step.maxRetries).toBe(3)
    expect(step.timeoutMs).toBe(5000)
  })

  it('accepts the documented config shape, which omits prompt', () => {
    // This is typedStep's own JSDoc example. Before the prompt requirement was
    // lifted it did not compile, so the helper's documentation described a call
    // no caller could make.
    const step = typedStep<{ research: string }>({
      id: 'plan',
      promptFn: (state) => `Create plan from: ${state.research}`,
      tags: ['planning'],
    })
    // AdapterStepConfig still requires a string, so the helper supplies one.
    expect(step.prompt).toBe('')
    expect(step.promptFn!({ research: 'findings' })).toBe('Create plan from: findings')
  })

  it('keeps a caller-supplied prompt instead of overwriting it with the default', () => {
    const step = typedStep({ id: 'x', prompt: 'kept', promptFn: () => 'dynamic' })
    expect(step.prompt).toBe('kept')
  })

  it('promptFn receives state at runtime', () => {
    const step = typedStep<{ count: number }>({
      id: 'counter',
      prompt: '',
      promptFn: (s) => `Count is ${s.count}`,
    })
    expect(step.promptFn!({ count: 42 } as Record<string, unknown>)).toBe('Count is 42')
  })
})
