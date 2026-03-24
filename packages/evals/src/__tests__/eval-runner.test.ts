import { describe, it, expect } from 'vitest'
import { EvalRunner } from '../runner/eval-runner.js'
import { containsScorer, jsonValidScorer, createDeterministicScorer } from '../scorers/deterministic.js'
import type { EvalInput } from '../types.js'

const input = (output: string): EvalInput => ({ input: 'task', output })

describe('EvalRunner', () => {
  it('evaluates a single input across all scorers', async () => {
    const runner = new EvalRunner([
      containsScorer('has-fn', ['function']),
      jsonValidScorer,
    ])

    const results = await runner.evaluate(input('function add() {}'))
    expect(results).toHaveLength(2)
    expect(results[0]!.scorerId).toBe('has-fn')
    expect(results[0]!.pass).toBe(true)
    expect(results[1]!.scorerId).toBe('json-valid')
    expect(results[1]!.pass).toBe(false) // not JSON
  })

  it('evaluates a batch of inputs', async () => {
    const runner = new EvalRunner([
      containsScorer('has-hello', ['hello']),
    ])

    const batch = await runner.evaluateBatch([
      input('hello world'),
      input('goodbye world'),
      input('hello again'),
    ])

    expect(batch.size).toBe(3)
    expect(batch.get(0)![0]!.pass).toBe(true)
    expect(batch.get(1)![0]!.pass).toBe(false)
    expect(batch.get(2)![0]!.pass).toBe(true)
  })

  describe('regressionCheck', () => {
    it('passes when scores meet baseline', async () => {
      const runner = new EvalRunner([
        createDeterministicScorer({ id: 'quality', check: () => 0.9 }),
      ])

      const { passed, regressions } = await runner.regressionCheck(
        [input('a'), input('b')],
        new Map([['quality', 0.8]]),
      )

      expect(passed).toBe(true)
      expect(regressions).toHaveLength(0)
    })

    it('fails when scores drop below baseline', async () => {
      const runner = new EvalRunner([
        createDeterministicScorer({ id: 'quality', check: () => 0.3 }),
      ])

      const { passed, regressions } = await runner.regressionCheck(
        [input('a')],
        new Map([['quality', 0.8]]),
      )

      expect(passed).toBe(false)
      expect(regressions).toHaveLength(1)
      expect(regressions[0]).toContain('quality')
      expect(regressions[0]).toContain('0.300')
    })

    it('returns average scores per scorer', async () => {
      const runner = new EvalRunner([
        createDeterministicScorer({ id: 's1', check: () => 0.5 }),
      ])

      const { averages } = await runner.regressionCheck(
        [input('a'), input('b'), input('c')],
        new Map(),
      )

      expect(averages.get('s1')).toBe(0.5)
    })
  })

  describe('summarize', () => {
    it('computes pass/fail counts', async () => {
      const runner = new EvalRunner([
        containsScorer('has-x', ['x']),
      ])

      const batch = await runner.evaluateBatch([
        input('x is here'),
        input('no match'),
        input('x again'),
      ])

      const summary = EvalRunner.summarize(batch)
      expect(summary.totalInputs).toBe(3)
      expect(summary.totalPass).toBe(2)
      expect(summary.totalFail).toBe(1)
      expect(summary.byScorerPass.get('has-x')).toBe(2)
      expect(summary.byScorerFail.get('has-x')).toBe(1)
    })
  })
})
