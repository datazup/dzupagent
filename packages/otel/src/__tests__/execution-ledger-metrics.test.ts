import { describe, it, expect } from 'vitest'
import { executionLedgerMetricMap } from '../event-metric-map/execution-ledger.js'
import { EVENT_METRIC_MAP } from '../event-metric-map.js'
import type { DzupEvent } from '@dzupagent/core'

function extractFirst(
  mappings: { extract: (e: DzupEvent) => { value: number; labels: Record<string, string> } }[],
  event: DzupEvent,
) {
  return mappings[0]!.extract(event)
}

describe('execution-ledger metric map', () => {
  it('ledger:execution_recorded produces counter with provider_id', () => {
    const mappings = executionLedgerMetricMap['ledger:execution_recorded']
    expect(mappings).toHaveLength(1)
    const result = extractFirst(
      mappings,
      { type: 'ledger:execution_recorded', executionRunId: 'r1', providerId: 'anthropic' } as DzupEvent,
    )
    expect(result.value).toBe(1)
    expect(result.labels.provider_id).toBe('anthropic')
  })

  it('ledger:prompt_recorded produces counter', () => {
    const mappings = executionLedgerMetricMap['ledger:prompt_recorded']
    expect(mappings).toHaveLength(1)
    const result = extractFirst(
      mappings,
      { type: 'ledger:prompt_recorded', promptRecordId: 'p1', executionRunId: 'r1' } as DzupEvent,
    )
    expect(result.value).toBe(1)
  })

  it('ledger:tool_recorded produces counter with tool_name', () => {
    const mappings = executionLedgerMetricMap['ledger:tool_recorded']
    expect(mappings).toHaveLength(1)
    const result = extractFirst(
      mappings,
      { type: 'ledger:tool_recorded', toolInvocationId: 't1', toolName: 'file_read' } as DzupEvent,
    )
    expect(result.labels.tool_name).toBe('file_read')
  })

  it('ledger:cost_recorded produces counter and histogram', () => {
    const mappings = executionLedgerMetricMap['ledger:cost_recorded']
    expect(mappings).toHaveLength(2)

    const counterResult = mappings[0]!.extract(
      { type: 'ledger:cost_recorded', costEntryId: 'c1', costCents: 7 } as DzupEvent,
    )
    expect(counterResult.value).toBe(1)

    const histResult = mappings[1]!.extract(
      { type: 'ledger:cost_recorded', costEntryId: 'c1', costCents: 7 } as DzupEvent,
    )
    expect(histResult.value).toBe(7)
  })

  it('ledger:artifact_recorded produces counter with artifact_type', () => {
    const mappings = executionLedgerMetricMap['ledger:artifact_recorded']
    expect(mappings).toHaveLength(1)
    const result = extractFirst(
      mappings,
      { type: 'ledger:artifact_recorded', artifactId: 'a1', artifactType: 'report' } as DzupEvent,
    )
    expect(result.labels.artifact_type).toBe('report')
  })

  it('ledger:budget_warning produces counter + histograms', () => {
    const mappings = executionLedgerMetricMap['ledger:budget_warning']
    expect(mappings).toHaveLength(3)
    const result = extractFirst(
      mappings,
      { type: 'ledger:budget_warning', workflowRunId: 'wf-1', usedCents: 80, limitCents: 100, threshold: 0.8 } as DzupEvent,
    )
    expect(result.value).toBe(1)
  })

  it('ledger:budget_exceeded produces counter + histogram', () => {
    const mappings = executionLedgerMetricMap['ledger:budget_exceeded']
    expect(mappings).toHaveLength(2)
    const result = extractFirst(
      mappings,
      { type: 'ledger:budget_exceeded', workflowRunId: 'wf-1', usedCents: 120, limitCents: 100 } as DzupEvent,
    )
    expect(result.value).toBe(1)
  })

  it('all ledger events are in the main EVENT_METRIC_MAP', () => {
    const ledgerTypes = [
      'ledger:execution_recorded',
      'ledger:prompt_recorded',
      'ledger:tool_recorded',
      'ledger:cost_recorded',
      'ledger:artifact_recorded',
      'ledger:budget_warning',
      'ledger:budget_exceeded',
    ] as const

    for (const type of ledgerTypes) {
      expect(EVENT_METRIC_MAP[type]).toBeDefined()
      expect(EVENT_METRIC_MAP[type].length).toBeGreaterThan(0)
    }
  })
})
