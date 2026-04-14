import { describe, expect, it } from 'vitest'
import { requireTerminalToolExecutionRunId } from '../events/tool-event-correlation.js'

describe('requireTerminalToolExecutionRunId', () => {
  it('returns direct executionRunId when provided', () => {
    const runId = requireTerminalToolExecutionRunId({
      eventType: 'tool:result',
      toolName: 'read_file',
      executionRunId: 'run-123',
      fallbackExecutionRunId: 'run-fallback',
    })

    expect(runId).toBe('run-123')
  })

  it('uses fallbackExecutionRunId when direct value is missing', () => {
    const runId = requireTerminalToolExecutionRunId({
      eventType: 'tool:error',
      toolName: 'write_file',
      fallbackExecutionRunId: 'run-fallback',
    })

    expect(runId).toBe('run-fallback')
  })

  it('trims whitespace-only values and throws when both are empty', () => {
    expect(() =>
      requireTerminalToolExecutionRunId({
        eventType: 'tool:result',
        toolName: 'search',
        executionRunId: '   ',
        fallbackExecutionRunId: '\n\t',
      }),
    ).toThrow('Missing executionRunId for tool:result (search).')
  })
})
