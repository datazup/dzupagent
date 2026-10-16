/**
 * DZUPAGENT-ERR-L-49 — the memory sync WebSocket handler must not swallow
 * session connect/disconnect rejections or malformed frames silently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { secureLogger } from '@dzupagent/core/utils'
import type { SyncSession } from '@dzupagent/memory'
import {
  createMemorySyncHandler,
  createMemorySyncRoutes,
  type MemorySyncRouteConfig,
  type SyncWebSocket,
} from '../routes/memory-sync.js'

const config: MemorySyncRouteConfig = { namespaces: new Map(), nodeId: 'node-a' }

function fakeSession(overrides: Partial<Record<'connect' | 'disconnect', () => Promise<void>>> = {}) {
  return {
    connect: vi.fn(overrides.connect ?? (async () => undefined)),
    disconnect: vi.fn(overrides.disconnect ?? (async () => undefined)),
    onEvent: vi.fn(),
  } as unknown as SyncSession
}

function fakeSocket(): SyncWebSocket {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 }
}

function warnEntries(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => call[0] as Record<string, unknown>)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('memory sync WebSocket handler', () => {
  it('logs one structured warning when the session connect rejects', async () => {
    const warn = vi.spyOn(secureLogger, 'warn').mockImplementation(() => undefined)
    const handler = createMemorySyncHandler(config, () =>
      fakeSession({ connect: async () => Promise.reject(new Error('handshake refused')) }),
    )

    handler.handleConnection(fakeSocket())

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    const [entry] = warnEntries(warn)
    expect(entry).toMatchObject({
      level: 'warn',
      operation: 'memory-sync.connect',
      nodeId: 'node-a',
      errorName: 'Error',
    })
    expect(typeof entry?.['connectionId']).toBe('string')
    expect(JSON.stringify(entry)).not.toContain('handshake refused')
  })

  it('logs a failed disconnect with the same connection id', async () => {
    const warn = vi.spyOn(secureLogger, 'warn').mockImplementation(() => undefined)
    const handler = createMemorySyncHandler(config, () =>
      fakeSession({ disconnect: async () => Promise.reject(new TypeError('socket gone')) }),
    )

    const handle = handler.handleConnection(fakeSocket())
    handle.onClose()

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(warnEntries(warn)[0]).toMatchObject({
      operation: 'memory-sync.disconnect',
      errorName: 'TypeError',
    })
  })

  it('counts malformed frames and logs only the first per connection', () => {
    const warn = vi.spyOn(secureLogger, 'warn').mockImplementation(() => undefined)
    const handler = createMemorySyncHandler(config, () => fakeSession())

    const handle = handler.handleConnection(fakeSocket())
    handle.onMessage('{not json')
    handle.onMessage('also not json')

    expect(handle.malformedFrames).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warnEntries(warn)[0]).toMatchObject({ operation: 'memory-sync.frame' })
  })

  it('does not log for a healthy connection and well-formed frames', async () => {
    const warn = vi.spyOn(secureLogger, 'warn').mockImplementation(() => undefined)
    const session = fakeSession()
    const handler = createMemorySyncHandler(config, () => session)

    const handle = handler.handleConnection(fakeSocket())
    handle.onMessage(JSON.stringify({ type: 'hello', nodeId: 'node-b' }))
    handle.onClose()

    await vi.waitFor(() => expect(session.disconnect).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(handle.malformedFrames).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('memory sync info route', () => {
  it('describes the sync endpoint', async () => {
    const res = await createMemorySyncRoutes(config).request('/api/memory/sync')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ protocol: 'dzupagent-crdt-sync', nodeId: 'node-a' })
  })
})
