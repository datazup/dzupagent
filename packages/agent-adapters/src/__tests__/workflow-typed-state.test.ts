import { describe, it, expect } from 'vitest'
import { typedStep } from '../workflow/adapter-workflow.js'

describe('Typed Workflow State', () => {
  it('typedStep creates a step config with promptFn', () => {
    interface MyState { research: string }
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

  it('promptFn receives state at runtime', () => {
    const step = typedStep<{ count: number }>({
      id: 'counter',
      prompt: '',
      promptFn: (s) => `Count is ${s.count}`,
    })
    expect(step.promptFn!({ count: 42 } as Record<string, unknown>)).toBe('Count is 42')
  })
})
