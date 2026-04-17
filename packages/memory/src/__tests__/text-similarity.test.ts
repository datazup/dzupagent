import { describe, it, expect } from 'vitest'
import { tokenizeText, jaccardSimilarity } from '../shared/text-similarity.js'

describe('tokenizeText', () => {
  it('lowercases tokens', () => {
    expect(tokenizeText('Hello World')).toEqual(new Set(['hello', 'world']))
  })

  it('strips punctuation', () => {
    expect(tokenizeText('foo, bar. baz!')).toEqual(new Set(['foo', 'bar', 'baz']))
  })

  it('deduplicates repeated tokens', () => {
    const tokens = tokenizeText('hello hello hello world')
    expect(tokens.size).toBe(2)
  })

  it('drops tokens below minTokenLength (default 2)', () => {
    const tokens = tokenizeText('a an the in of on')
    // 'a' length 1 dropped; 'an','in','of','on','the' kept
    expect(tokens.has('a')).toBe(false)
    expect(tokens.has('an')).toBe(true)
    expect(tokens.has('the')).toBe(true)
  })

  it('allows minTokenLength=1 to keep single-character tokens', () => {
    const tokens = tokenizeText('a b c', { minTokenLength: 1 })
    expect(tokens.has('a')).toBe(true)
    expect(tokens.has('b')).toBe(true)
    expect(tokens.has('c')).toBe(true)
  })

  it('returns an empty set for empty string', () => {
    expect(tokenizeText('').size).toBe(0)
  })

  it('collapses multiple whitespace', () => {
    expect(tokenizeText('hi\t \nthere  friend')).toEqual(
      new Set(['hi', 'there', 'friend']),
    )
  })

  it('treats numbers and underscores as word characters', () => {
    const tokens = tokenizeText('api_key 123 abc_def')
    expect(tokens.has('api_key')).toBe(true)
    expect(tokens.has('123')).toBe(true)
    expect(tokens.has('abc_def')).toBe(true)
  })

  it('respects custom minTokenLength (e.g. 4)', () => {
    const tokens = tokenizeText('foo bar hello world', { minTokenLength: 4 })
    expect(tokens.has('foo')).toBe(false)
    expect(tokens.has('bar')).toBe(false)
    expect(tokens.has('hello')).toBe(true)
  })
})

describe('jaccardSimilarity', () => {
  it('returns 1 for two empty sets (both empty edge case)', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1)
  })

  it('returns 0 when one side is empty and the other has items', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0)
    expect(jaccardSimilarity(new Set(), new Set(['b']))).toBe(0)
  })

  it('returns 1 for identical sets', () => {
    const a = new Set(['a', 'b', 'c'])
    const b = new Set(['a', 'b', 'c'])
    expect(jaccardSimilarity(a, b)).toBe(1)
  })

  it('returns 0 for disjoint sets', () => {
    expect(
      jaccardSimilarity(new Set(['a', 'b']), new Set(['x', 'y'])),
    ).toBe(0)
  })

  it('computes classic Jaccard example', () => {
    // |A∩B|=1, |A∪B|=3 -> 1/3
    const a = new Set(['x', 'y'])
    const b = new Set(['y', 'z'])
    expect(jaccardSimilarity(a, b)).toBeCloseTo(1 / 3, 6)
  })

  it('is symmetric', () => {
    const a = new Set(['one', 'two', 'three'])
    const b = new Set(['two', 'three', 'four'])
    expect(jaccardSimilarity(a, b)).toBeCloseTo(jaccardSimilarity(b, a), 10)
  })

  it('handles one set being a subset of the other', () => {
    const a = new Set(['a', 'b'])
    const b = new Set(['a', 'b', 'c', 'd'])
    // intersection 2, union 4 -> 0.5
    expect(jaccardSimilarity(a, b)).toBe(0.5)
  })
})
