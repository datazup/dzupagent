/**
 * Extended tests for merge strategies (both typed OrchestrationMergeStrategy
 * classes and the simple string-based MergeStrategyFn helpers).
 *
 * Covers edge cases: empty inputs, single inputs, partial failures,
 * error propagation, durationMs preservation, type discrimination,
 * and the simple merge-strategies.ts utility functions.
 */
import { describe, it, expect } from 'vitest'
import { AllRequiredMergeStrategy } from '../merge/all-required.js'
import { UsePartialMergeStrategy } from '../merge/use-partial.js'
import { FirstWinsMergeStrategy } from '../merge/first-wins.js'
import type { AgentResult, MergedResult } from '../orchestration-merge-strategy-types.js'
import {
  concatMerge,
  voteMerge,
  numberedMerge,
  jsonArrayMerge,
  getMergeStrategy,
} from '../merge-strategies.js'
import { assertDepthAllowed, MAX_ORCHESTRATION_DEPTH } from '../delegating-supervisor.js'

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function success<T>(agentId: string, output: T, durationMs?: number): AgentResult<T> {
  return { agentId, status: 'success', output, durationMs }
}

function timeout(agentId: string, durationMs?: number): AgentResult<string> {
  return { agentId, status: 'timeout', error: 'timed out', durationMs }
}

function error(agentId: string, msg = 'agent crashed'): AgentResult<string> {
  return { agentId, status: 'error', error: msg }
}

// ===========================================================================
// AllRequiredMergeStrategy — extended
// ===========================================================================

describe('AllRequiredMergeStrategy — extended', () => {
  const strategy = new AllRequiredMergeStrategy<string>()

  it('returns success for a single successful result', () => {
    const merged = strategy.merge([success('a', 'out-a')])
    expect(merged.status).toBe('success')
    expect(merged.output).toEqual(['out-a'])
    expect(merged.successCount).toBe(1)
    expect(merged.timeoutCount).toBe(0)
    expect(merged.errorCount).toBe(0)
  })

  it('handles empty input array', () => {
    const merged = strategy.merge([])
    expect(merged.status).toBe('success')
    expect(merged.output).toEqual([])
    expect(merged.successCount).toBe(0)
    expect(merged.agentResults).toEqual([])
  })

  it('preserves agentResults in output', () => {
    const inputs = [success('a', 'x'), success('b', 'y')]
    const merged = strategy.merge(inputs)
    expect(merged.agentResults).toHaveLength(2)
    expect(merged.agentResults[0]!.agentId).toBe('a')
    expect(merged.agentResults[1]!.agentId).toBe('b')
  })

  it('distinguishes all_timeout from all_failed when only errors present', () => {
    const merged = strategy.merge([error('a'), error('b')])
    expect(merged.status).toBe('all_failed')
  })

  it('distinguishes all_timeout from all_failed with mixed timeout + error', () => {
    const merged = strategy.merge([timeout('a'), error('b')])
    expect(merged.status).toBe('all_failed')
    expect(merged.timeoutCount).toBe(1)
    expect(merged.errorCount).toBe(1)
  })

  it('preserves durationMs metadata on agent results', () => {
    const inputs = [success('a', 'out', 150), success('b', 'out', 300)]
    const merged = strategy.merge(inputs)
    expect(merged.agentResults[0]!.durationMs).toBe(150)
    expect(merged.agentResults[1]!.durationMs).toBe(300)
  })

  it('works with complex generic types', () => {
    const complexStrategy = new AllRequiredMergeStrategy<{ value: number }>()
    const inputs: AgentResult<{ value: number }>[] = [
      { agentId: 'a', status: 'success', output: { value: 1 } },
      { agentId: 'b', status: 'success', output: { value: 2 } },
    ]
    const merged = complexStrategy.merge(inputs)
    expect(merged.status).toBe('success')
    expect(merged.output).toEqual([{ value: 1 }, { value: 2 }])
  })
})

// ===========================================================================
// UsePartialMergeStrategy — extended
// ===========================================================================

describe('UsePartialMergeStrategy — extended', () => {
  const strategy = new UsePartialMergeStrategy<string>()

  it('handles a single successful result', () => {
    const merged = strategy.merge([success('a', 'out-a')])
    expect(merged.status).toBe('partial')
    expect(merged.output).toEqual(['out-a'])
    expect(merged.successCount).toBe(1)
  })

  it('handles empty input array — all_timeout by convention (0 timeouts = 0 total)', () => {
    const merged = strategy.merge([])
    // successCount is 0, timeoutCount is 0, so timeoutCount === results.length (0 === 0) => all_timeout
    expect(merged.status).toBe('all_timeout')
    expect(merged.output).toBeUndefined()
  })

  it('filters out error results from output', () => {
    const merged = strategy.merge([
      success('a', 'good'),
      error('b'),
      success('c', 'also-good'),
    ])
    expect(merged.output).toEqual(['good', 'also-good'])
    expect(merged.successCount).toBe(2)
    expect(merged.errorCount).toBe(1)
  })

  it('filters out timeout results from output', () => {
    const merged = strategy.merge([
      timeout('a'),
      success('b', 'only-good'),
      timeout('c'),
    ])
    expect(merged.output).toEqual(['only-good'])
    expect(merged.successCount).toBe(1)
    expect(merged.timeoutCount).toBe(2)
  })

  it('preserves agent order in agentResults', () => {
    const inputs = [success('z', 'z'), success('a', 'a'), success('m', 'm')]
    const merged = strategy.merge(inputs)
    expect(merged.agentResults.map((r) => r.agentId)).toEqual(['z', 'a', 'm'])
  })

  it('reports correct counts for mixed scenario', () => {
    const merged = strategy.merge([
      success('a', 'ok'),
      timeout('b'),
      error('c'),
      success('d', 'ok2'),
      timeout('e'),
    ])
    expect(merged.successCount).toBe(2)
    expect(merged.timeoutCount).toBe(2)
    expect(merged.errorCount).toBe(1)
  })
})

// ===========================================================================
// FirstWinsMergeStrategy — extended
// ===========================================================================

describe('FirstWinsMergeStrategy — extended', () => {
  const strategy = new FirstWinsMergeStrategy<string>()

  it('handles a single successful result', () => {
    const merged = strategy.merge([success('a', 'only')])
    expect(merged.status).toBe('success')
    expect(merged.output).toBe('only')
  })

  it('handles empty input — all_timeout by convention', () => {
    const merged = strategy.merge([])
    expect(merged.status).toBe('all_timeout')
    expect(merged.output).toBeUndefined()
  })

  it('skips errors to find first success', () => {
    const merged = strategy.merge([
      error('a'),
      error('b'),
      success('c', 'found-it'),
      success('d', 'ignored'),
    ])
    expect(merged.status).toBe('success')
    expect(merged.output).toBe('found-it')
  })

  it('skips timeouts to find first success', () => {
    const merged = strategy.merge([
      timeout('a'),
      timeout('b'),
      success('c', 'winner'),
    ])
    expect(merged.status).toBe('success')
    expect(merged.output).toBe('winner')
  })

  it('returns all_failed when only errors (no timeouts)', () => {
    const merged = strategy.merge([error('a')])
    expect(merged.status).toBe('all_failed')
  })

  it('preserves full count even though only first success is used', () => {
    const merged = strategy.merge([
      success('a', 'first'),
      success('b', 'second'),
      success('c', 'third'),
    ])
    expect(merged.output).toBe('first')
    expect(merged.successCount).toBe(3)
  })

  it('preserves error messages in agentResults', () => {
    const merged = strategy.merge([error('a', 'specific error msg')])
    expect(merged.agentResults[0]!.error).toBe('specific error msg')
  })
})

// ===========================================================================
// Type discrimination between strategies
// ===========================================================================

describe('Type discrimination between strategies', () => {
  const allRequired = new AllRequiredMergeStrategy<string>()
  const usePartial = new UsePartialMergeStrategy<string>()
  const firstWins = new FirstWinsMergeStrategy<string>()

  const mixedResults: AgentResult<string>[] = [
    success('a', 'out-a'),
    error('b'),
    success('c', 'out-c'),
  ]

  it('AllRequired fails if any agent fails', () => {
    const merged = allRequired.merge(mixedResults)
    expect(merged.status).toBe('all_failed')
    expect(merged.output).toBeUndefined()
  })

  it('UsePartial returns partial with successful outputs only', () => {
    const merged = usePartial.merge(mixedResults)
    expect(merged.status).toBe('partial')
    expect(merged.output).toEqual(['out-a', 'out-c'])
  })

  it('FirstWins returns first successful output only', () => {
    const merged = firstWins.merge(mixedResults)
    expect(merged.status).toBe('success')
    expect(merged.output).toBe('out-a')
  })

  it('all strategies agree on all_timeout for only-timeout input', () => {
    const timeouts: AgentResult<string>[] = [timeout('a'), timeout('b')]
    expect(allRequired.merge(timeouts).status).toBe('all_timeout')
    expect(usePartial.merge(timeouts).status).toBe('all_timeout')
    expect(firstWins.merge(timeouts).status).toBe('all_timeout')
  })

  it('all strategies preserve agentResults count', () => {
    for (const strat of [allRequired, usePartial, firstWins]) {
      const merged = strat.merge(mixedResults)
      expect(merged.agentResults).toHaveLength(3)
    }
  })
})

// ===========================================================================
// Simple string-based MergeStrategyFn helpers
// ===========================================================================

describe('concatMerge', () => {
  it('joins results with separator', () => {
    expect(concatMerge(['a', 'b', 'c'])).toBe('a\n\n---\n\nb\n\n---\n\nc')
  })

  it('returns single result as-is', () => {
    expect(concatMerge(['only'])).toBe('only')
  })

  it('handles empty array', () => {
    expect(concatMerge([])).toBe('')
  })
})

describe('voteMerge', () => {
  it('returns the most common result', () => {
    expect(voteMerge(['yes', 'no', 'yes', 'yes'])).toBe('yes')
  })

  it('breaks ties by first occurrence', () => {
    const result = voteMerge(['a', 'b'])
    expect(result).toBe('a')
  })

  it('trims whitespace before comparing', () => {
    expect(voteMerge(['  yes ', 'yes', ' yes'])).toBe('yes')
  })

  it('handles single input', () => {
    expect(voteMerge(['only'])).toBe('only')
  })

  it('handles empty array — returns empty string', () => {
    expect(voteMerge([])).toBe('')
  })
})

describe('numberedMerge', () => {
  it('formats results as numbered list', () => {
    const result = numberedMerge(['alpha', 'beta', 'gamma'])
    expect(result).toBe('1. alpha\n\n2. beta\n\n3. gamma')
  })

  it('handles single item', () => {
    expect(numberedMerge(['solo'])).toBe('1. solo')
  })

  it('handles empty array', () => {
    expect(numberedMerge([])).toBe('')
  })
})

describe('jsonArrayMerge', () => {
  it('serializes results as JSON array', () => {
    const result = jsonArrayMerge(['a', 'b'])
    const parsed = JSON.parse(result)
    expect(parsed).toEqual(['a', 'b'])
  })

  it('handles empty array', () => {
    const result = jsonArrayMerge([])
    expect(JSON.parse(result)).toEqual([])
  })

  it('handles results with special characters', () => {
    const result = jsonArrayMerge(['has "quotes"', 'has\nnewlines'])
    const parsed = JSON.parse(result)
    expect(parsed).toEqual(['has "quotes"', 'has\nnewlines'])
  })
})

describe('getMergeStrategy', () => {
  it('returns concat strategy by name', () => {
    const fn = getMergeStrategy('concat')
    expect(fn(['a', 'b'])).toBe(concatMerge(['a', 'b']))
  })

  it('returns vote strategy by name', () => {
    const fn = getMergeStrategy('vote')
    expect(fn).toBe(voteMerge)
  })

  it('returns numbered strategy by name', () => {
    const fn = getMergeStrategy('numbered')
    expect(fn).toBe(numberedMerge)
  })

  it('returns json strategy by name', () => {
    const fn = getMergeStrategy('json')
    expect(fn).toBe(jsonArrayMerge)
  })

  it('throws for unknown strategy name', () => {
    expect(() => getMergeStrategy('nonexistent')).toThrow('Unknown merge strategy')
  })

  it('lists known strategies in error message', () => {
    try {
      getMergeStrategy('bad')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('concat')
      expect(msg).toContain('vote')
      expect(msg).toContain('numbered')
      expect(msg).toContain('json')
    }
  })
})

// ===========================================================================
// assertDepthAllowed (delegating-supervisor edge cases)
// ===========================================================================

describe('assertDepthAllowed', () => {
  it('does not throw when depth is below default max', () => {
    expect(() => assertDepthAllowed(0)).not.toThrow()
    expect(() => assertDepthAllowed(1)).not.toThrow()
    expect(() => assertDepthAllowed(2)).not.toThrow()
  })

  it('throws when depth equals default max', () => {
    expect(() => assertDepthAllowed(MAX_ORCHESTRATION_DEPTH)).toThrow(
      /depth limit reached/i,
    )
  })

  it('throws when depth exceeds default max', () => {
    expect(() => assertDepthAllowed(MAX_ORCHESTRATION_DEPTH + 1)).toThrow(
      /depth limit reached/i,
    )
  })

  it('respects custom max parameter', () => {
    expect(() => assertDepthAllowed(1, 2)).not.toThrow()
    expect(() => assertDepthAllowed(2, 2)).toThrow()
    expect(() => assertDepthAllowed(0, 1)).not.toThrow()
    expect(() => assertDepthAllowed(1, 1)).toThrow()
  })

  it('includes depth and max values in error message', () => {
    try {
      assertDepthAllowed(5, 3)
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('5')
      expect(msg).toContain('3')
    }
  })
})
