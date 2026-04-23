import { describe, it, expect } from 'vitest'
import { createEventBus, type DzupEvent } from '@dzupagent/core'
import { EventBridge, type WSClient } from '../ws/event-bridge.js'
import { createCompileWsHandler } from '../ws/compile-handler.js'
import { buildCompileResultEvent } from '../routes/compile-result-event.js'

class MockWsClient implements WSClient {
  readyState = 1
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
}

function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

type ReceivedEnvelope = {
  type?: string
  compileId?: string
  payload?: { type?: string; compileId?: string }
}

function parseEnvelopes(ws: MockWsClient): ReceivedEnvelope[] {
  return ws.sent
    .map((raw) => JSON.parse(raw) as ReceivedEnvelope)
    .filter((msg) => typeof msg.type === 'string' && msg.type.startsWith('flow:'))
}

function buildCompileEvents(compileId: string): DzupEvent[] {
  return [
    { type: 'flow:compile_started', compileId, inputKind: 'object' },
    { type: 'flow:compile_parsed', compileId, astNodeType: 'workflow', errorCount: 0 },
    { type: 'flow:compile_shape_validated', compileId, errorCount: 0 },
    {
      type: 'flow:compile_semantic_resolved',
      compileId,
      resolvedCount: 3,
      personaCount: 1,
      errorCount: 0,
    },
    {
      type: 'flow:compile_lowered',
      compileId,
      target: 'workflow-builder',
      nodeCount: 5,
      edgeCount: 4,
      warningCount: 0,
    },
    { type: 'flow:compile_completed', compileId, target: 'workflow-builder', durationMs: 42 },
    buildCompileResultEvent({
      compileId,
      target: 'workflow-builder',
      artifact: { nodes: [], edges: [] },
      warnings: [],
      reasons: [{ code: 'BRANCH_PRESENT', message: 'Branch control flow is present; skill-chain is not sufficient.' }],
    }),
    { type: 'flow:compile_failed', compileId, stage: 3, errorCount: 1, durationMs: 99 },
  ]
}

describe('compile WS bridge', () => {
  it('delivers compile lifecycle and result events to a subscribed client', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const onMessage = createCompileWsHandler(bridge, ws)
    await onMessage(JSON.stringify({ type: 'subscribe:compile', compileId: 'c-1' }))

    for (const event of buildCompileEvents('c-1')) {
      bus.emit(event)
    }
    await drain()

    const compileEnvelopes = parseEnvelopes(ws)
    const types = compileEnvelopes.map((env) => env.type).sort()
    expect(types).toEqual(
      [
        'flow:compile_completed',
        'flow:compile_failed',
        'flow:compile_lowered',
        'flow:compile_parsed',
        'flow:compile_result',
        'flow:compile_semantic_resolved',
        'flow:compile_shape_validated',
        'flow:compile_started',
      ].sort(),
    )
    expect(compileEnvelopes.every((env) => env.compileId === 'c-1')).toBe(true)
  })

  it('does not deliver events with a different compileId', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const onMessage = createCompileWsHandler(bridge, ws)
    await onMessage(JSON.stringify({ type: 'subscribe:compile', compileId: 'c-target' }))

    bus.emit({ type: 'flow:compile_started', compileId: 'c-other', inputKind: 'object' })
    bus.emit({ type: 'flow:compile_completed', compileId: 'c-other', target: 'pipeline', durationMs: 10 })
    await drain()

    expect(parseEnvelopes(ws)).toHaveLength(0)
  })

  it('routes events to the correct client when two sockets watch different compileIds', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const wsA = new MockWsClient()
    const wsB = new MockWsClient()
    bridge.addClient(wsA)
    bridge.addClient(wsB)

    const handlerA = createCompileWsHandler(bridge, wsA)
    const handlerB = createCompileWsHandler(bridge, wsB)
    await handlerA(JSON.stringify({ type: 'subscribe:compile', compileId: 'c-A' }))
    await handlerB(JSON.stringify({ type: 'subscribe:compile', compileId: 'c-B' }))

    bus.emit({ type: 'flow:compile_started', compileId: 'c-A', inputKind: 'object' })
    bus.emit({ type: 'flow:compile_started', compileId: 'c-B', inputKind: 'json-string' })
    bus.emit({
      type: 'flow:compile_lowered',
      compileId: 'c-A',
      target: 'skill-chain',
      nodeCount: 2,
      edgeCount: 1,
      warningCount: 0,
    })
    await drain()

    const envelopesA = parseEnvelopes(wsA)
    const envelopesB = parseEnvelopes(wsB)

    expect(envelopesA.map((e) => e.compileId)).toEqual(['c-A', 'c-A'])
    expect(envelopesA.map((e) => e.type)).toEqual(['flow:compile_started', 'flow:compile_lowered'])
    expect(envelopesB.map((e) => e.compileId)).toEqual(['c-B'])
    expect(envelopesB.map((e) => e.type)).toEqual(['flow:compile_started'])
  })

  it('stops delivery after unsubscribe:compile when unsubscribeFilter denies all', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    // Deny-all baseline — the pattern used by scoped runtimes.
    bridge.addClient(ws, { eventTypes: [] })

    const onMessage = createCompileWsHandler(bridge, ws, {
      unsubscribeFilter: { eventTypes: [] },
    })
    await onMessage(JSON.stringify({ type: 'subscribe:compile', compileId: 'c-1' }))
    await onMessage(JSON.stringify({ type: 'unsubscribe:compile', compileId: 'c-1' }))

    bus.emit({ type: 'flow:compile_started', compileId: 'c-1', inputKind: 'object' })
    await drain()

    expect(parseEnvelopes(ws)).toHaveLength(0)
  })

  it('rejects subscribe:compile with missing compileId', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const onMessage = createCompileWsHandler(bridge, ws)
    await onMessage(JSON.stringify({ type: 'subscribe:compile', compileId: '   ' }))

    const errors = ws.sent
      .map((raw) => JSON.parse(raw) as { type?: string; code?: string })
      .filter((msg) => msg.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe('INVALID_COMPILE_ID')
  })

  it('honours authorizeCompile gate', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    // Deny-all baseline — rejected auth leaves filter unchanged,
    // so a scoped runtime ensures no leakage.
    bridge.addClient(ws, { eventTypes: [] })

    const onMessage = createCompileWsHandler(bridge, ws, {
      authorizeCompile: ({ compileId }) => compileId === 'allowed',
    })
    await onMessage(JSON.stringify({ type: 'subscribe:compile', compileId: 'denied' }))

    bus.emit({ type: 'flow:compile_started', compileId: 'denied', inputKind: 'object' })
    await drain()

    const errors = ws.sent
      .map((raw) => JSON.parse(raw) as { type?: string; code?: string })
      .filter((msg) => msg.type === 'error')
    expect(errors.some((err) => err.code === 'FORBIDDEN_COMPILE')).toBe(true)
    expect(parseEnvelopes(ws)).toHaveLength(0)
  })

  it('ignores non-compile message types so it can coexist with the control handler', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const ws = new MockWsClient()
    bridge.addClient(ws)

    const onMessage = createCompileWsHandler(bridge, ws)
    await onMessage(JSON.stringify({ type: 'subscribe', filter: { runId: 'r-1' } }))
    await onMessage('not-json')

    expect(ws.sent).toHaveLength(0)
  })
})
