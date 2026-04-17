/**
 * Branch coverage tests for attachNodeWsSession.
 *
 * Exercises toTextMessage() branches: string, Buffer, ArrayBuffer, Buffer[], fallback.
 * Also covers error callback when handleMessage throws.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import { createEventBus } from '@dzupagent/core'
import { EventBridge, type WSClient } from '../ws/event-bridge.js'
import { WSClientScopeRegistry } from '../ws/scope-registry.js'
import { WSSessionManager } from '../ws/session-manager.js'
import { attachNodeWsSession } from '../ws/node-adapter.js'

class MockNodeSocket extends EventEmitter implements WSClient {
  readyState = 1
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
    this.emit('close')
  }
}

function flushMicrotasks(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('attachNodeWsSession branch coverage', () => {
  it('handles Buffer messages', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const socket = new MockNodeSocket()

    await attachNodeWsSession({
      manager,
      socket,
      scope: { runIds: ['run-1'] },
    })

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe', filter: { runId: 'run-1' } }), 'utf-8'))
    await flushMicrotasks()

    expect(socket.sent.length).toBeGreaterThan(0)
    const ack = JSON.parse(socket.sent[0] ?? '{}') as { type?: string }
    expect(ack.type).toBe('subscribed')
  })

  it('handles ArrayBuffer messages', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const socket = new MockNodeSocket()

    await attachNodeWsSession({
      manager,
      socket,
      scope: { runIds: ['run-1'] },
    })

    const payload = JSON.stringify({ type: 'subscribe', filter: { runId: 'run-1' } })
    const buf = new ArrayBuffer(payload.length)
    const view = new Uint8Array(buf)
    for (let i = 0; i < payload.length; i++) {
      view[i] = payload.charCodeAt(i)
    }
    socket.emit('message', buf)
    await flushMicrotasks()

    expect(socket.sent.length).toBeGreaterThan(0)
    const ack = JSON.parse(socket.sent[0] ?? '{}') as { type?: string }
    expect(ack.type).toBe('subscribed')
  })

  it('handles array of Buffer chunks', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const socket = new MockNodeSocket()

    await attachNodeWsSession({
      manager,
      socket,
      scope: { runIds: ['run-1'] },
    })

    const payload = JSON.stringify({ type: 'subscribe', filter: { runId: 'run-1' } })
    const half = Math.floor(payload.length / 2)
    const chunks = [Buffer.from(payload.slice(0, half), 'utf-8'), Buffer.from(payload.slice(half), 'utf-8')]

    socket.emit('message', chunks)
    await flushMicrotasks()

    expect(socket.sent.length).toBeGreaterThan(0)
    const ack = JSON.parse(socket.sent[0] ?? '{}') as { type?: string }
    expect(ack.type).toBe('subscribed')
  })

  it('falls back to String() for unknown message types', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const socket = new MockNodeSocket()

    await attachNodeWsSession({ manager, socket })

    // Pass an unexpected type — should serialize via String() and yield an error response
    socket.emit('message', 12345)
    await flushMicrotasks()

    expect(socket.sent.length).toBeGreaterThan(0)
    const response = JSON.parse(socket.sent[0] ?? '{}') as { type?: string }
    // A non-JSON string should produce an INVALID_JSON error
    expect(response.type).toBe('error')
  })

  it('invokes onMessageError when handleMessage throws', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const socket = new MockNodeSocket()

    vi.spyOn(manager, 'handleMessage').mockRejectedValue(new Error('downstream boom'))

    const errors: unknown[] = []
    await attachNodeWsSession({
      manager,
      socket,
      onMessageError: (err) => { errors.push(err) },
    })

    socket.emit('message', 'hello')
    await flushMicrotasks()

    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('downstream boom')
  })

  it('swallows handleMessage errors without onMessageError', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const socket = new MockNodeSocket()

    vi.spyOn(manager, 'handleMessage').mockRejectedValue(new Error('no handler set'))

    await attachNodeWsSession({ manager, socket })

    expect(() => socket.emit('message', 'test')).not.toThrow()
    await flushMicrotasks()
  })

  it('detaches on error event', async () => {
    const bus = createEventBus()
    const bridge = new EventBridge(bus)
    const manager = new WSSessionManager(bridge, new WSClientScopeRegistry())
    const socket = new MockNodeSocket()

    await attachNodeWsSession({ manager, socket })
    expect(bridge.clientCount).toBe(1)

    socket.emit('error', new Error('socket failure'))
    expect(bridge.clientCount).toBe(0)
  })
})
