/**
 * WebSocketSyncTransport — WebSocket-based implementation of SyncTransport.
 *
 * Serializes SyncMessages to JSON and sends them over a WebSocket connection.
 * Works with the standard WebSocket API (browser or Node.js via ws/undici).
 */

import type { SyncMessage, SyncTransport } from './types.js'

/**
 * Minimal WebSocket interface that this transport depends on.
 *
 * Compatible with the browser WebSocket API, Node.js `ws`, and any
 * object that provides send/addEventListener/removeEventListener/close.
 */
export interface WebSocketLike {
  send(data: string): void
  addEventListener(event: 'message', handler: (ev: { data: unknown }) => void): void
  removeEventListener(event: 'message', handler: (ev: { data: unknown }) => void): void
  addEventListener(event: 'close', handler: () => void): void
  removeEventListener(event: 'close', handler: () => void): void
  close(): void
  readonly readyState: number
}

/**
 * Adapt a standard (global) WebSocket to {@link WebSocketLike}. The standard
 * API already provides every member; the adapter only bridges the narrower
 * handler signatures so no structural cast is needed at the call site.
 */
function adaptGlobalWebSocket(socket: WebSocket): WebSocketLike {
  return {
    send: (data: string) => socket.send(data),
    addEventListener: (event: 'message' | 'close', handler: (ev: { data: unknown }) => void) => {
      if (event === 'message') socket.addEventListener('message', handler)
      else socket.addEventListener('close', handler as () => void)
    },
    removeEventListener: (event: 'message' | 'close', handler: (ev: { data: unknown }) => void) => {
      if (event === 'message') socket.removeEventListener('message', handler)
      else socket.removeEventListener('close', handler as () => void)
    },
    close: () => socket.close(),
    get readyState() {
      return socket.readyState
    },
  }
}

/** WebSocket readyState constants. */
const WS_OPEN = 1

export class WebSocketSyncTransport implements SyncTransport {
  private messageHandler: ((message: SyncMessage) => void) | null = null
  private readonly boundOnMessage: (ev: { data: unknown }) => void

  constructor(private readonly ws: WebSocketLike) {
    this.boundOnMessage = (ev: { data: unknown }) => {
      this.handleRawMessage(ev.data)
    }
    this.ws.addEventListener('message', this.boundOnMessage)
  }

  /**
   * Create a transport from a WebSocket URL.
   *
   * Uses the global WebSocket constructor (available in Node.js 21+ and browsers).
   * For older Node.js versions, pass a `ws` WebSocket instance directly.
   */
  static fromUrl(url: string): Promise<WebSocketSyncTransport> {
    return new Promise((resolve, reject) => {
      // Use global WebSocket (available in modern Node.js and browsers)
      const socket = new WebSocket(url)

      const onOpen = (): void => {
        cleanup()
        resolve(new WebSocketSyncTransport(adaptGlobalWebSocket(socket)))
      }

      const onError = (): void => {
        cleanup()
        reject(new Error(`WebSocket connection to ${url} failed`))
      }

      const cleanup = (): void => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
      }

      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
    })
  }

  async send(message: SyncMessage): Promise<void> {
    if (this.ws.readyState !== WS_OPEN) {
      throw new Error('WebSocket is not open')
    }
    const json = JSON.stringify(message)
    this.ws.send(json)
  }

  onMessage(handler: (message: SyncMessage) => void): void {
    this.messageHandler = handler
  }

  async close(): Promise<void> {
    this.ws.removeEventListener('message', this.boundOnMessage)
    this.messageHandler = null
    this.ws.close()
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private handleRawMessage(data: unknown): void {
    if (!this.messageHandler) return

    try {
      const text = typeof data === 'string' ? data : String(data)
      const parsed: unknown = JSON.parse(text)

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'type' in parsed &&
        typeof (parsed as Record<string, unknown>)['type'] === 'string'
      ) {
        this.messageHandler(parsed as SyncMessage)
      }
    } catch {
      // Non-fatal: malformed messages are silently dropped
    }
  }
}
