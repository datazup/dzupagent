import { describe, it, expect, vi } from 'vitest'
import {
  reportRetrievalFeedback,
  mapScoreToQuality,
  type RetrievalFeedbackSink,
  type RetrievalFeedbackHookConfig,
} from '../runtime/retrieval-feedback-hook.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSink(): RetrievalFeedbackSink & { calls: Array<{ query: string; intent: string; quality: 'good' | 'bad' | 'mixed' }> } {
  const calls: Array<{ query: string; intent: string; quality: 'good' | 'bad' | 'mixed' }> = []
  return {
    calls,
    reportFeedback(query, intent, quality) {
      calls.push({ query, intent, quality })
    },
  }
}

function makeConfig(
  sink: RetrievalFeedbackSink,
  overrides?: Partial<RetrievalFeedbackHookConfig>,
): RetrievalFeedbackHookConfig {
  return { sink, ...overrides }
}

// ---------------------------------------------------------------------------
// mapScoreToQuality
// ---------------------------------------------------------------------------

describe('mapScoreToQuality', () => {
  it('maps high score to good', () => {
    expect(mapScoreToQuality(0.85, 0.7, 0.3)).toBe('good')
  })

  it('maps score exactly at good threshold to good', () => {
    expect(mapScoreToQuality(0.7, 0.7, 0.3)).toBe('good')
  })

  it('maps low score to bad', () => {
    expect(mapScoreToQuality(0.1, 0.7, 0.3)).toBe('bad')
  })

  it('maps score exactly at bad threshold to bad', () => {
    expect(mapScoreToQuality(0.3, 0.7, 0.3)).toBe('bad')
  })

  it('maps medium score to mixed', () => {
    expect(mapScoreToQuality(0.5, 0.7, 0.3)).toBe('mixed')
  })

  it('respects custom thresholds', () => {
    expect(mapScoreToQuality(0.85, 0.9, 0.5)).toBe('mixed')
    expect(mapScoreToQuality(0.95, 0.9, 0.5)).toBe('good')
    expect(mapScoreToQuality(0.4, 0.9, 0.5)).toBe('bad')
  })
})

// ---------------------------------------------------------------------------
// reportRetrievalFeedback
// ---------------------------------------------------------------------------

describe('reportRetrievalFeedback', () => {
  it('reports good feedback for high reflection score', () => {
    const sink = createMockSink()
    reportRetrievalFeedback(
      makeConfig(sink),
      { input: { message: 'How do I deploy?' }, intent: 'procedural' },
      { overall: 0.9 },
    )
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]).toEqual({
      query: 'How do I deploy?',
      intent: 'procedural',
      quality: 'good',
    })
  })

  it('reports bad feedback for low reflection score', () => {
    const sink = createMockSink()
    reportRetrievalFeedback(
      makeConfig(sink),
      { input: { message: 'What happened?' }, intent: 'temporal' },
      { overall: 0.2 },
    )
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]!.quality).toBe('bad')
  })

  it('reports mixed feedback for medium reflection score', () => {
    const sink = createMockSink()
    reportRetrievalFeedback(
      makeConfig(sink),
      { input: { message: 'Explain the architecture' }, intent: 'factual' },
      { overall: 0.5 },
    )
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]!.quality).toBe('mixed')
  })

  it('extracts query from metadata.query', () => {
    const sink = createMockSink()
    reportRetrievalFeedback(
      makeConfig(sink),
      { query: 'direct query', intent: 'general' },
      { overall: 0.8 },
    )
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]!.query).toBe('direct query')
  })

  it('extracts query from metadata.input when it is a string', () => {
    const sink = createMockSink()
    reportRetrievalFeedback(
      makeConfig(sink),
      { input: 'string input', intent: 'general' },
      { overall: 0.8 },
    )
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]!.query).toBe('string input')
  })

  it('extracts query from metadata.input.query', () => {
    const sink = createMockSink()
    reportRetrievalFeedback(
      makeConfig(sink),
      { input: { query: 'nested query' }, intent: 'general' },
      { overall: 0.8 },
    )
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]!.query).toBe('nested query')
  })

  it('extracts intent from metadata.routingReason', () => {
    const sink = createMockSink()
    reportRetrievalFeedback(
      makeConfig(sink),
      { query: 'some query', routingReason: 'causal' },
      { overall: 0.8 },
    )
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]!.intent).toBe('causal')
  })

  it('does not report when query is missing', () => {
    const sink = createMockSink()
    reportRetrievalFeedback(
      makeConfig(sink),
      { intent: 'general' },
      { overall: 0.9 },
    )
    expect(sink.calls).toHaveLength(0)
  })

  it('does not report when intent is missing', () => {
    const sink = createMockSink()
    reportRetrievalFeedback(
      makeConfig(sink),
      { query: 'some query' },
      { overall: 0.9 },
    )
    expect(sink.calls).toHaveLength(0)
  })

  it('does not report when both query and intent are missing', () => {
    const sink = createMockSink()
    reportRetrievalFeedback(
      makeConfig(sink),
      {},
      { overall: 0.9 },
    )
    expect(sink.calls).toHaveLength(0)
  })

  it('handles empty string query gracefully', () => {
    const sink = createMockSink()
    reportRetrievalFeedback(
      makeConfig(sink),
      { query: '', intent: 'general' },
      { overall: 0.9 },
    )
    expect(sink.calls).toHaveLength(0)
  })

  it('handles empty string intent gracefully', () => {
    const sink = createMockSink()
    reportRetrievalFeedback(
      makeConfig(sink),
      { query: 'some query', intent: '' },
      { overall: 0.9 },
    )
    expect(sink.calls).toHaveLength(0)
  })

  it('uses custom thresholds', () => {
    const sink = createMockSink()
    const config = makeConfig(sink, { goodThreshold: 0.9, badThreshold: 0.5 })

    // 0.75 would be 'good' with defaults but 'mixed' with custom thresholds
    reportRetrievalFeedback(
      config,
      { query: 'test', intent: 'general' },
      { overall: 0.75 },
    )
    expect(sink.calls[0]!.quality).toBe('mixed')

    // 0.45 would be 'mixed' with defaults but 'bad' with custom thresholds
    reportRetrievalFeedback(
      config,
      { query: 'test', intent: 'general' },
      { overall: 0.45 },
    )
    expect(sink.calls[1]!.quality).toBe('bad')
  })

  it('never throws even if sink.reportFeedback throws', () => {
    const sink: RetrievalFeedbackSink = {
      reportFeedback() {
        throw new Error('boom')
      },
    }
    expect(() =>
      reportRetrievalFeedback(
        makeConfig(sink),
        { query: 'test', intent: 'general' },
        { overall: 0.8 },
      ),
    ).not.toThrow()
  })

  it('never throws with null metadata values', () => {
    const sink = createMockSink()
    expect(() =>
      reportRetrievalFeedback(
        makeConfig(sink),
        { query: null as unknown as string, intent: null as unknown as string },
        { overall: 0.8 },
      ),
    ).not.toThrow()
    expect(sink.calls).toHaveLength(0)
  })
})
