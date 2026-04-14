import { describe, it, expect } from 'vitest'
import { DzupError } from '../utils/errors.js'
import { ForgeError } from '@dzupagent/core'

describe('DzupError alias', () => {
  it('DzupError is the same class as ForgeError', () => {
    expect(DzupError).toBe(ForgeError)
  })

  it('instanceof works for both names', () => {
    const err = new DzupError({ code: 'INTERNAL_ERROR', message: 'test' })
    expect(err instanceof ForgeError).toBe(true)
    expect(err instanceof DzupError).toBe(true)
  })

  it('DzupError has same API as ForgeError', () => {
    const err = new DzupError({
      code: 'ADAPTER_EXECUTION_FAILED',
      message: 'test error',
      recoverable: true,
      context: { providerId: 'claude' },
    })
    expect(err.code).toBe('ADAPTER_EXECUTION_FAILED')
    expect(err.message).toBe('test error')
    expect(err.recoverable).toBe(true)
    expect(err.context).toEqual({ providerId: 'claude' })
  })
})
