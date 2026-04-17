import { describe, it, expect } from 'vitest'
import {
  hasKey,
  previousSucceeded,
  stateEquals,
  hasFilesMatching,
  allOf,
  anyOf,
} from '../pipeline/phase-conditions.js'

describe('hasKey', () => {
  it('returns true when key exists with truthy value', () => {
    expect(hasKey('plan')({ plan: 'something' })).toBe(true)
  })

  it('returns false when key is missing', () => {
    expect(hasKey('plan')({})).toBe(false)
  })

  it('returns false when key is undefined', () => {
    expect(hasKey('plan')({ plan: undefined })).toBe(false)
  })

  it('returns false when key is null', () => {
    expect(hasKey('plan')({ plan: null })).toBe(false)
  })

  it('returns true for 0 (falsy but not null/undefined)', () => {
    expect(hasKey('count')({ count: 0 })).toBe(true)
  })

  it('returns true for empty string', () => {
    expect(hasKey('name')({ name: '' })).toBe(true)
  })
})

describe('previousSucceeded', () => {
  it('returns true when phase completed flag is set', () => {
    const state = { __phase_generate_completed: true }
    expect(previousSucceeded('generate')(state)).toBe(true)
  })

  it('returns false when phase completed flag is false', () => {
    const state = { __phase_generate_completed: false }
    expect(previousSucceeded('generate')(state)).toBe(false)
  })

  it('returns false when flag is missing', () => {
    expect(previousSucceeded('generate')({})).toBe(false)
  })
})

describe('stateEquals', () => {
  it('returns true for matching value', () => {
    expect(stateEquals('mode', 'fast')({ mode: 'fast' })).toBe(true)
  })

  it('returns false for non-matching value', () => {
    expect(stateEquals('mode', 'fast')({ mode: 'slow' })).toBe(false)
  })

  it('returns false for missing key', () => {
    expect(stateEquals('mode', 'fast')({})).toBe(false)
  })

  it('uses strict equality', () => {
    expect(stateEquals('count', 0)({ count: '0' })).toBe(false)
  })
})

describe('hasFilesMatching', () => {
  it('returns true when files match pattern', () => {
    const state = { files: ['src/foo.ts', 'src/bar.vue'] }
    expect(hasFilesMatching(/\.vue$/)(state)).toBe(true)
  })

  it('returns false when no files match', () => {
    const state = { files: ['src/foo.ts'] }
    expect(hasFilesMatching(/\.vue$/)(state)).toBe(false)
  })

  it('returns false when files is not an array', () => {
    expect(hasFilesMatching(/\.ts$/)({})).toBe(false)
    expect(hasFilesMatching(/\.ts$/)({ files: 'not-array' })).toBe(false)
  })

  it('handles non-string items in array', () => {
    const state = { files: [123, null, 'foo.ts'] }
    expect(hasFilesMatching(/\.ts$/)(state)).toBe(true)
  })
})

describe('allOf', () => {
  it('returns true when all conditions pass', () => {
    const pred = allOf(hasKey('a'), hasKey('b'))
    expect(pred({ a: 1, b: 2 })).toBe(true)
  })

  it('returns false when one condition fails', () => {
    const pred = allOf(hasKey('a'), hasKey('b'))
    expect(pred({ a: 1 })).toBe(false)
  })

  it('returns true for no conditions', () => {
    expect(allOf()({})).toBe(true)
  })
})

describe('anyOf', () => {
  it('returns true when at least one condition passes', () => {
    const pred = anyOf(hasKey('a'), hasKey('b'))
    expect(pred({ b: 2 })).toBe(true)
  })

  it('returns false when no conditions pass', () => {
    const pred = anyOf(hasKey('a'), hasKey('b'))
    expect(pred({ c: 3 })).toBe(false)
  })

  it('returns false for no conditions', () => {
    expect(anyOf()({})).toBe(false)
  })
})
