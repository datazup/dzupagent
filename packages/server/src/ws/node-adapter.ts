import { Buffer } from 'node:buffer'
import type { WSClient } from './event-bridge.js'
import type { WSClientScope } from './authorization.js'
import type { WSSessionManager } from './session-manager.js'

export interface NodeWSLike extends WSClient {
  on(event: 'message', listener: (data: unknown) => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'error', listener: (err: unknown) => void): this
}

export interface AttachNodeWsSessionOptions {
  manager: WSSessionManager
  socket: NodeWSLike
  scope?: WSClientScope
  onMessageError?: (err: unknown) => void
}

function toTextMessage(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Buffer) return data.toString('utf-8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8')
  if (Array.isArray(data) && data.every((chunk) => chunk instanceof Buffer)) {
    return Buffer.concat(data).toString('utf-8')
  }
  return String(data)
}

/**
 * Attach a Node-style websocket socket (`ws` package compatible) to WSSessionManager.
 *
 * This helper wires message/close/error events and handles UTF-8 message conversion.
 */
export async function attachNodeWsSession(options: AttachNodeWsSessionOptions): Promise<void> {
  const { manager, socket, scope, onMessageError } = options
  await manager.attach(socket, scope)

  socket.on('message', (data) => {
    const raw = toTextMessage(data)
    void manager.handleMessage(socket, raw).catch((err) => {
      if (onMessageError) onMessageError(err)
    })
  })

  socket.on('close', () => {
    manager.detach(socket)
  })

  socket.on('error', () => {
    manager.detach(socket)
  })
}
