import { describe, it, expect, vi } from 'vitest'
import { runEvalSuite } from '../eval-runner.js'
import { DeterministicScorer } from '../deterministic-scorer.js'
import type { EvalScorer, EvalSuite } from '../types.js'

describe('runEvalSuite', () => {
  it('evaluates all cases with all scorers', async () => {
    const suite: EvalSuite = {
      name: 'test-suite',
      cases: [
        { id: 'case-1', input: 'hello', expectedOutput: 'hello world' },
        { id: 'case-2', input: 'bye', expectedOutput: 'goodbye' },
      ],
      scorers: [
        new DeterministicScorer({ name: 'contains-check', mode: 'contains' }),
      ],
    }

    const result = await runEvalSuite(suite, async (input) => {
      if (input === 'hello') return 'hello world'
      return 'see ya'
    })

    expect(result.suiteId).toBe('test-suite')
    expect(result.results).toHaveLength(2)
    // case-1: output 'hello world' contains reference 'hello world' → pass
    expect(result.results[0]!.caseId).toBe('case-1')
    expect(result.results[0]!.scorerResults[0]!.result.pass).toBe(true)
    // case-2: output 'see ya' does not contain reference 'goodbye' → fail
    expect(result.results[1]!.caseId).toBe('case-2')
    expect(result.results[1]!.scorerResults[0]!.result.pass).toBe(false)
  })

  it('computes aggregate score and pass rate', async () => {
    const suite: EvalSuite = {
      name: 'agg-suite',
      passThreshold: 0.5,
      cases: [
        { id: 'c1', input: 'a', expectedOutput: 'a' },
        { id: 'c2', input: 'b', expectedOutput: 'x' },
      ],
      scorers: [
        new DeterministicScorer({ name: 'exact', mode: 'exactMatch' }),
      ],
    }

    const result = await runEvalSuite(suite, async (input) => input)

    // c1: 'a' === 'a' → score 1.0, pass (>=0.5)
    // c2: 'b' !== 'x' → score 0.0, fail (<0.5)
    expect(result.passRate).toBe(0.5) // 1 of 2 passed
    expect(result.aggregateScore).toBe(0.5) // (1.0 + 0.0) / 2
  })

  it('handles empty cases', async () => {
    const suite: EvalSuite = {
      name: 'empty',
      cases: [],
      scorers: [
        new DeterministicScorer({ name: 'exact', mode: 'exactMatch' }),
      ],
    }

    const result = await runEvalSuite(suite, async () => '')

    expect(result.results).toHaveLength(0)
    expect(result.aggregateScore).toBe(0)
    expect(result.passRate).toBe(0)
  })

  it('uses multiple scorers per case', async () => {
    const suite: EvalSuite = {
      name: 'multi-scorer',
      cases: [
        { id: 'c1', input: 'test', expectedOutput: 'test output' },
      ],
      scorers: [
        new DeterministicScorer({ name: 'contains', mode: 'contains' }),
        new DeterministicScorer({ name: 'exact', mode: 'exactMatch' }),
      ],
    }

    const result = await runEvalSuite(suite, async () => 'test output')

    const case1 = result.results[0]!
    expect(case1.scorerResults).toHaveLength(2)
    // 'test output' contains 'test output' → pass
    expect(case1.scorerResults[0]!.result.pass).toBe(true)
    // 'test output' === 'test output' → pass
    expect(case1.scorerResults[1]!.result.pass).toBe(true)
    expect(case1.aggregateScore).toBe(1.0)
  })

  it('includes timestamp in result', async () => {
    const suite: EvalSuite = {
      name: 'ts-check',
      cases: [{ id: 'c1', input: 'x' }],
      scorers: [
        new DeterministicScorer({ name: 'regex', mode: 'regex', pattern: /.+/ }),
      ],
    }

    const result = await runEvalSuite(suite, async () => 'output')

    expect(result.timestamp).toBeTruthy()
    expect(new Date(result.timestamp).getTime()).not.toBeNaN()
  })

  // -------------------------------------------------------------------------
  // W18-B2: gap-filling tests
  // -------------------------------------------------------------------------

  describe('boundary conditions', () => {
    it('returns empty results array when suite has 0 cases', async () => {
      const suite: EvalSuite = {
        name: 'zero-cases',
        cases: [],
        scorers: [
          new DeterministicScorer({ mode: 'exactMatch' }),
        ],
      }

      const result = await runEvalSuite(suite, async () => 'anything')

      expect(result.results).toHaveLength(0)
      expect(result.aggregateScore).toBe(0)
      expect(result.passRate).toBe(0)
    })

    it('marks all cases as failed when every scorer scores 0', async () => {
      const suite: EvalSuite = {
        name: 'all-fail',
        passThreshold: 0.5,
        cases: [
          { id: 'c1', input: 'a', expectedOutput: 'expected-a' },
          { id: 'c2', input: 'b', expectedOutput: 'expected-b' },
          { id: 'c3', input: 'c', expectedOutput: 'expected-c' },
        ],
        scorers: [
          new DeterministicScorer({ mode: 'exactMatch' }),
        ],
      }

      const result = await runEvalSuite(suite, async () => 'always-wrong')

      const failedCount = result.results.filter((r) => !r.pass).length
      expect(failedCount).toBe(3)
      expect(result.passRate).toBe(0)
      expect(result.aggregateScore).toBe(0)
    })

    it('passThreshold=0.0 always passes even when score is 0', async () => {
      const suite: EvalSuite = {
        name: 'threshold-zero',
        passThreshold: 0.0,
        cases: [
          { id: 'c1', input: 'x', expectedOutput: 'wrong' },
        ],
        scorers: [
          new DeterministicScorer({ mode: 'exactMatch' }),
        ],
      }

      const result = await runEvalSuite(suite, async () => 'something-else')

      expect(result.results[0]!.aggregateScore).toBe(0)
      expect(result.results[0]!.pass).toBe(true)
      expect(result.passRate).toBe(1.0)
    })

    it('passThreshold=1.0 fails unless every scorer returns 1.0', async () => {
      const suite: EvalSuite = {
        name: 'threshold-one',
        passThreshold: 1.0,
        cases: [
          { id: 'pass', input: 'a', expectedOutput: 'a' },
          { id: 'fail', input: 'b', expectedOutput: 'wrong' },
        ],
        scorers: [
          new DeterministicScorer({ mode: 'exactMatch' }),
        ],
      }

      const result = await runEvalSuite(suite, async (input) => input)

      expect(result.results[0]!.pass).toBe(true)
      expect(result.results[0]!.aggregateScore).toBe(1.0)
      expect(result.results[1]!.pass).toBe(false)
      expect(result.passRate).toBe(0.5)
    })

    it('case at exactly the threshold passes (>= comparison)', async () => {
      const half: EvalScorer = {
        name: 'half',
        score: vi.fn().mockResolvedValue({
          score: 0.7,
          pass: true,
          reasoning: 'fixed score',
        }),
      }

      const suite: EvalSuite = {
        name: 'exactly-at-threshold',
        passThreshold: 0.7,
        cases: [{ id: 'c1', input: 'x' }],
        scorers: [half],
      }

      const result = await runEvalSuite(suite, async () => 'output')

      expect(result.results[0]!.aggregateScore).toBeCloseTo(0.7)
      expect(result.results[0]!.pass).toBe(true)
    })
  })

  describe('multiple scorers and aggregation', () => {
    it('computes aggregateScore as the average of all scorer results per case', async () => {
      const high: EvalScorer = {
        name: 'high',
        score: vi.fn().mockResolvedValue({
          score: 1.0,
          pass: true,
          reasoning: 'top',
        }),
      }
      const mid: EvalScorer = {
        name: 'mid',
        score: vi.fn().mockResolvedValue({
          score: 0.5,
          pass: true,
          reasoning: 'mid',
        }),
      }
      const low: EvalScorer = {
        name: 'low',
        score: vi.fn().mockResolvedValue({
          score: 0.0,
          pass: false,
          reasoning: 'bot',
        }),
      }

      const suite: EvalSuite = {
        name: 'avg-three',
        cases: [{ id: 'c1', input: 'in' }],
        scorers: [high, mid, low],
      }

      const result = await runEvalSuite(suite, async () => 'out')

      // (1.0 + 0.5 + 0.0) / 3 = 0.5
      expect(result.results[0]!.aggregateScore).toBeCloseTo(0.5)
      expect(result.results[0]!.scorerResults).toHaveLength(3)
    })
  })

  describe('error handling', () => {
    it('propagates a scorer that throws (Promise.all reject) — caller observes the error', async () => {
      const broken: EvalScorer = {
        name: 'broken',
        score: vi.fn().mockRejectedValue(new Error('scorer crashed')),
      }
      const fine: EvalScorer = {
        name: 'fine',
        score: vi.fn().mockResolvedValue({
          score: 1.0,
          pass: true,
          reasoning: 'ok',
        }),
      }

      const suite: EvalSuite = {
        name: 'error-suite',
        cases: [{ id: 'c1', input: 'x' }],
        scorers: [broken, fine],
      }

      await expect(
        runEvalSuite(suite, async () => 'out'),
      ).rejects.toThrow('scorer crashed')
    })

    it('propagates a target function that throws', async () => {
      const suite: EvalSuite = {
        name: 'target-error',
        cases: [{ id: 'c1', input: 'x' }],
        scorers: [
          new DeterministicScorer({ mode: 'exactMatch' }),
        ],
      }

      await expect(
        runEvalSuite(suite, async () => {
          throw new Error('target failure')
        }),
      ).rejects.toThrow('target failure')
    })
  })

  describe('concurrency', () => {
    it('produces independent results when run twice in parallel', async () => {
      const suite: EvalSuite = {
        name: 'parallel-runs',
        cases: [
          { id: 'c1', input: 'a', expectedOutput: 'a' },
          { id: 'c2', input: 'b', expectedOutput: 'b' },
        ],
        scorers: [
          new DeterministicScorer({ mode: 'exactMatch' }),
        ],
      }

      const [resA, resB] = await Promise.all([
        runEvalSuite(suite, async (input) => input),
        runEvalSuite(suite, async (input) => input),
      ])

      // Both runs should be passing and have identical aggregate scores,
      // but be different objects with independent timestamps.
      expect(resA).not.toBe(resB)
      expect(resA.aggregateScore).toBe(resB.aggregateScore)
      expect(resA.results).toHaveLength(2)
      expect(resB.results).toHaveLength(2)
      expect(resA.aggregateScore).toBe(1.0)
      expect(resB.aggregateScore).toBe(1.0)
    })

    it('does not cross-pollinate caseIds between concurrent runs', async () => {
      const makeSuite = (label: string): EvalSuite => ({
        name: `suite-${label}`,
        cases: [
          { id: `${label}-1`, input: 'in1', expectedOutput: 'in1' },
          { id: `${label}-2`, input: 'in2', expectedOutput: 'in2' },
        ],
        scorers: [new DeterministicScorer({ mode: 'exactMatch' })],
      })

      const [a, b] = await Promise.all([
        runEvalSuite(makeSuite('alpha'), async (i) => i),
        runEvalSuite(makeSuite('beta'), async (i) => i),
      ])

      const aIds = a.results.map((r) => r.caseId)
      const bIds = b.results.map((r) => r.caseId)
      expect(aIds).toEqual(['alpha-1', 'alpha-2'])
      expect(bIds).toEqual(['beta-1', 'beta-2'])
    })
  })

  describe('default passThreshold', () => {
    it('uses default 0.7 threshold when not specified', async () => {
      const sixty: EvalScorer = {
        name: 'sixty',
        score: vi.fn().mockResolvedValue({
          score: 0.6,
          pass: false,
          reasoning: '60%',
        }),
      }
      const seventy: EvalScorer = {
        name: 'seventy',
        score: vi.fn().mockResolvedValue({
          score: 0.7,
          pass: true,
          reasoning: '70%',
        }),
      }

      const suite: EvalSuite = {
        name: 'default-threshold',
        cases: [
          { id: 'below', input: 'x' },
          { id: 'at', input: 'y' },
        ],
        scorers: [sixty],
      }

      const r1 = await runEvalSuite(suite, async () => 'out')
      // 0.6 < default 0.7 => fail
      expect(r1.results.every((r) => !r.pass)).toBe(true)

      const suite2: EvalSuite = {
        name: 'default-threshold-pass',
        cases: [{ id: 'at', input: 'y' }],
        scorers: [seventy],
      }
      const r2 = await runEvalSuite(suite2, async () => 'out')
      // 0.7 >= default 0.7 => pass
      expect(r2.results[0]!.pass).toBe(true)
    })
  })
})
