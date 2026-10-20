/**
 * B-02 (DZA-B02-RUN-EVENT-ENVELOPE-20261021-R1) — WS schema negotiation.
 *
 * `@dzupagent/agent` attaches the run-event envelope to the bus event it
 * projects under the non-enumerable key `Symbol.for('dzupagent.run-event/v1')`.
 * A client whose filter sets `schema: 'dzupagent.run-event/v1'` receives that
 * envelope; every other client receives the unchanged legacy frame.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus, type DzupEvent, type DzupEventBus } from '@dzupagent/core'
import { EventBridge, type WSClient } from '../event-bridge.js'

const SCHEMA = 'dzupagent.run-event/v1'

function createMockClient(): WSClient & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 }
}

async function flush(): Promise<void> {
  await Promise.resolve()
}

function envelopedToolCalled(sequence: number): { event: DzupEvent; envelope: Record<string, unknown> } {
  const event: DzupEvent = {
    type: 'tool:called',
    toolName: 'search',
    toolCallId: `call-${sequence}`,
    inputMetadataKeys: ['q'],
    runId: 'r1',
    executionRunId: 'r1',
  }
  const envelope = {
    schema: SCHEMA,
    runId: 'r1',
    eventId: `evt-${sequence}`,
    sequence,
    stateRevision: 0,
    attempt: 1,
    occurredAt: '2026-10-21T00:00:00.000Z',
    type: 'tool.started',
    payload: { bus: event },
  }
  Object.defineProperty(event, Symbol.for(SCHEMA), { value: envelope, enumerable: false })
  return { event, envelope }
}

describe('EventBridge run-event envelope negotiation', () => {
  let bus: DzupEventBus
  let bridge: EventBridge

  beforeEach(() => {
    bus = createEventBus()
    bridge = new EventBridge(bus)
  })

  it('sends the envelope to a client that negotiated the schema', async () => {
    const ws = createMockClient()
    bridge.addClient(ws, { runId: 'r1', schema: SCHEMA })

    const { event, envelope } = envelopedToolCalled(1)
    bus.emit(event)
    await flush()

    expect(ws.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(ws.send.mock.calls[0]?.[0] as string)).toEqual(JSON.parse(JSON.stringify(envelope)))
  })

  it('sends the legacy frame, without envelope fields, to a client that did not negotiate', async () => {
    const legacy = createMockClient()
    const negotiated = createMockClient()
    bridge.addClient(legacy, { runId: 'r1' })
    bridge.addClient(negotiated, { runId: 'r1', schema: SCHEMA })

    const { event } = envelopedToolCalled(2)
    bus.emit(event)
    await flush()

    const frame = JSON.parse(legacy.send.mock.calls[0]?.[0] as string) as Record<string, unknown>
    expect(frame['type']).toBe('tool:called')
    expect(frame['version']).toBe('v1')
    expect(frame['payload']).toEqual({
      type: 'tool:called',
      toolName: 'search',
      toolCallId: 'call-2',
      inputMetadataKeys: ['q'],
      runId: 'r1',
      executionRunId: 'r1',
    })
    expect(frame).not.toHaveProperty('sequence')
    expect(JSON.parse(negotiated.send.mock.calls[0]?.[0] as string)).toMatchObject({ sequence: 2, type: 'tool.started' })
  })

  it('falls back to the legacy frame for events that carry no envelope', async () => {
    const ws = createMockClient()
    bridge.addClient(ws, { schema: SCHEMA })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await flush()

    const frame = JSON.parse(ws.send.mock.calls[0]?.[0] as string) as Record<string, unknown>
    expect(frame['type']).toBe('agent:started')
    expect(frame['version']).toBe('v1')
  })
})
