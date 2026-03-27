/**
 * SyncSession — manages a sync session with a single remote peer.
 *
 * Orchestrates the handshake, message routing, anti-entropy loop,
 * and lifecycle management for one peer connection.
 */

import type { HLC } from '../crdt/hlc.js'
import type { SharedMemoryNamespace } from '../shared-namespace.js'
import { SyncProtocol } from './sync-protocol.js'
import type {
  SyncConfig,
  SyncEvent,
  SyncMessage,
  SyncSessionState,
  SyncStats,
  SyncTransport,
} from './types.js'

export class SyncSession {
  private readonly protocols: Map<string, SyncProtocol>
  private readonly eventHandlers: Set<(event: SyncEvent) => void> = new Set()
  private currentState: SyncSessionState = 'closed'
  private transport: SyncTransport | null = null
  private stopAntiEntropy: (() => void) | null = null
  private remoteNodeId: string | null = null

  // Stats
  private _sentDeltas = 0
  private _receivedDeltas = 0
  private _conflicts = 0
  private _lastSyncAt: number | null = null

  constructor(
    private readonly config: SyncConfig,
    namespaces: Map<string, SharedMemoryNamespace>,
    hlc: HLC,
  ) {
    this.protocols = new Map()
    for (const [name, ns] of namespaces) {
      // Only sync configured namespaces (or all if none specified)
      if (!config.namespaces || config.namespaces.includes(name)) {
        this.protocols.set(
          name,
          new SyncProtocol({ ...config, namespaces: [name] }, ns, hlc),
        )
      }
    }
  }

  /** Current session state. */
  get state(): SyncSessionState {
    return this.currentState
  }

  /** Connect to a remote peer via the given transport. */
  async connect(transport: SyncTransport): Promise<void> {
    if (this.currentState !== 'closed' && this.currentState !== 'error') {
      throw new Error(`Cannot connect: session is in "${this.currentState}" state`)
    }

    this.transport = transport
    this.setState('connecting')

    // Wire up message handler
    transport.onMessage((message: SyncMessage) => {
      this.handleIncomingMessage(message)
    })

    // Send hello to initiate the handshake
    const namespaceNames = Array.from(this.protocols.keys())
    try {
      await transport.send({
        type: 'sync:hello',
        nodeId: this.config.nodeId,
        namespaces: namespaceNames,
      })
    } catch (err) {
      this.setState('error')
      this.emitEvent({
        type: 'sync:error',
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    this.setState('idle')

    // Start anti-entropy loops for all protocols
    const stoppers: Array<() => void> = []
    for (const [, protocol] of this.protocols) {
      stoppers.push(protocol.startAntiEntropy(transport))
    }
    this.stopAntiEntropy = () => {
      for (const stop of stoppers) {
        stop()
      }
    }
  }

  /** Disconnect from the remote peer. */
  async disconnect(): Promise<void> {
    if (this.stopAntiEntropy) {
      this.stopAntiEntropy()
      this.stopAntiEntropy = null
    }

    if (this.transport) {
      try {
        await this.transport.close()
      } catch {
        // Non-fatal: transport close errors are swallowed
      }
      this.transport = null
    }

    const remoteId = this.remoteNodeId
    this.setState('closed')

    if (remoteId) {
      this.emitEvent({ type: 'sync:disconnected', remoteNodeId: remoteId })
      this.remoteNodeId = null
    }
  }

  /** Subscribe to sync events. Returns an unsubscribe function. */
  onEvent(handler: (event: SyncEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => {
      this.eventHandlers.delete(handler)
    }
  }

  /** Get sync statistics for this session. */
  stats(): SyncStats {
    return {
      sentDeltas: this._sentDeltas,
      receivedDeltas: this._receivedDeltas,
      conflicts: this._conflicts,
      lastSyncAt: this._lastSyncAt,
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private handleIncomingMessage(message: SyncMessage): void {
    try {
      // Track remote nodeId from hello
      if (message.type === 'sync:hello') {
        this.remoteNodeId = message.nodeId
        this.emitEvent({ type: 'sync:connected', remoteNodeId: message.nodeId })
      }

      // Route message to protocol(s)
      if (message.type === 'sync:error') {
        this.setState('error')
        this.emitEvent({ type: 'sync:error', error: message.message })
        return
      }

      // Messages scoped to a namespace
      if ('namespace' in message && typeof message.namespace === 'string') {
        const protocol = this.protocols.get(message.namespace)
        if (!protocol) {
          this.sendResponse({
            type: 'sync:error',
            code: 'UNKNOWN_NAMESPACE',
            message: `Unknown namespace: ${message.namespace}`,
          })
          return
        }

        this.setState('syncing')
        const responses = protocol.handleMessage(message)
        this.trackStats(message, responses)

        for (const response of responses) {
          this.sendResponse(response)
        }

        this.setState('idle')
        return
      }

      // Hello messages are broadcast to all protocols
      if (message.type === 'sync:hello') {
        for (const [, protocol] of this.protocols) {
          const responses = protocol.handleMessage(message)
          for (const response of responses) {
            this.sendResponse(response)
          }
        }
      }
    } catch (err) {
      this.emitEvent({
        type: 'sync:error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private sendResponse(message: SyncMessage): void {
    if (!this.transport) return
    this.transport.send(message).catch((err: unknown) => {
      this.emitEvent({
        type: 'sync:error',
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  private trackStats(incoming: SyncMessage, _responses: SyncMessage[]): void {
    if (incoming.type === 'sync:delta') {
      this._receivedDeltas++
      this._lastSyncAt = Date.now()

      // We can inspect the ack response to count accepts/rejects
      for (const resp of _responses) {
        if (resp.type === 'sync:ack') {
          this.emitEvent({
            type: 'sync:delta-received',
            namespace: incoming.namespace,
            accepted: resp.acceptedCount,
            rejected: resp.rejectedCount,
            conflicts: 0,
          })
        }
      }
    }

    for (const resp of _responses) {
      if (resp.type === 'sync:delta') {
        this._sentDeltas++
        this._lastSyncAt = Date.now()
        this.emitEvent({
          type: 'sync:delta-sent',
          namespace: resp.namespace,
          entryCount: resp.delta.entries.length,
        })
      }
    }
  }

  private setState(state: SyncSessionState): void {
    this.currentState = state
  }

  private emitEvent(event: SyncEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch {
        // Non-fatal: event handler errors are swallowed
      }
    }
  }
}
