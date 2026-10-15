import { test, expect } from 'vitest'
import { KeywordMatcher } from '../router/keyword-matcher.js'

test('keyword matcher returns the first registered match and every match in registration order', () => {
  const matcher = new KeywordMatcher().addPattern(/one/, 'first').addPattern(/two/, 'second')
  expect(matcher.match('one two')).toBe('first')
  expect(matcher.matchAll('one two')).toEqual(['first', 'second'])
  expect(matcher.match('absent')).toBeNull()
})
