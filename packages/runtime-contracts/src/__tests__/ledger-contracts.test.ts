import { describe, expect, it } from 'vitest'
import type {
  Artifact,
  CostLedgerEntry,
} from '../index.js'

describe('runtime-contracts ledger seam', () => {
  it('keeps cost-ledger records constructable', () => {
    const ledger: CostLedgerEntry = {
      id: 'c-1',
      executionRunId: 'r-1',
      providerId: 'openai',
      model: 'gpt-test',
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 0,
      costCents: 12,
      currency: 'USD',
      budgetBucket: 'task',
      recordedAt: Date.now(),
    }

    expect(ledger.budgetBucket).toBe('task')
    expect(ledger.costCents).toBe(12)
  })

  it('keeps artifact persistence shapes constructable', () => {
    const artifact: Artifact = {
      id: 'a-1',
      executionRunId: 'r-1',
      type: 'report',
      name: 'summary.md',
      content: '# Summary',
      sizeBytes: 9,
      createdAt: Date.now(),
    }

    expect(artifact.type).toBe('report')
    expect(artifact.name).toBe('summary.md')
  })
})
