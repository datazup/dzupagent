import { describe, it, expect } from 'vitest'
import type { CodegenStreamEvent } from '../streaming/codegen-stream-event.js'
import { mergeCodegenStreams } from '../streaming/merge-codegen-streams.js'

// --- Helpers ---------------------------------------------------------------

/** Create an async iterable from an array of events with optional delay. */
async function* fromArray(
  events: CodegenStreamEvent[],
  delayMs = 0,
): AsyncGenerator<CodegenStreamEvent> {
  for (const event of events) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    yield event
  }
}

/** Create an async iterable that errors after yielding some events. */
async function* errorAfter(
  events: CodegenStreamEvent[],
  errorMessage: string,
): AsyncGenerator<CodegenStreamEvent> {
  for (const event of events) {
    yield event
  }
  throw new Error(errorMessage)
}

/** Collect all events from an async iterable. */
async function collect(source: AsyncIterable<CodegenStreamEvent>): Promise<CodegenStreamEvent[]> {
  const result: CodegenStreamEvent[] = []
  for await (const event of source) {
    result.push(event)
  }
  return result
}

// ===========================================================================
// CodegenStreamEvent type discrimination
// ===========================================================================

describe('CodegenStreamEvent type discrimination', () => {
  it('file_patch event has filePath and patch', () => {
    const event: CodegenStreamEvent = { type: 'codegen:file_patch', filePath: 'src/foo.ts', patch: '+line' }
    expect(event.type).toBe('codegen:file_patch')
    if (event.type === 'codegen:file_patch') {
      expect(event.filePath).toBe('src/foo.ts')
      expect(event.patch).toBe('+line')
    }
  })

  it('test_result event has passed, output, and optional testFile', () => {
    const event: CodegenStreamEvent = { type: 'codegen:test_result', passed: true, output: 'ok' }
    expect(event.type).toBe('codegen:test_result')
    if (event.type === 'codegen:test_result') {
      expect(event.passed).toBe(true)
      expect(event.output).toBe('ok')
      expect(event.testFile).toBeUndefined()
    }
  })

  it('test_result event can include testFile', () => {
    const event: CodegenStreamEvent = { type: 'codegen:test_result', passed: false, output: 'fail', testFile: 'test.ts' }
    if (event.type === 'codegen:test_result') {
      expect(event.testFile).toBe('test.ts')
    }
  })

  it('pipeline_step event has step and status', () => {
    const event: CodegenStreamEvent = { type: 'codegen:pipeline_step', step: 'lint', status: 'started' }
    if (event.type === 'codegen:pipeline_step') {
      expect(event.step).toBe('lint')
      expect(event.status).toBe('started')
      expect(event.durationMs).toBeUndefined()
    }
  })

  it('pipeline_step event can include durationMs', () => {
    const event: CodegenStreamEvent = { type: 'codegen:pipeline_step', step: 'lint', status: 'completed', durationMs: 120 }
    if (event.type === 'codegen:pipeline_step') {
      expect(event.durationMs).toBe(120)
    }
  })

  it('pipeline_step supports failed status', () => {
    const event: CodegenStreamEvent = { type: 'codegen:pipeline_step', step: 'build', status: 'failed', durationMs: 50 }
    if (event.type === 'codegen:pipeline_step') {
      expect(event.status).toBe('failed')
    }
  })

  it('done event has summary and filesChanged', () => {
    const event: CodegenStreamEvent = { type: 'codegen:done', summary: 'all good', filesChanged: ['a.ts', 'b.ts'] }
    if (event.type === 'codegen:done') {
      expect(event.summary).toBe('all good')
      expect(event.filesChanged).toEqual(['a.ts', 'b.ts'])
    }
  })

  it('error event has message and optional step', () => {
    const event: CodegenStreamEvent = { type: 'codegen:error', message: 'boom' }
    if (event.type === 'codegen:error') {
      expect(event.message).toBe('boom')
      expect(event.step).toBeUndefined()
    }
  })

  it('error event can include step', () => {
    const event: CodegenStreamEvent = { type: 'codegen:error', message: 'boom', step: 'validate' }
    if (event.type === 'codegen:error') {
      expect(event.step).toBe('validate')
    }
  })

  it('switch on type discriminant narrows correctly', () => {
    const events: CodegenStreamEvent[] = [
      { type: 'codegen:file_patch', filePath: 'a.ts', patch: '+x' },
      { type: 'codegen:test_result', passed: true, output: 'ok' },
      { type: 'codegen:pipeline_step', step: 's', status: 'started' },
      { type: 'codegen:done', summary: 'done', filesChanged: [] },
      { type: 'codegen:error', message: 'err' },
    ]

    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'codegen:file_patch',
      'codegen:test_result',
      'codegen:pipeline_step',
      'codegen:done',
      'codegen:error',
    ])
  })
})

// ===========================================================================
// mergeCodegenStreams
// ===========================================================================

describe('mergeCodegenStreams', () => {
  it('yields all events from a single source', async () => {
    const events: CodegenStreamEvent[] = [
      { type: 'codegen:pipeline_step', step: 'gen', status: 'started' },
      { type: 'codegen:file_patch', filePath: 'a.ts', patch: '+line' },
      { type: 'codegen:pipeline_step', step: 'gen', status: 'completed', durationMs: 50 },
    ]
    const result = await collect(mergeCodegenStreams(fromArray(events)))
    expect(result).toHaveLength(3)
    expect(result[0]!.type).toBe('codegen:pipeline_step')
    expect(result[1]!.type).toBe('codegen:file_patch')
    expect(result[2]!.type).toBe('codegen:pipeline_step')
  })

  it('interleaves events from two sources', async () => {
    const source1: CodegenStreamEvent[] = [
      { type: 'codegen:pipeline_step', step: 'a', status: 'started' },
      { type: 'codegen:pipeline_step', step: 'a', status: 'completed' },
    ]
    const source2: CodegenStreamEvent[] = [
      { type: 'codegen:pipeline_step', step: 'b', status: 'started' },
      { type: 'codegen:pipeline_step', step: 'b', status: 'completed' },
    ]
    const result = await collect(mergeCodegenStreams(fromArray(source1), fromArray(source2)))
    expect(result).toHaveLength(4)
    // All events from both sources should be present
    const steps = result
      .filter((e): e is Extract<CodegenStreamEvent, { type: 'codegen:pipeline_step' }> => e.type === 'codegen:pipeline_step')
      .map((e) => e.step)
    expect(steps.filter((s) => s === 'a')).toHaveLength(2)
    expect(steps.filter((s) => s === 'b')).toHaveLength(2)
  })

  it('handles empty source without blocking', async () => {
    const emptySource = fromArray([])
    const events: CodegenStreamEvent[] = [
      { type: 'codegen:done', summary: 'ok', filesChanged: [] },
    ]
    const result = await collect(mergeCodegenStreams(emptySource, fromArray(events)))
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('codegen:done')
  })

  it('handles all empty sources', async () => {
    const result = await collect(mergeCodegenStreams(fromArray([]), fromArray([])))
    expect(result).toHaveLength(0)
  })

  it('handles zero sources', async () => {
    const result = await collect(mergeCodegenStreams())
    expect(result).toHaveLength(0)
  })

  it('continues other sources when one errors', async () => {
    const failingSource = errorAfter(
      [{ type: 'codegen:pipeline_step', step: 'fail', status: 'started' } as CodegenStreamEvent],
      'source failed',
    )
    const healthySource = fromArray([
      { type: 'codegen:pipeline_step', step: 'ok', status: 'started' } as CodegenStreamEvent,
      { type: 'codegen:pipeline_step', step: 'ok', status: 'completed' } as CodegenStreamEvent,
    ])

    const result = await collect(mergeCodegenStreams(failingSource, healthySource))

    // Should have: 1 from failing source + 1 codegen:error + 2 from healthy source
    expect(result.length).toBeGreaterThanOrEqual(3)

    const errorEvents = result.filter((e) => e.type === 'codegen:error')
    expect(errorEvents).toHaveLength(1)
    if (errorEvents[0]!.type === 'codegen:error') {
      expect(errorEvents[0]!.message).toContain('source failed')
    }

    // Healthy source events should all be present
    const okSteps = result.filter(
      (e) => e.type === 'codegen:pipeline_step' && (e as { step: string }).step === 'ok',
    )
    expect(okSteps).toHaveLength(2)
  })

  it('yields error events for non-Error thrown values', async () => {
    async function* throwString(): AsyncGenerator<CodegenStreamEvent> {
      throw 'string-error' // eslint-disable-line no-throw-literal
    }

    const result = await collect(mergeCodegenStreams(throwString()))
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('codegen:error')
    if (result[0]!.type === 'codegen:error') {
      expect(result[0]!.message).toContain('string-error')
    }
  })

  it('preserves event order from a single source', async () => {
    const events: CodegenStreamEvent[] = [
      { type: 'codegen:pipeline_step', step: 'step1', status: 'started' },
      { type: 'codegen:pipeline_step', step: 'step2', status: 'started' },
      { type: 'codegen:pipeline_step', step: 'step3', status: 'started' },
    ]
    const result = await collect(mergeCodegenStreams(fromArray(events)))
    const steps = result
      .filter((e): e is Extract<CodegenStreamEvent, { type: 'codegen:pipeline_step' }> => e.type === 'codegen:pipeline_step')
      .map((e) => e.step)
    expect(steps).toEqual(['step1', 'step2', 'step3'])
  })

  it('handles three sources', async () => {
    const s1 = fromArray([{ type: 'codegen:file_patch', filePath: '1.ts', patch: '+a' } as CodegenStreamEvent])
    const s2 = fromArray([{ type: 'codegen:file_patch', filePath: '2.ts', patch: '+b' } as CodegenStreamEvent])
    const s3 = fromArray([{ type: 'codegen:file_patch', filePath: '3.ts', patch: '+c' } as CodegenStreamEvent])

    const result = await collect(mergeCodegenStreams(s1, s2, s3))
    expect(result).toHaveLength(3)
    const filePaths = result
      .filter((e): e is Extract<CodegenStreamEvent, { type: 'codegen:file_patch' }> => e.type === 'codegen:file_patch')
      .map((e) => e.filePath)
    expect(filePaths.sort()).toEqual(['1.ts', '2.ts', '3.ts'])
  })

  it('done event passes through merge unchanged', async () => {
    const doneEvent: CodegenStreamEvent = {
      type: 'codegen:done',
      summary: 'completed 3 files',
      filesChanged: ['a.ts', 'b.ts', 'c.ts'],
    }
    const result = await collect(mergeCodegenStreams(fromArray([doneEvent])))
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(doneEvent)
  })
})
