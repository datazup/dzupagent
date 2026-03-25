import { describe, it, expect } from 'vitest'
import { runEvalSuite } from '../eval-runner.js'
import { DeterministicScorer } from '../deterministic-scorer.js'
import type { EvalSuite } from '../types.js'

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
})
