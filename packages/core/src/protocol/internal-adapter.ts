/**
 * InternalAdapter — in-process message routing via AgentBus.
 *
 * Used for communication between agents running in the same Node.js process.
 * Routes ForgeMessage envelopes through named AgentBus channels,
 * keyed by the target agent ID extracted from the `message.to` URI.
 */
import type {
  ProtocolAdapter,
  AdapterState,
  AdapterHealthStatus,
  SendOptions,
  MessageHandler,
  Subscription,
} from './adapter.js'
import type { ForgeMessage } from './message-types.js'
import type { AgentBus } from '../events/agent-bus.js'
import { ForgeError } from '../errors/forge-error.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface InternalAdapterConfig {
  agentBus: AgentBus
  /** Timeout for send() if no response (default: 30000ms) */
  defaultTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// URI helper
// ---------------------------------------------------------------------------

/**
 * Extract agent ID from a URI, stripping the @version suffix (S5 fix).
 *
 * Examples:
 * - `forge://acme/code-reviewer@1.2.0` -> `code-reviewer`
 * - `forge://acme/code-reviewer` -> `code-reviewer`
 * - `a2a://host/agent-name@2.0.0` -> `agent-name`
 * - `http://example.com/path` -> `path`
 *
 * Strategy: take the last path segment after the authority, then strip @version.
 */
export function extractAgentId(uri: string): string {
  // Remove scheme (everything up to and including ://)
  const schemeEnd = uri.indexOf('://')
  const rest = schemeEnd >= 0 ? uri.slice(schemeEnd + 3) : uri

  // Split by '/' and take the last non-empty segment
  const segments = rest.split('/').filter((s) => s.length > 0)
  const lastSegment = segments[segments.length - 1]
  if (!lastSegment) {
    return rest
  }

  // Strip @version suffix (S5 review fix)
  const atIdx = lastSegment.indexOf('@')
  if (atIdx > 0) {
    return lastSegment.slice(0, atIdx)
  }
  return lastSegment
}

// ---------------------------------------------------------------------------
// InternalAdapter
// ---------------------------------------------------------------------------

/** Unique subscriber ID counter for internal adapter subscriptions. */
let subscriberCounter = 0

export class InternalAdapter implements ProtocolAdapter {
  readonly protocol = 'internal' as const
  private readonly agentBus: AgentBus
  private readonly defaultTimeoutMs: number

  constructor(config: InternalAdapterConfig) {
    this.agentBus = config.agentBus
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 30_000
  }

  get state(): AdapterState {
    return 'connected'
  }

  /** No-op for in-process adapter (always connected). */
  async connect(): Promise<void> {
    // In-process — nothing to connect to.
  }

  /** No-op for in-process adapter. */
  async disconnect(): Promise<void> {
    // In-process — nothing to disconnect from.
  }

  /**
   * Send message to target agent via AgentBus.
   *
   * Extracts agent ID from `message.to` URI (stripping @version per S5).
   * Publishes the message payload to the agent's channel, then waits for
   * a response on a correlation channel keyed by the message ID.
   */
  async send(message: ForgeMessage, options?: SendOptions): Promise<ForgeMessage> {
    const targetAgent = extractAgentId(message.to)
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs
    const responseChannel = `__response:${message.id}`

    return new Promise<ForgeMessage>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      // Subscribe for the response on the correlation channel
      const subscriberId = `internal-adapter-${++subscriberCounter}`
      const unsub = this.agentBus.subscribe(responseChannel, subscriberId, (agentMsg) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        unsub()
        resolve(agentMsg.payload as unknown as ForgeMessage)
      })

      // Handle abort signal
      if (options?.signal) {
        if (options.signal.aborted) {
          settled = true
          unsub()
          reject(
            new ForgeError({
              code: 'PROTOCOL_SEND_FAILED',
              message: 'Send aborted',
              recoverable: false,
            }),
          )
          return
        }
        options.signal.addEventListener(
          'abort',
          () => {
            if (settled) return
            settled = true
            if (timer !== undefined) clearTimeout(timer)
            unsub()
            reject(
              new ForgeError({
                code: 'PROTOCOL_SEND_FAILED',
                message: 'Send aborted',
                recoverable: false,
              }),
            )
          },
          { once: true },
        )
      }

      // Set up timeout
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        unsub()
        reject(
          new ForgeError({
            code: 'PROTOCOL_TIMEOUT',
            message: `No response from "${targetAgent}" within ${timeoutMs}ms`,
            recoverable: true,
            context: { targetAgent, timeoutMs },
          }),
        )
      }, timeoutMs)

      // Publish the message to the target agent's channel
      this.agentBus.publish('internal-adapter', targetAgent, {
        __forgeMessage: true,
        message: message as unknown as Record<string, unknown>,
        responseChannel,
      })
    })
  }

  /**
   * Send message and yield incoming messages on the response channel
   * until a `stream_end` type is received.
   */
  async *stream(message: ForgeMessage, options?: SendOptions): AsyncIterable<ForgeMessage> {
    const targetAgent = extractAgentId(message.to)
    const responseChannel = `__stream:${message.id}`
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs

    // Buffer for messages received before we consume them
    const buffer: ForgeMessage[] = []
    let done = false
    let resolveWait: (() => void) | undefined
    let rejectWait: ((err: Error) => void) | undefined

    const subscriberId = `internal-stream-${++subscriberCounter}`
    const unsub = this.agentBus.subscribe(responseChannel, subscriberId, (agentMsg) => {
      const forgeMsg = agentMsg.payload as unknown as ForgeMessage
      buffer.push(forgeMsg)
      if (forgeMsg.type === 'stream_end') {
        done = true
      }
      resolveWait?.()
    })

    // Publish the message to the target agent
    this.agentBus.publish('internal-adapter', targetAgent, {
      __forgeMessage: true,
      message: message as unknown as Record<string, unknown>,
      responseChannel,
    })

    try {
      while (!done) {
        if (buffer.length > 0) {
          const msg = buffer.shift()!
          if (msg.type === 'stream_end') {
            break
          }
          yield msg
        } else {
          // Wait for next message or timeout
          await new Promise<void>((resolve, reject) => {
            resolveWait = resolve
            rejectWait = reject
            setTimeout(() => {
              reject(
                new ForgeError({
                  code: 'PROTOCOL_TIMEOUT',
                  message: `Stream timeout after ${timeoutMs}ms`,
                  recoverable: true,
                }),
              )
            }, timeoutMs)
          })
        }
      }
    } finally {
      // Suppress unused variable warning — rejectWait is used by reference in the closure
      void rejectWait
      unsub()
    }
  }

  /**
   * Register handler on AgentBus channel.
   */
  subscribe(pattern: string, handler: MessageHandler): Subscription {
    const subscriberId = `internal-sub-${++subscriberCounter}`
    const unsub = this.agentBus.subscribe(pattern, subscriberId, (agentMsg) => {
      // Extract the ForgeMessage from the AgentBus payload
      const payload = agentMsg.payload
      const forgeMsg = (payload['__forgeMessage'] ? payload['message'] : payload) as unknown as ForgeMessage
      const responseChannel = payload['responseChannel'] as string | undefined

      void handler(forgeMsg).then((response) => {
        if (response && responseChannel) {
          // Send response back via the response channel
          this.agentBus.publish(pattern, responseChannel, response as unknown as Record<string, unknown>)
        }
      }).catch(() => {
        // Handler errors are non-fatal, matching AgentBus convention
      })
    })

    return {
      unsubscribe: unsub,
    }
  }

  health(): AdapterHealthStatus {
    return {
      state: 'connected',
      latencyMs: 0,
    }
  }
}
