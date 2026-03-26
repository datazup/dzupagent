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
      const ws = new WebSocket(url) as unknown as WebSocketLike

      const onOpen = (): void => {
        cleanup()
        resolve(new WebSocketSyncTransport(ws))
      }

      const onError = (): void => {
        cleanup()
        reject(new Error(`WebSocket connection to ${url} failed`))
      }

      const cleanup = (): void => {
        ws.removeEventListener('message', onOpen as (ev: { data: unknown }) => void)
        ws.removeEventListener('close', onError)
      }

      // Use addEventListener with type casting for open/error
      ;(ws as unknown as EventTarget).addEventListener('open', onOpen)
      ;(ws as unknown as EventTarget).addEventListener('error', onError)
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
