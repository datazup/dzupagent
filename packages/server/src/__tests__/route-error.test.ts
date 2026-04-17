import { describe, it, expect } from 'vitest'
import { sanitizeError, parseIntBounded } from '../routes/route-error.js'

describe('sanitizeError', () => {
  it('returns generic message for plain Error', () => {
    const result = sanitizeError(new Error('secret DB connection string'))
    expect(result.safe).toBe('Internal server error')
    expect(result.internal).toBe('secret DB connection string')
  })

  it('returns original message for Validation-prefixed error class name', () => {
    class ValidationError extends Error {
      constructor(msg: string) { super(msg) }
    }
    const result = sanitizeError(new ValidationError('field X is required'))
    expect(result.safe).toBe('field X is required')
    expect(result.internal).toBe('field X is required')
  })

  it('returns original message for NotFound-prefixed error class name', () => {
    class NotFoundError extends Error {
      constructor(msg: string) { super(msg) }
    }
    const result = sanitizeError(new NotFoundError('Agent not found'))
    expect(result.safe).toBe('Agent not found')
  })

  it('returns original message when error message starts with safe prefix', () => {
    const err = new Error('BadRequest: missing required field')
    const result = sanitizeError(err)
    expect(result.safe).toBe('BadRequest: missing required field')
  })

  it('returns original message for Conflict-prefixed error message', () => {
    const err = new Error('Conflict: resource already exists')
    const result = sanitizeError(err)
    expect(result.safe).toBe('Conflict: resource already exists')
  })

  it('handles non-Error thrown values', () => {
    const result = sanitizeError('string error')
    expect(result.safe).toBe('Internal server error')
    expect(result.internal).toBe('string error')
  })

  it('handles null/undefined thrown values', () => {
    const result = sanitizeError(null)
    expect(result.safe).toBe('Internal server error')
    expect(result.internal).toBe('null')
  })
})

describe('parseIntBounded', () => {
  it('returns defaultValue when raw is undefined', () => {
    expect(parseIntBounded(undefined, { defaultValue: 50 })).toBe(50)
  })

  it('returns defaultValue when raw is null', () => {
    expect(parseIntBounded(null, { defaultValue: 10 })).toBe(10)
  })

  it('returns defaultValue when raw is empty string', () => {
    expect(parseIntBounded('', { defaultValue: 25 })).toBe(25)
  })

  it('returns undefined (no default) when raw is undefined and no defaultValue', () => {
    expect(parseIntBounded(undefined)).toBeUndefined()
  })

  it('parses valid integer within bounds', () => {
    expect(parseIntBounded('42', { min: 0, max: 100 })).toBe(42)
  })

  it('returns undefined for NaN input', () => {
    expect(parseIntBounded('abc', { min: 0, max: 100 })).toBeUndefined()
  })

  it('returns undefined when value is below min', () => {
    expect(parseIntBounded('-5', { min: 0, max: 100 })).toBeUndefined()
  })

  it('returns undefined when value is above max', () => {
    expect(parseIntBounded('200', { min: 0, max: 100 })).toBeUndefined()
  })

  it('uses default min=0 and max=10000', () => {
    expect(parseIntBounded('5000')).toBe(5000)
    expect(parseIntBounded('-1')).toBeUndefined()
    expect(parseIntBounded('10001')).toBeUndefined()
  })

  it('accepts boundary values (min and max are inclusive)', () => {
    expect(parseIntBounded('0', { min: 0, max: 100 })).toBe(0)
    expect(parseIntBounded('100', { min: 0, max: 100 })).toBe(100)
  })
})
