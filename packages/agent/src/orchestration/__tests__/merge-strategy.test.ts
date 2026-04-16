import { describe, it, expect } from 'vitest'
import { AllRequiredMergeStrategy } from '../merge/all-required.js'
import { UsePartialMergeStrategy } from '../merge/use-partial.js'
import { FirstWinsMergeStrategy } from '../merge/first-wins.js'
import type { AgentResult } from '../orchestration-merge-strategy-types.js'

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function success(agentId: string, output: string): AgentResult<string> {
  return { agentId, status: 'success', output }
}

function timeout(agentId: string): AgentResult<string> {
  return { agentId, status: 'timeout', error: 'timed out' }
}

function error(agentId: string): AgentResult<string> {
  return { agentId, status: 'error', error: 'agent crashed' }
}

// ---------------------------------------------------------------------------
// AllRequiredMergeStrategy
// ---------------------------------------------------------------------------

describe('AllRequiredMergeStrategy', () => {
  const strategy = new AllRequiredMergeStrategy<string>()

  it('all success returns status success with output array', () => {
    const results = [success('a', 'out-a'), success('b', 'out-b')]
    const merged = strategy.merge(results)
    expect(merged.status).toBe('success')
    expect(merged.output).toEqual(['out-a', 'out-b'])
    expect(merged.successCount).toBe(2)
    expect(merged.timeoutCount).toBe(0)
    expect(merged.errorCount).toBe(0)
  })

  it('one timeout returns all_failed', () => {
    const results = [success('a', 'out-a'), timeout('b')]
    const merged = strategy.merge(results)
    expect(merged.status).toBe('all_failed')
    expect(merged.output).toBeUndefined()
    expect(merged.timeoutCount).toBe(1)
  })

  it('all timeout returns all_timeout', () => {
    const results = [timeout('a'), timeout('b')]
    const merged = strategy.merge(results)
    expect(merged.status).toBe('all_timeout')
  })

  it('one error returns all_failed', () => {
    const results = [success('a', 'out-a'), error('b')]
    const merged = strategy.merge(results)
    expect(merged.status).toBe('all_failed')
    expect(merged.errorCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// UsePartialMergeStrategy
// ---------------------------------------------------------------------------

describe('UsePartialMergeStrategy', () => {
  const strategy = new UsePartialMergeStrategy<string>()

  it('some success + some timeout returns partial with only successful outputs', () => {
    const results = [success('a', 'out-a'), timeout('b'), success('c', 'out-c')]
    const merged = strategy.merge(results)
    expect(merged.status).toBe('partial')
    expect(merged.output).toEqual(['out-a', 'out-c'])
    expect(merged.successCount).toBe(2)
    expect(merged.timeoutCount).toBe(1)
  })

  it('all success returns partial status (by design)', () => {
    const results = [success('a', 'out-a'), success('b', 'out-b')]
    const merged = strategy.merge(results)
    expect(merged.status).toBe('partial')
    expect(merged.output).toEqual(['out-a', 'out-b'])
  })

  it('all timeout returns all_timeout', () => {
    const results = [timeout('a'), timeout('b')]
    const merged = strategy.merge(results)
    expect(merged.status).toBe('all_timeout')
    expect(merged.output).toBeUndefined()
  })

  it('all error returns all_failed', () => {
    const results = [error('a'), error('b')]
    const merged = strategy.merge(results)
    expect(merged.status).toBe('all_failed')
  })
})

// ---------------------------------------------------------------------------
// FirstWinsMergeStrategy
// ---------------------------------------------------------------------------

describe('FirstWinsMergeStrategy', () => {
  const strategy = new FirstWinsMergeStrategy<string>()

  it('returns first success', () => {
    const results = [success('a', 'out-a'), success('b', 'out-b')]
    const merged = strategy.merge(results)
    expect(merged.status).toBe('success')
    expect(merged.output).toBe('out-a')
  })

  it('returns second result when first times out', () => {
    const results = [timeout('a'), success('b', 'out-b')]
    const merged = strategy.merge(results)
    expect(merged.status).toBe('success')
    expect(merged.output).toBe('out-b')
  })

  it('all fail returns all_failed', () => {
    const results = [error('a'), error('b')]
    const merged = strategy.merge(results)
    expect(merged.status).toBe('all_failed')
    expect(merged.output).toBeUndefined()
  })

  it('all timeout returns all_timeout', () => {
    const results = [timeout('a'), timeout('b')]
    const merged = strategy.merge(results)
    expect(merged.status).toBe('all_timeout')
  })
})
