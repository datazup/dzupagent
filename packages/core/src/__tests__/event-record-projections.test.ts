import { test, expect } from 'vitest'
import { getString, getNumber, getObject, toJsonString } from '../utils/event-record.js'

test('event projections ignore wrong types and nonfinite numbers without losing valid aliases', () => {
  const input = { invalid: null, array: [], number: 12, infinity: Infinity, text: 'valid', object: { retained: true } }
  expect(getString(input, 'invalid', 'text')).toBe('valid')
  expect(getString(input, 'number')).toBeUndefined()
  expect(getNumber(input, 'infinity', 'number')).toBe(12)
  expect(getNumber(input, 'text')).toBeUndefined()
  expect(getObject(input, 'array', 'object')).toEqual({ retained: true })
  expect(getObject(input, 'invalid')).toBeUndefined()
  expect(toJsonString('text')).toBe('text')
  expect(toJsonString(null)).toBe('""')
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  expect(toJsonString(cycle)).toBe('[object Object]')
})
