import { describe, it, expect } from 'vitest'
import {
  createDeterministicScorer,
  containsScorer,
  jsonValidScorer,
  lengthScorer,
  regexScorer,
  exactMatchScorer,
} from '../scorers/deterministic.js'
import { createCompositeScorer } from '../scorers/composite.js'
import type { EvalInput } from '../types.js'

const input = (output: string, reference?: string): EvalInput => ({
  input: 'test task',
  output,
  reference,
})

describe('Deterministic scorers', () => {
  describe('createDeterministicScorer', () => {
    it('creates a scorer with custom check function', async () => {
      const scorer = createDeterministicScorer({
        id: 'word-count',
        check: (inp) => Math.min(1, inp.output.split(' ').length / 10),
      })

      const result = await scorer.evaluate(input('one two three four five six seven eight nine ten'))
      expect(result.score).toBe(1)
      expect(result.pass).toBe(true)
    })

    it('respects threshold', async () => {
      const scorer = createDeterministicScorer({
        id: 'half',
        check: () => 0.5,
        threshold: 0.6,
      })

      const result = await scorer.evaluate(input('anything'))
      expect(result.score).toBe(0.5)
      expect(result.pass).toBe(false)
    })

    it('clamps score to 0-1', async () => {
      const scorer = createDeterministicScorer({
        id: 'over',
        check: () => 1.5,
      })
      const result = await scorer.evaluate(input('x'))
      expect(result.score).toBe(1)
    })
  })

  describe('containsScorer', () => {
    it('scores 1.0 when all expected strings are found', async () => {
      const scorer = containsScorer('has-all', ['function', 'return', 'export'])
      const result = await scorer.evaluate(input('export function add() { return 1 }'))
      expect(result.score).toBe(1)
      expect(result.pass).toBe(true)
    })

    it('scores proportionally for partial matches', async () => {
      const scorer = containsScorer('partial', ['foo', 'bar', 'baz', 'qux'])
      const result = await scorer.evaluate(input('foo and bar are here'))
      expect(result.score).toBe(0.5) // 2 of 4
    })

    it('scores 0 when nothing matches', async () => {
      const scorer = containsScorer('none', ['xyz', 'abc'])
      const result = await scorer.evaluate(input('hello world'))
      expect(result.score).toBe(0)
    })
  })

  describe('jsonValidScorer', () => {
    it('scores 1 for valid JSON', async () => {
      const result = await jsonValidScorer.evaluate(input('{"key": "value"}'))
      expect(result.score).toBe(1)
    })

    it('scores 0 for invalid JSON', async () => {
      const result = await jsonValidScorer.evaluate(input('not json'))
      expect(result.score).toBe(0)
    })
  })

  describe('lengthScorer', () => {
    it('scores 1 when length is in range', async () => {
      const scorer = lengthScorer('len', 5, 20)
      const result = await scorer.evaluate(input('hello world'))
      expect(result.score).toBe(1)
    })

    it('scores 0 when too short', async () => {
      const scorer = lengthScorer('len', 100, 200)
      const result = await scorer.evaluate(input('hi'))
      expect(result.score).toBe(0)
    })

    it('scores 0 when too long', async () => {
      const scorer = lengthScorer('len', 1, 5)
      const result = await scorer.evaluate(input('this is way too long'))
      expect(result.score).toBe(0)
    })
  })

  describe('regexScorer', () => {
    it('scores 1 when regex matches', async () => {
      const scorer = regexScorer('has-function', /function\s+\w+/)
      const result = await scorer.evaluate(input('function add(a, b) { return a + b }'))
      expect(result.score).toBe(1)
    })

    it('scores 0 when regex does not match', async () => {
      const scorer = regexScorer('has-class', /class\s+\w+/)
      const result = await scorer.evaluate(input('const x = 1'))
      expect(result.score).toBe(0)
    })
  })

  describe('exactMatchScorer', () => {
    it('scores 1 for exact match with reference', async () => {
      const result = await exactMatchScorer.evaluate(input('hello', 'hello'))
      expect(result.score).toBe(1)
    })

    it('scores 0 for mismatch', async () => {
      const result = await exactMatchScorer.evaluate(input('hello', 'world'))
      expect(result.score).toBe(0)
    })

    it('scores 0 when no reference', async () => {
      const result = await exactMatchScorer.evaluate(input('hello'))
      expect(result.score).toBe(0)
    })

    it('trims whitespace before comparing', async () => {
      const result = await exactMatchScorer.evaluate(input('  hello  ', '  hello  '))
      expect(result.score).toBe(1)
    })
  })
})

describe('Composite scorer', () => {
  it('computes weighted average', async () => {
    const scorer = createCompositeScorer({
      id: 'combined',
      scorers: [
        { scorer: createDeterministicScorer({ id: 'a', check: () => 1.0 }), weight: 3 },
        { scorer: createDeterministicScorer({ id: 'b', check: () => 0.0 }), weight: 1 },
      ],
    })

    const result = await scorer.evaluate(input('test'))
    expect(result.score).toBeCloseTo(0.75) // (1.0*3 + 0.0*1) / 4
  })

  it('passes when weighted average meets threshold', async () => {
    const scorer = createCompositeScorer({
      id: 'pass',
      threshold: 0.5,
      scorers: [
        { scorer: createDeterministicScorer({ id: 'a', check: () => 0.6 }), weight: 1 },
        { scorer: createDeterministicScorer({ id: 'b', check: () => 0.8 }), weight: 1 },
      ],
    })

    const result = await scorer.evaluate(input('test'))
    expect(result.pass).toBe(true)
  })

  it('includes breakdown in metadata', async () => {
    const scorer = createCompositeScorer({
      id: 'breakdown',
      scorers: [
        { scorer: containsScorer('has-x', ['x']), weight: 1 },
        { scorer: jsonValidScorer, weight: 1 },
      ],
    })

    const result = await scorer.evaluate(input('{"x": 1}'))
    expect(result.metadata?.['breakdown']).toHaveLength(2)
  })

  it('includes reasoning with scorer labels', async () => {
    const scorer = createCompositeScorer({
      id: 'labeled',
      scorers: [
        { scorer: createDeterministicScorer({ id: 'alpha', check: () => 0.9 }), weight: 1 },
      ],
    })

    const result = await scorer.evaluate(input('test'))
    expect(result.reasoning).toContain('alpha')
    expect(result.reasoning).toContain('0.90')
  })
})
