import { describe, it, expect } from 'vitest'
import { ForgeError } from '@dzupagent/core'

describe('Error Context Enrichment', () => {
  it('ForgeError supports context field', () => {
    const err = new ForgeError({
      code: 'ADAPTER_EXECUTION_FAILED',
      message: 'test',
      context: { providerId: 'claude', model: 'sonnet' },
    })
    expect(err.context).toEqual({ providerId: 'claude', model: 'sonnet' })
  })

  it('context appears in toJSON', () => {
    const err = new ForgeError({
      code: 'ADAPTER_EXECUTION_FAILED',
      message: 'test',
      context: { providerId: 'claude' },
    })
    const json = err.toJSON()
    expect(json.context).toEqual({ providerId: 'claude' })
  })

  it('ForgeError.wrap preserves context from defaults', () => {
    const original = new Error('upstream failure')
    const wrapped = ForgeError.wrap(original, {
      code: 'ADAPTER_EXECUTION_FAILED',
      context: {
        providerId: 'claude',
        model: 'claude-sonnet-4-20250514',
        promptLength: 42,
      },
    })
    expect(wrapped.context).toEqual({
      providerId: 'claude',
      model: 'claude-sonnet-4-20250514',
      promptLength: 42,
    })
    expect(wrapped.message).toBe('upstream failure')
  })

  it('context with registry exhaustion info', () => {
    const err = new ForgeError({
      code: 'ALL_ADAPTERS_EXHAUSTED',
      message: 'All adapters failed',
      context: {
        attemptedProviders: ['claude', 'codex', 'gemini'],
        taskTags: ['code-generation'],
      },
    })
    const json = err.toJSON()
    expect(json.context).toEqual({
      attemptedProviders: ['claude', 'codex', 'gemini'],
      taskTags: ['code-generation'],
    })
    expect(json.code).toBe('ALL_ADAPTERS_EXHAUSTED')
  })

  it('context with recovery exhaustion info', () => {
    const err = new ForgeError({
      code: 'ALL_ADAPTERS_EXHAUSTED',
      message: 'Recovery exhausted after 3 attempts',
      context: {
        providerId: 'gemini',
        attempts: 3,
        maxAttempts: 3,
      },
    })
    expect(err.context?.['attempts']).toBe(3)
    expect(err.context?.['providerId']).toBe('gemini')
  })

  it('ForgeError without context has undefined context', () => {
    const err = new ForgeError({
      code: 'ADAPTER_EXECUTION_FAILED',
      message: 'no context',
    })
    expect(err.context).toBeUndefined()
    const json = err.toJSON()
    expect(json.context).toBeUndefined()
  })
})
