import { test, expect, vi } from 'vitest'
import { WebSocketSyncTransport } from '../../sync/ws-transport.js'

test('WebSocket connection establishment removes both temporary listeners on open and error', async () => {
  let ws!: EventTarget & { readyState: number; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  class FakeWebSocket extends EventTarget {
    readyState = 1
    send = vi.fn()
    close = vi.fn()
    constructor() { super(); ws = this }
  }
  vi.stubGlobal('WebSocket', FakeWebSocket)
  try {
    const connected = WebSocketSyncTransport.fromUrl('ws://fixture.invalid')
    const removed = vi.spyOn(ws, 'removeEventListener')
    ws.dispatchEvent(new Event('open'))
    const transport = await connected
    expect(removed.mock.calls.map(([type]) => type)).toEqual(['open', 'error'])
    await transport.close()
    expect(ws.close).toHaveBeenCalledOnce()
    const failed = WebSocketSyncTransport.fromUrl('ws://fixture.invalid')
    const failedRemoved = vi.spyOn(ws, 'removeEventListener')
    ws.dispatchEvent(new Event('error'))
    await expect(failed).rejects.toThrow(/failed/)
    expect(failedRemoved.mock.calls.map(([type]) => type)).toEqual(['open', 'error'])
  } finally { vi.unstubAllGlobals() }
})
