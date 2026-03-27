import { describe, it, expect } from 'vitest'
import { FrameBuilder } from '../frame-builder.js'
import type { FrameRecordMeta, FrameRecordValue } from '../frame-builder.js'
import {
  selectMemoriesByBudget,
  TokenBudgetAllocator,
} from '../token-budget.js'

function buildTable(
  records: Array<{
    id: string
    namespace: string
    text?: string
    decayStrength?: number | null
    importance?: number | null
    systemCreatedAt?: number
    category?: string | null
  }>,
) {
  const builder = new FrameBuilder()
  for (const r of records) {
    const value: FrameRecordValue = {
      text: r.text ?? `Record ${r.id}`,
      importance: r.importance ?? null,
      category: r.category ?? null,
      _decay: {
        strength: r.decayStrength ?? null,
      },
      _temporal: {
        systemCreatedAt: r.systemCreatedAt ?? Date.now(),
      },
    }
    const meta: FrameRecordMeta = { id: r.id, namespace: r.namespace, key: r.id }
    builder.add(value, meta)
  }
  return builder.build()
}

describe('selectMemoriesByBudget', () => {
  it('selects records fitting within token budget (50 records, budget=5000)', () => {
    const now = Date.now()
    const records = Array.from({ length: 50 }, (_, i) => ({
      id: `r${i}`,
      namespace: 'test',
      text: 'x'.repeat(800), // ~200 tokens each at 4 chars/token
      importance: (i + 1) * 0.02,
      decayStrength: 0.9,
      systemCreatedAt: now - i * 60000,
    }))
    const table = buildTable(records)

    const selected = selectMemoriesByBudget(table, 5000, { now })

    // Total tokens selected must not exceed budget
    const totalTokens = selected.reduce((sum, r) => sum + r.tokenCost, 0)
    expect(totalTokens).toBeLessThanOrEqual(5000)
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThan(50) // Can't fit all 50
  })

  it('prefers high-importance records', () => {
    const now = Date.now()
    const records = [
      { id: 'low', namespace: 'test', text: 'x'.repeat(100), importance: 0.1, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'high', namespace: 'test', text: 'x'.repeat(100), importance: 0.9, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildTable(records)

    // Budget only fits one record (~25 tokens each)
    const selected = selectMemoriesByBudget(table, 26, { now })

    expect(selected.length).toBe(1)
    // Should pick the high-importance record
    expect(selected[0]?.rowIndex).toBe(1) // 'high' is at index 1
  })

  it('returns empty for empty table', () => {
    const table = buildTable([])
    const selected = selectMemoriesByBudget(table, 5000)
    expect(selected).toEqual([])
  })

  it('returns empty for zero budget', () => {
    const table = buildTable([{ id: 'r0', namespace: 'test' }])
    const selected = selectMemoriesByBudget(table, 0)
    expect(selected).toEqual([])
  })

  it('respects minScore filter', () => {
    const now = Date.now()
    const records = [
      { id: 'r0', namespace: 'test', text: 'short', importance: 0.01, decayStrength: 0.01, systemCreatedAt: now - 3600000 * 1000 },
      { id: 'r1', namespace: 'test', text: 'short', importance: 0.9, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildTable(records)

    const selected = selectMemoriesByBudget(table, 10000, { now, minScore: 0.5 })
    // Only the high-scoring record should pass
    expect(selected.length).toBe(1)
    expect(selected[0]?.rowIndex).toBe(1)
  })
})

describe('TokenBudgetAllocator', () => {
  it('rebalances: conversation grows, memory budget shrinks', () => {
    const now = Date.now()
    const records = Array.from({ length: 20 }, (_, i) => ({
      id: `r${i}`,
      namespace: 'test',
      text: 'x'.repeat(40), // ~10 tokens each
      importance: 0.5,
      decayStrength: 1.0,
      systemCreatedAt: now,
    }))
    const table = buildTable(records)

    const allocator = new TokenBudgetAllocator({
      totalBudget: 8000,
      systemPromptTokens: 500,
      toolTokens: 500,
      memoryFrame: table,
      maxMemoryFraction: 0.3,
      minResponseReserve: 1000,
    })

    // Small conversation: more room for memory
    const small = allocator.rebalance(1000)
    // Large conversation: less room for memory
    const large = allocator.rebalance(5000)

    expect(small.memoryTokens).toBeGreaterThanOrEqual(large.memoryTokens)
    expect(small.conversationTokens).toBeLessThan(large.conversationTokens)

    // Fixed costs stay the same
    expect(small.systemPromptTokens).toBe(500)
    expect(small.toolTokens).toBe(500)
    expect(large.systemPromptTokens).toBe(500)
    expect(large.toolTokens).toBe(500)

    // Response reserve is at least the minimum
    expect(small.responseReserve).toBeGreaterThanOrEqual(1000)
    expect(large.responseReserve).toBeGreaterThanOrEqual(1000)
  })

  it('handles empty memory frame', () => {
    const table = buildTable([])

    const allocator = new TokenBudgetAllocator({
      totalBudget: 8000,
      systemPromptTokens: 500,
      toolTokens: 500,
      memoryFrame: table,
    })

    const result = allocator.rebalance(2000)
    expect(result.memoryTokens).toBe(0)
    expect(result.selectedMemoryIndices).toEqual([])
    expect(result.conversationTokens).toBe(2000)
  })

  it('updateFrame replaces the memory frame', () => {
    const table1 = buildTable([
      { id: 'r0', namespace: 'test', text: 'x'.repeat(40) },
    ])
    const table2 = buildTable([
      { id: 'r0', namespace: 'test', text: 'x'.repeat(40) },
      { id: 'r1', namespace: 'test', text: 'x'.repeat(40) },
      { id: 'r2', namespace: 'test', text: 'x'.repeat(40) },
    ])

    const allocator = new TokenBudgetAllocator({
      totalBudget: 8000,
      systemPromptTokens: 500,
      toolTokens: 500,
      memoryFrame: table1,
    })

    const before = allocator.rebalance(1000)
    allocator.updateFrame(table2)
    const after = allocator.rebalance(1000)

    // After updating with more records, more may be selected
    expect(after.selectedMemoryIndices.length).toBeGreaterThanOrEqual(
      before.selectedMemoryIndices.length,
    )
  })
})
