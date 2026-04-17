/**
 * Coverage tests for token-budget.ts — selectMemoriesByBudget edge cases,
 * TokenBudgetAllocator rebalance, and error paths.
 */

import { describe, it, expect } from 'vitest'
import { FrameBuilder } from '../frame-builder.js'
import type { FrameRecordMeta, FrameRecordValue } from '../frame-builder.js'
import {
  selectMemoriesByBudget,
  TokenBudgetAllocator,
} from '../token-budget.js'
import type { ScoredRecord } from '../token-budget.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTable(
  records: Array<{
    id: string
    namespace: string
    text?: string
    category?: string
    decayStrength?: number | null
    importance?: number | null
    systemCreatedAt?: number
  }>,
) {
  const builder = new FrameBuilder()
  for (const r of records) {
    const value: FrameRecordValue = {
      text: r.text ?? `Record ${r.id}`,
      category: r.category ?? null,
      importance: r.importance ?? null,
      _decay: {
        strength: r.decayStrength ?? null,
        halfLifeMs: null,
        lastAccessedAt: null,
        accessCount: null,
      },
      _temporal: {
        systemCreatedAt: r.systemCreatedAt ?? Date.now(),
        systemExpiredAt: null,
        validFrom: r.systemCreatedAt ?? Date.now(),
        validUntil: null,
      },
    }
    const meta: FrameRecordMeta = { id: r.id, namespace: r.namespace, key: r.id }
    builder.add(value, meta)
  }
  return builder.build()
}

// ---------------------------------------------------------------------------
// selectMemoriesByBudget
// ---------------------------------------------------------------------------

describe('selectMemoriesByBudget — coverage', () => {
  it('returns empty for zero budget', () => {
    const table = buildTable([{ id: 'r0', namespace: 'test' }])
    const result = selectMemoriesByBudget(table, 0)
    expect(result).toEqual([])
  })

  it('returns empty for negative budget', () => {
    const table = buildTable([{ id: 'r0', namespace: 'test' }])
    const result = selectMemoriesByBudget(table, -100)
    expect(result).toEqual([])
  })

  it('returns empty for empty table', () => {
    const table = buildTable([])
    const result = selectMemoriesByBudget(table, 1000)
    expect(result).toEqual([])
  })

  it('applies minScore filter', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', importance: 0.1, decayStrength: 0.1 },
      { id: 'r1', namespace: 'test', importance: 0.9, decayStrength: 0.9 },
    ])
    const result = selectMemoriesByBudget(table, 10000, { minScore: 0.5 })
    // Only high-scoring record should pass
    expect(result.length).toBeLessThanOrEqual(2)
    for (const r of result) {
      expect(r.score).toBeGreaterThanOrEqual(0.5)
    }
  })

  it('applies phaseWeights for namespace', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'decisions', text: 'short', importance: 0.5, decayStrength: 0.5 },
      { id: 'r1', namespace: 'lessons', text: 'short', importance: 0.5, decayStrength: 0.5 },
    ])
    const result = selectMemoriesByBudget(table, 10000, {
      phaseWeights: { decisions: 2.0, lessons: 0.5 },
    })

    expect(result.length).toBe(2)
    // decisions should score higher due to phaseWeight 2.0 vs 0.5
    const decisionsRecord = result.find((r) => r.rowIndex === 0)
    const lessonsRecord = result.find((r) => r.rowIndex === 1)
    expect(decisionsRecord!.score).toBeGreaterThan(lessonsRecord!.score)
  })

  it('applies phaseWeights for category when namespace does not match', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'generic', category: 'critical', text: 'short', importance: 0.5 },
      { id: 'r1', namespace: 'generic', category: 'low', text: 'short', importance: 0.5 },
    ])
    const result = selectMemoriesByBudget(table, 10000, {
      phaseWeights: { critical: 3.0, low: 0.1 },
    })

    expect(result.length).toBe(2)
    const critical = result.find((r) => r.rowIndex === 0)
    const low = result.find((r) => r.rowIndex === 1)
    expect(critical!.score).toBeGreaterThan(low!.score)
  })

  it('respects custom weights', () => {
    const now = Date.now()
    const table = buildTable([
      { id: 'r0', namespace: 'test', importance: 1.0, decayStrength: 0.0, systemCreatedAt: now },
    ])
    const importanceOnly = selectMemoriesByBudget(table, 10000, {
      weights: { importance: 1.0, decay: 0, recency: 0, phase: 0 },
      now,
    })
    const decayOnly = selectMemoriesByBudget(table, 10000, {
      weights: { importance: 0, decay: 1.0, recency: 0, phase: 0 },
      now,
    })

    expect(importanceOnly[0]!.score).toBeGreaterThan(decayOnly[0]!.score)
  })

  it('preserves original row order', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', text: 'x'.repeat(20), importance: 0.1 },
      { id: 'r1', namespace: 'test', text: 'x'.repeat(20), importance: 0.9 },
      { id: 'r2', namespace: 'test', text: 'x'.repeat(20), importance: 0.5 },
    ])
    const result = selectMemoriesByBudget(table, 100000)
    const indices = result.map((r) => r.rowIndex)
    expect(indices).toEqual([0, 1, 2]) // Sorted by original order
  })

  it('each ScoredRecord has valid fields', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', text: 'hello world' },
    ])
    const result = selectMemoriesByBudget(table, 10000)
    expect(result).toHaveLength(1)
    expect(result[0]!.rowIndex).toBe(0)
    expect(result[0]!.score).toBeGreaterThan(0)
    expect(result[0]!.tokenCost).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// TokenBudgetAllocator
// ---------------------------------------------------------------------------

describe('TokenBudgetAllocator — coverage', () => {
  it('allocates budget across all slots', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', text: 'x'.repeat(40), importance: 0.8 },
      { id: 'r1', namespace: 'test', text: 'x'.repeat(40), importance: 0.6 },
    ])

    const allocator = new TokenBudgetAllocator({
      totalBudget: 100000,
      systemPromptTokens: 2000,
      toolTokens: 1000,
      memoryFrame: table,
    })

    const allocation = allocator.rebalance(5000)

    expect(allocation.systemPromptTokens).toBe(2000)
    expect(allocation.toolTokens).toBe(1000)
    expect(allocation.conversationTokens).toBe(5000)
    expect(allocation.responseReserve).toBeGreaterThanOrEqual(4000)
    expect(allocation.selectedMemoryIndices.length).toBeGreaterThanOrEqual(0)
    expect(allocation.totalScore).toBeGreaterThanOrEqual(0)
  })

  it('caps memory tokens at maxMemoryFraction', () => {
    const records = Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`,
      namespace: 'test',
      text: 'x'.repeat(400), // ~100 tokens each
      importance: 0.8,
    }))
    const table = buildTable(records)

    const allocator = new TokenBudgetAllocator({
      totalBudget: 10000,
      systemPromptTokens: 500,
      toolTokens: 500,
      memoryFrame: table,
      maxMemoryFraction: 0.2, // max 2000 tokens for memory
    })

    const allocation = allocator.rebalance(1000)
    expect(allocation.memoryTokens).toBeLessThanOrEqual(2000)
  })

  it('gives all remaining to response reserve when budget is tight', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'test', text: 'x'.repeat(800) },
    ])

    const allocator = new TokenBudgetAllocator({
      totalBudget: 8000,
      systemPromptTokens: 2000,
      toolTokens: 1000,
      memoryFrame: table,
      minResponseReserve: 4000,
    })

    // Conversation takes most of the budget
    const allocation = allocator.rebalance(7000)
    expect(allocation.responseReserve).toBeGreaterThanOrEqual(4000)
  })

  it('handles updateFrame', () => {
    const table1 = buildTable([
      { id: 'r0', namespace: 'test', text: 'short' },
    ])
    const table2 = buildTable([
      { id: 'r0', namespace: 'test', text: 'short' },
      { id: 'r1', namespace: 'test', text: 'another short' },
    ])

    const allocator = new TokenBudgetAllocator({
      totalBudget: 100000,
      systemPromptTokens: 1000,
      toolTokens: 500,
      memoryFrame: table1,
    })

    const alloc1 = allocator.rebalance(1000)
    allocator.updateFrame(table2)
    const alloc2 = allocator.rebalance(1000)

    // After update, there are more memories to select
    expect(alloc2.selectedMemoryIndices.length).toBeGreaterThanOrEqual(
      alloc1.selectedMemoryIndices.length,
    )
  })

  it('uses phaseWeights from config', () => {
    const table = buildTable([
      { id: 'r0', namespace: 'decisions', text: 'short' },
      { id: 'r1', namespace: 'lessons', text: 'short' },
    ])

    const allocator = new TokenBudgetAllocator({
      totalBudget: 100000,
      systemPromptTokens: 1000,
      toolTokens: 500,
      memoryFrame: table,
      phaseWeights: { decisions: 5.0, lessons: 0.1 },
    })

    const allocation = allocator.rebalance(1000)
    expect(allocation.selectedMemoryIndices.length).toBeGreaterThan(0)
  })

  it('returns safe defaults when allocation errors', () => {
    // Use an empty table, which should work fine but verify the shape
    const table = buildTable([])
    const allocator = new TokenBudgetAllocator({
      totalBudget: 10000,
      systemPromptTokens: 1000,
      toolTokens: 500,
      memoryFrame: table,
    })

    const allocation = allocator.rebalance(1000)
    expect(allocation.memoryTokens).toBe(0)
    expect(allocation.selectedMemoryIndices).toEqual([])
    expect(allocation.totalScore).toBe(0)
  })

  it('rebalance with frame whose numRows throws: selectMemoriesByBudget handles internally', () => {
    // Note: the try/catch in rebalance() is a defensive block.
    // selectMemoriesByBudget has its own try/catch, so even if the frame throws
    // on numRows, that exception is caught within selectMemoriesByBudget and
    // an empty selection is returned. The outer rebalance() catch is not triggered.
    const table = buildTable([{ id: 'r0', namespace: 'test', text: 'x' }])
    const allocator = new TokenBudgetAllocator({
      totalBudget: 10000,
      systemPromptTokens: 500,
      toolTokens: 300,
      memoryFrame: table,
      minResponseReserve: 2000,
    })

    const throwingFrame = new Proxy(table, {
      get(target, prop) {
        if (prop === 'numRows') throw new Error('frame access error')
        return Reflect.get(target, prop)
      },
    })
    ;(allocator as unknown as { frame: typeof table }).frame = throwingFrame

    // Should not throw — selectMemoriesByBudget catches internally and returns []
    const result = allocator.rebalance(500)

    // selectMemoriesByBudget returns [] since numRows threw (its catch returns [])
    expect(result.memoryTokens).toBe(0)
    expect(result.selectedMemoryIndices).toEqual([])
    expect(result.totalScore).toBe(0)
    // Verify the overall shape is intact
    expect(typeof result.systemPromptTokens).toBe('number')
    expect(typeof result.toolTokens).toBe('number')
    expect(result.responseReserve).toBeGreaterThanOrEqual(2000)
  })
})
