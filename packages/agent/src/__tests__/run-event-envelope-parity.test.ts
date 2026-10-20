/**
 * B-02 (DZA-B02-RUN-EVENT-ENVELOPE-20261021-R1) — one run-event sequence for
 * generate() and stream().
 *
 * Both paths emit tool lifecycle and `llm:invoked` through the shared
 * emitters, which allocate a run-event envelope per emission from the run's
 * sequencer and emit its bus projection. The same scripted run (one tool call,
 * then a final answer) must yield the same envelope kinds and payloads in
 * both modes, numbered 1..n with unique event ids.
 */

import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { createEventBus, type DzupEvent } from '@dzupagent/core'
import type { AgentRunEventEnvelope } from '@dzupagent/agent-types/run'
import { DzupAgent } from '../agent/dzip-agent.js'
import {
  RUN_EVENT_ENVELOPE_KEY,
  emitRunEvent,
  envelopeOfBusEvent,
  projectToBus,
  projectToStreamEvent,
} from '../events/projections.js'
import { createRunEventSequencer } from '../events/run-event-sequencer.js'

const RUN_ID = 'run-b02'

function scriptedResponses(): AIMessage[] {
  const toolTurn = new AIMessage({
    content: '',
    tool_calls: [{ id: 'tc_1', name: 'search', args: { q: 'x' } }],
  })
  const finalTurn = new AIMessage('done')
  for (const message of [toolTurn, finalTurn]) {
    ;(message as unknown as { usage_metadata: Record<string, number> }).usage_metadata = {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    }
  }
  return [toolTurn, finalTurn]
}

/** A model exposing both `.invoke()` (generate) and `.stream()` (native stream). */
function scriptedModel(): BaseChatModel {
  const responses = scriptedResponses()
  let invokeIdx = 0
  let streamIdx = 0
  const model: Record<string, unknown> = {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => responses[invokeIdx++] ?? responses.at(-1)),
    stream: vi.fn(async function* () {
      yield responses[streamIdx++] ?? responses.at(-1)
    }),
    bindTools: vi.fn().mockReturnThis(),
    model: 'scripted-model',
  }
  return model as unknown as BaseChatModel
}

function searchTool(): StructuredToolInterface {
  return {
    name: 'search',
    description: 'search',
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => 'hits: 42'),
  } as unknown as StructuredToolInterface
}

function agentWithBus(): { agent: DzupAgent; envelopes: AgentRunEventEnvelope[] } {
  const eventBus = createEventBus()
  const envelopes: AgentRunEventEnvelope[] = []
  eventBus.onAny((event) => {
    const envelope = envelopeOfBusEvent(event)
    if (envelope) envelopes.push(envelope)
  })
  const agent = new DzupAgent({
    id: 'b02-agent',
    instructions: 'You are a test agent.',
    model: scriptedModel(),
    tools: [searchTool()],
    eventBus,
    toolExecution: { runId: RUN_ID },
  })
  return { agent, envelopes }
}

/** Kind and payload without the wall-clock fields that differ run to run. */
function comparable(envelope: AgentRunEventEnvelope): unknown {
  const { timestamp: _t, durationMs: _d, ...bus } = (
    envelope.payload as unknown as { bus: Record<string, unknown> }
  ).bus
  return { type: envelope.type, bus }
}

function assertWellFormed(envelopes: AgentRunEventEnvelope[]): void {
  expect(envelopes.map((e) => e.sequence)).toEqual(envelopes.map((_e, i) => i + 1))
  expect(new Set(envelopes.map((e) => e.eventId)).size).toBe(envelopes.length)
  for (const envelope of envelopes) {
    expect(envelope.schema).toBe('dzupagent.run-event/v1')
    expect(envelope.runId).toBe(RUN_ID)
  }
}

describe('run-event envelope parity (B-02)', () => {
  it('generate() and stream() emit the same envelope sequence', async () => {
    const generated = agentWithBus()
    await generated.agent.generate([new HumanMessage('search')], { runId: RUN_ID })

    const streamed = agentWithBus()
    for await (const _event of streamed.agent.stream([new HumanMessage('search')], { runId: RUN_ID })) {
      // drain
    }

    assertWellFormed(generated.envelopes)
    assertWellFormed(streamed.envelopes)
    expect(generated.envelopes.map((e) => e.type)).toEqual([
      'model.completed',
      'tool.started',
      'tool.completed',
      'model.completed',
    ])
    expect(streamed.envelopes.map(comparable)).toEqual(generated.envelopes.map(comparable))
  })
})

describe('run-event projections', () => {
  it('keeps the legacy bus event byte-identical and attaches the envelope out of band', () => {
    const bus = createEventBus()
    const seen: DzupEvent[] = []
    bus.onAny((event) => seen.push(event))
    const legacy = {
      type: 'tool:called' as const,
      toolName: 'search',
      toolCallId: 'tc_1',
      inputMetadataKeys: ['q'],
      runId: 'r-proj',
      executionRunId: 'r-proj',
    }
    const before = JSON.stringify(legacy)

    emitRunEvent(bus, 'r-proj', legacy)
    emitRunEvent(bus, 'r-proj', { ...legacy, toolCallId: 'tc_2' })

    expect(JSON.stringify(seen[0])).toBe(before)
    expect(JSON.stringify({ ...seen[0] })).toBe(before)
    expect(RUN_EVENT_ENVELOPE_KEY).toBe(Symbol.for('dzupagent.run-event/v1'))
    expect(seen.map((e) => envelopeOfBusEvent(e)?.sequence)).toEqual([1, 2])
    const first = envelopeOfBusEvent(seen[0]!)!
    expect(projectToBus(first)).toBe(seen[0])
    expect(projectToStreamEvent(first)).toEqual({
      type: 'tool_call_start',
      toolName: 'search',
      callId: 'tc_1',
    })
  })

  it('emits the legacy event without an envelope when there is no run id', () => {
    const bus = createEventBus()
    const seen: DzupEvent[] = []
    bus.onAny((event) => seen.push(event))
    emitRunEvent(bus, undefined, {
      type: 'tool:called',
      toolName: 'search',
      toolCallId: 'tc_1',
      inputMetadataKeys: [],
    })
    expect(seen).toHaveLength(1)
    expect(envelopeOfBusEvent(seen[0]!)).toBeUndefined()
  })

  it('sequences per run, independently, with the injected clock and ids', () => {
    let id = 0
    const sequencer = createRunEventSequencer('r-seq', {
      attempt: 2,
      now: () => new Date('2026-10-21T00:00:00.000Z'),
      newEventId: () => `e${++id}`,
    })
    const a = sequencer.next('tool.started', null)
    const b = sequencer.next('tool.completed', null, 7)
    expect(a).toEqual({
      schema: 'dzupagent.run-event/v1',
      runId: 'r-seq',
      eventId: 'e1',
      sequence: 1,
      stateRevision: 0,
      attempt: 2,
      occurredAt: '2026-10-21T00:00:00.000Z',
      type: 'tool.started',
      payload: null,
    })
    expect([b.sequence, b.stateRevision, b.eventId]).toEqual([2, 7, 'e2'])
  })
})
