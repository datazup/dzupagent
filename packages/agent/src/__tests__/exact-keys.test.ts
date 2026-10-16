import { describe, expect, it } from 'vitest'
import { exactKeys } from '../utils/exact-keys.js'

describe('exactKeys', () => {
  it('accepts exactly the expected keys in any order', () => {
    expect(exactKeys({ b: 1, a: 2 }, ['a', 'b'])).toBe(true)
  })

  it('rejects missing and extra keys', () => {
    expect(exactKeys({ a: 1 }, ['a', 'b'])).toBe(false)
    expect(exactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false)
  })

  it('does not treat a separator-bearing key as two keys', () => {
    expect(exactKeys({ 'a|b': 1 }, ['a', 'b'])).toBe(false)
    expect(exactKeys({ a: 1, b: 2 }, ['a|b'])).toBe(false)
  })
})
