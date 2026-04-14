import { describe, it, expect } from 'vitest'
import { tokenizeText, jaccardSimilarity } from '../shared/text-similarity.js'
import { createTimestampedId } from '../shared/id-factory.js'

describe('shared text similarity', () => {
  it('tokenizeText normalizes case and punctuation', () => {
    const tokens = tokenizeText('Hello, HELLO world! a b')
    expect(tokens.has('hello')).toBe(true)
    expect(tokens.has('world')).toBe(true)
    // single-char tokens are intentionally ignored
    expect(tokens.has('a')).toBe(false)
    expect(tokens.has('b')).toBe(false)
  })

  it('tokenizeText supports custom minimum token length', () => {
    const tokens = tokenizeText('a bb ccc', { minTokenLength: 1 })
    expect(tokens.has('a')).toBe(true)
    expect(tokens.has('bb')).toBe(true)
    expect(tokens.has('ccc')).toBe(true)
  })

  it('jaccardSimilarity returns 1 for identical sets and 0 for disjoint sets', () => {
    const a = tokenizeText('alpha beta gamma')
    const b = tokenizeText('alpha beta gamma')
    const c = tokenizeText('delta epsilon zeta')

    expect(jaccardSimilarity(a, b)).toBe(1)
    expect(jaccardSimilarity(a, c)).toBe(0)
  })
})

describe('shared id factory', () => {
  it('creates timestamp-random IDs with prefix', () => {
    const lessonId = createTimestampedId('lesson')
    const skillId = createTimestampedId('skill')

    expect(lessonId).toMatch(/^lesson_\d+_[a-z0-9]+$/)
    expect(skillId).toMatch(/^skill_\d+_[a-z0-9]+$/)
    expect(lessonId).not.toBe(skillId)
  })
})
