/**
 * ProtocolBridge — translates and forwards messages between protocol adapters.
 *
 * Enables interoperability between different protocols (e.g., MCP <-> A2A)
 * by translating message formats while preserving trace context.
 */
import type { ProtocolAdapter, Subscription } from './adapter.js'
import type { ForgeMessage, ForgePayload } from './message-types.js'
import { createForgeMessage, createMessageId } from './message-factory.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type BridgeDirection = 'source-to-target' | 'target-to-source'

export interface ProtocolBridgeConfig {
  /** Source adapter */
  source: ProtocolAdapter
  /** Target adapter */
  target: ProtocolAdapter
  /** Transform function for message translation (optional) */
  transform?: (message: ForgeMessage, direction: BridgeDirection) => ForgeMessage
}

// ---------------------------------------------------------------------------
// ProtocolBridge
// ---------------------------------------------------------------------------

export class ProtocolBridge {
  private readonly source: ProtocolAdapter
  private readonly target: ProtocolAdapter
  private readonly transform: ((message: ForgeMessage, direction: BridgeDirection) => ForgeMessage) | undefined

  constructor(config: ProtocolBridgeConfig) {
    this.source = config.source
    this.target = config.target
    this.transform = config.transform
  }

  /**
   * Bridge a message from source protocol to target protocol.
   *
   * Applies optional transform, then sends through the target adapter.
   */
  async bridge(message: ForgeMessage): Promise<ForgeMessage> {
    let translated = this.transform
      ? this.transform(message, 'source-to-target')
      : message

    // Update protocol field to match target
    translated = {
      ...translated,
      protocol: this.target.protocol,
    }

    return this.target.send(translated)
  }

  /**
   * Start bidirectional bridging: subscribe on source, forward to target.
   *
   * Returns a handle with a stop() method to tear down the subscription.
   */
  start(pattern: string): { stop(): void } {
    const subscription: Subscription = this.source.subscribe(pattern, async (message) => {
      const translated = this.transform
        ? this.transform(message, 'source-to-target')
        : message

      const bridged: ForgeMessage = {
        ...translated,
        protocol: this.target.protocol,
      }

      return this.target.send(bridged)
    })

    return {
      stop: () => subscription.unsubscribe(),
    }
  }

  /**
   * Translate MCP tool_call to A2A task format.
   *
   * Maps:
   * - tool_call.callId -> task.taskId
   * - tool_call.toolName -> task.description
   * - tool_call.arguments -> task.context
   * - protocol: 'mcp' -> 'a2a'
   *
   * Preserves metadata.traceId and metadata.spanId.
   */
  static mcpToA2A(message: ForgeMessage): ForgeMessage {
    let payload: ForgePayload

    if (message.payload.type === 'tool_call') {
      payload = {
        type: 'task',
        taskId: message.payload.callId,
        description: message.payload.toolName,
        context: message.payload.arguments,
      }
    } else {
      // Pass through non-tool_call payloads unchanged
      payload = message.payload
    }

    return createForgeMessage({
      type: message.type,
      from: message.from,
      to: message.to,
      protocol: 'a2a',
      payload,
      correlationId: message.correlationId,
      parentId: message.parentId,
      metadata: {
        ...message.metadata,
      },
    })
  }

  /**
   * Translate A2A task result to MCP tool_result format.
   *
   * Maps:
   * - task.taskId -> tool_result.callId
   * - task.context -> tool_result.result
   * - protocol: 'a2a' -> 'mcp'
   *
   * Preserves metadata.traceId and metadata.spanId.
   */
  static a2aToMcp(message: ForgeMessage): ForgeMessage {
    let payload: ForgePayload

    if (message.payload.type === 'task') {
      payload = {
        type: 'tool_result',
        callId: message.payload.taskId,
        result: message.payload.context ?? {},
      }
    } else if (message.payload.type === 'text') {
      // Wrap text responses as tool_result
      payload = {
        type: 'tool_result',
        callId: (message.correlationId ?? createMessageId()) as string,
        result: { text: message.payload.content },
      }
    } else if (message.payload.type === 'json') {
      payload = {
        type: 'tool_result',
        callId: (message.correlationId ?? createMessageId()) as string,
        result: message.payload.data,
      }
    } else if (message.payload.type === 'error') {
      payload = {
        type: 'tool_result',
        callId: (message.correlationId ?? createMessageId()) as string,
        result: { error: message.payload.message },
        isError: true,
      }
    } else {
      // Pass through other payloads unchanged
      payload = message.payload
    }

    return createForgeMessage({
      type: message.type,
      from: message.from,
      to: message.to,
      protocol: 'mcp',
      payload,
      correlationId: message.correlationId,
      parentId: message.parentId,
      metadata: {
        ...message.metadata,
      },
    })
  }
}
