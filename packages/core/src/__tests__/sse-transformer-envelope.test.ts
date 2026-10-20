/**
 * B-02 (DZA-B02-RUN-EVENT-ENVELOPE-20261021-R1) — SSE envelope projection.
 *
 * The legacy `transform()` frames stay byte-identical for the five built-in
 * kinds, and `fromEnvelope()` frames carry the envelope's `sequence`.
 */
import { describe, it, expect } from 'vitest'
import type { StreamEvent } from '@langchain/core/tracers/log_stream'
import type { AgentRunEventEnvelope } from '@dzupagent/agent-types/run'
import { SSETransformer } from '../streaming/sse-transformer.js'

function lgEvent(event: string, extra: Partial<StreamEvent> = {}): StreamEvent {
  return { event, name: 'node', run_id: 'r', tags: [], metadata: {}, data: {}, ...extra } as StreamEvent
}

function envelope(
  type: AgentRunEventEnvelope['type'],
  sequence: number,
  payload: AgentRunEventEnvelope['payload'],
): AgentRunEventEnvelope {
  return {
    schema: 'dzupagent.run-event/v1',
    runId: 'r1',
    eventId: `evt-${sequence}`,
    sequence,
    stateRevision: 0,
    attempt: 1,
    occurredAt: '2026-10-21T00:00:00.000Z',
    type,
    payload,
  }
}

describe('SSETransformer legacy frames (byte-identical)', () => {
  const t = new SSETransformer()
  const cases: Array<[string, StreamEvent, string]> = [
    [
      'message',
      lgEvent('on_chat_model_stream', { data: { chunk: { content: 'hi' } } }),
      '{"type":"message","data":{"content":"hi"}}',
    ],
    [
      'tool_call',
      lgEvent('on_chat_model_end', {
        data: { output: { tool_calls: [{ name: 'search', args: { q: 'x' } }] } },
      }),
      '{"type":"tool_call","data":{"tools":[{"name":"search","args":{"q":"x"}}]}}',
    ],
    [
      'progress',
      lgEvent('on_tool_start', { name: 'search' }),
      '{"type":"progress","data":{"status":"running","tool":"search"}}',
    ],
    [
      'tool_result',
      lgEvent('on_tool_end', { data: { output: 'found' } }),
      '{"type":"tool_result","data":{"content":"found"}}',
    ],
    [
      'phase_change',
      lgEvent('on_chain_end', { name: 'plan' }),
      '{"type":"phase_change","data":{"phase":"plan"}}',
    ],
  ]

  it.each(cases)('%s frame is unchanged', (_kind, event, expected) => {
    expect(JSON.stringify(t.transform(event))).toBe(expected)
  })
})

describe('SSETransformer.fromEnvelope', () => {
  const t = new SSETransformer()

  it('keeps the legacy progress frame for tool.started and adds sequence', () => {
    const frame = t.fromEnvelope(
      envelope('tool.started', 3, { bus: { type: 'tool:called', toolName: 'search' } }),
    )
    expect(JSON.stringify(frame)).toBe(
      '{"type":"progress","data":{"status":"running","tool":"search","sequence":3}}',
    )
    const legacy = t.transform(lgEvent('on_tool_start', { name: 'search' }))
    const { sequence: _sequence, ...rest } = frame.data
    expect(JSON.stringify({ type: frame.type, data: rest })).toBe(JSON.stringify(legacy))
  })

  it('frames other kinds with sequence, eventId and payload', () => {
    const payload = { bus: { type: 'tool:result', toolName: 'search', status: 'success' } }
    expect(t.fromEnvelope(envelope('tool.completed', 4, payload))).toEqual({
      type: 'tool.completed',
      data: { sequence: 4, eventId: 'evt-4', payload },
    })
  })
})
