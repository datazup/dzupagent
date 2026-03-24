import { describe, it, expect } from 'vitest'
import { ForgeError } from '../errors/forge-error.js'

describe('ForgeError', () => {
  it('creates with required fields', () => {
    const err = new ForgeError({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'Anthropic API returned 503',
    })
    expect(err.code).toBe('PROVIDER_UNAVAILABLE')
    expect(err.message).toBe('Anthropic API returned 503')
    expect(err.recoverable).toBe(false)
    expect(err.name).toBe('ForgeError')
    expect(err).toBeInstanceOf(Error)
  })

  it('creates with all optional fields', () => {
    const cause = new Error('network timeout')
    const err = new ForgeError({
      code: 'PROVIDER_TIMEOUT',
      message: 'Request timed out',
      recoverable: true,
      phase: 'gen_backend',
      suggestion: 'Retry with longer timeout',
      context: { provider: 'anthropic', tier: 'codegen' },
      cause,
    })
    expect(err.recoverable).toBe(true)
    expect(err.phase).toBe('gen_backend')
    expect(err.suggestion).toBe('Retry with longer timeout')
    expect(err.context).toEqual({ provider: 'anthropic', tier: 'codegen' })
    expect(err.cause).toBe(cause)
  })

  it('ForgeError.is() detects ForgeError instances', () => {
    const forgeErr = new ForgeError({ code: 'INTERNAL_ERROR', message: 'test' })
    const plainErr = new Error('test')
    expect(ForgeError.is(forgeErr)).toBe(true)
    expect(ForgeError.is(plainErr)).toBe(false)
    expect(ForgeError.is(null)).toBe(false)
    expect(ForgeError.is('string')).toBe(false)
  })

  it('ForgeError.wrap() wraps generic errors', () => {
    const original = new Error('connection refused')
    const wrapped = ForgeError.wrap(original, { code: 'MCP_CONNECTION_FAILED' })
    expect(wrapped).toBeInstanceOf(ForgeError)
    expect(wrapped.code).toBe('MCP_CONNECTION_FAILED')
    expect(wrapped.message).toBe('connection refused')
    expect(wrapped.cause).toBe(original)
  })

  it('ForgeError.wrap() returns existing ForgeError unchanged', () => {
    const original = new ForgeError({ code: 'TOOL_NOT_FOUND', message: 'nope' })
    const result = ForgeError.wrap(original, { code: 'INTERNAL_ERROR' })
    expect(result).toBe(original) // same reference
    expect(result.code).toBe('TOOL_NOT_FOUND') // not overwritten
  })

  it('ForgeError.wrap() handles non-Error values', () => {
    const wrapped = ForgeError.wrap('string error', { code: 'INTERNAL_ERROR' })
    expect(wrapped.message).toBe('string error')
    expect(wrapped.cause).toBeUndefined()
  })

  it('toJSON() serializes without circular references', () => {
    const err = new ForgeError({
      code: 'BUDGET_EXCEEDED',
      message: 'Token limit reached',
      recoverable: false,
      phase: 'gen_frontend',
      context: { tokens: 150_000 },
    })
    const json = err.toJSON()
    expect(json).toEqual({
      name: 'ForgeError',
      code: 'BUDGET_EXCEEDED',
      message: 'Token limit reached',
      recoverable: false,
      phase: 'gen_frontend',
      suggestion: undefined,
      context: { tokens: 150_000 },
    })
    // Must be JSON-serializable
    expect(() => JSON.stringify(json)).not.toThrow()
  })
})
