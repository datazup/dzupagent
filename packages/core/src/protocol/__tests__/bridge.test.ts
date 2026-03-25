import { describe, it, expect, vi } from 'vitest'
import { ProtocolBridge } from '../protocol-bridge.js'
import { createForgeMessage, createMessageId } from '../message-factory.js'
import type { ForgeMessage, ForgePayload } from '../message-types.js'
import type {
  ProtocolAdapter,
  AdapterState,
  AdapterHealthStatus,
  SendOptions,
  MessageHandler,
  Subscription,
} from '../adapter.js'

// ---------------------------------------------------------------------------
// Mock adapter factory
// ---------------------------------------------------------------------------

function createMockAdapter(protocol: string): ProtocolAdapter & {
  lastSent: ForgeMessage | undefined
  sendMock: ReturnType<typeof vi.fn>
  subscribeMock: ReturnType<typeof vi.fn>
} {
  const sendMock = vi.fn<[ForgeMessage, SendOptions?], Promise<ForgeMessage>>()
  const subscribeMock = vi.fn<[string, MessageHandler], Subscription>()

  const adapter: ProtocolAdapter & {
    lastSent: ForgeMessage | undefined
    sendMock: typeof sendMock
    subscribeMock: typeof subscribeMock
  } = {
    protocol,
    lastSent: undefined,
    sendMock,
    subscribeMock,
    get state(): AdapterState {
      return 'connected'
    },
    async connect() {
      // no-op
    },
    async disconnect() {
      // no-op
    },
    async send(message: ForgeMessage, _options?: SendOptions): Promise<ForgeMessage> {
      adapter.lastSent = message
      const result = sendMock(message, _options)
      if (result) return result
      // Return a default response
      return createForgeMessage({
        type: 'response',
        from: message.to,
        to: message.from,
        protocol: adapter.protocol,
        payload: { type: 'text', content: 'ok' },
        correlationId: message.id,
      })
    },
    async *stream(message: ForgeMessage, _options?: SendOptions): AsyncIterable<ForgeMessage> {
      yield await adapter.send(message, _options)
    },
    subscribe(pattern: string, handler: MessageHandler): Subscription {
      subscribeMock(pattern, handler)
      return { unsubscribe: () => {} }
    },
    health(): AdapterHealthStatus {
      return { state: 'connected' }
    },
  }

  return adapter
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolCallMessage(): ForgeMessage {
  return createForgeMessage({
    type: 'request',
    from: 'mcp://localhost/tools',
    to: 'a2a://remote/agent',
    protocol: 'mcp',
    payload: {
      type: 'tool_call',
      toolName: 'analyze_code',
      arguments: { file: 'main.ts', depth: 3 },
      callId: 'call-abc',
    },
    metadata: { traceId: 'trace-xyz', spanId: 'span-123' },
  })
}

function makeTaskMessage(): ForgeMessage {
  return createForgeMessage({
    type: 'response',
    from: 'a2a://remote/agent',
    to: 'mcp://localhost/tools',
    protocol: 'a2a',
    payload: {
      type: 'task',
      taskId: 'call-abc',
      description: 'analyze_code',
      context: { result: 'analysis complete', issues: 0 },
    },
    metadata: { traceId: 'trace-xyz', spanId: 'span-123' },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProtocolBridge', () => {
  describe('mcpToA2A', () => {
    it('translates tool_call to task payload', () => {
      const msg = makeToolCallMessage()
      const result = ProtocolBridge.mcpToA2A(msg)

      expect(result.protocol).toBe('a2a')
      expect(result.payload.type).toBe('task')
      if (result.payload.type === 'task') {
        expect(result.payload.taskId).toBe('call-abc')
        expect(result.payload.description).toBe('analyze_code')
        expect(result.payload.context).toEqual({ file: 'main.ts', depth: 3 })
      }
    })

    it('preserves trace context', () => {
      const msg = makeToolCallMessage()
      const result = ProtocolBridge.mcpToA2A(msg)

      expect(result.metadata.traceId).toBe('trace-xyz')
      expect(result.metadata.spanId).toBe('span-123')
    })

    it('preserves from/to URIs', () => {
      const msg = makeToolCallMessage()
      const result = ProtocolBridge.mcpToA2A(msg)

      expect(result.from).toBe('mcp://localhost/tools')
      expect(result.to).toBe('a2a://remote/agent')
    })

    it('preserves message type', () => {
      const msg = makeToolCallMessage()
      const result = ProtocolBridge.mcpToA2A(msg)
      expect(result.type).toBe('request')
    })

    it('passes through non-tool_call payloads', () => {
      const msg = createForgeMessage({
        type: 'notification',
        from: 'mcp://localhost/tools',
        to: 'a2a://remote/agent',
        protocol: 'mcp',
        payload: { type: 'text', content: 'hello' },
      })
      const result = ProtocolBridge.mcpToA2A(msg)
      expect(result.protocol).toBe('a2a')
      expect(result.payload).toEqual({ type: 'text', content: 'hello' })
    })
  })

  describe('a2aToMcp', () => {
    it('translates task to tool_result payload', () => {
      const msg = makeTaskMessage()
      const result = ProtocolBridge.a2aToMcp(msg)

      expect(result.protocol).toBe('mcp')
      expect(result.payload.type).toBe('tool_result')
      if (result.payload.type === 'tool_result') {
        expect(result.payload.callId).toBe('call-abc')
        expect(result.payload.result).toEqual({ result: 'analysis complete', issues: 0 })
      }
    })

    it('preserves trace context', () => {
      const msg = makeTaskMessage()
      const result = ProtocolBridge.a2aToMcp(msg)

      expect(result.metadata.traceId).toBe('trace-xyz')
      expect(result.metadata.spanId).toBe('span-123')
    })

    it('translates text payload to tool_result', () => {
      const msg = createForgeMessage({
        type: 'response',
        from: 'a2a://remote/agent',
        to: 'mcp://localhost/tools',
        protocol: 'a2a',
        payload: { type: 'text', content: 'Done!' },
        correlationId: 'corr-1',
      })
      const result = ProtocolBridge.a2aToMcp(msg)

      expect(result.payload.type).toBe('tool_result')
      if (result.payload.type === 'tool_result') {
        expect(result.payload.callId).toBe('corr-1')
        expect(result.payload.result).toEqual({ text: 'Done!' })
      }
    })

    it('translates json payload to tool_result', () => {
      const msg = createForgeMessage({
        type: 'response',
        from: 'a2a://remote/agent',
        to: 'mcp://localhost/tools',
        protocol: 'a2a',
        payload: { type: 'json', data: { status: 'ok' } },
        correlationId: 'corr-2',
      })
      const result = ProtocolBridge.a2aToMcp(msg)

      expect(result.payload.type).toBe('tool_result')
      if (result.payload.type === 'tool_result') {
        expect(result.payload.result).toEqual({ status: 'ok' })
      }
    })

    it('translates error payload to tool_result with isError', () => {
      const msg = createForgeMessage({
        type: 'error',
        from: 'a2a://remote/agent',
        to: 'mcp://localhost/tools',
        protocol: 'a2a',
        payload: { type: 'error', code: 'INTERNAL_ERROR', message: 'Something broke' },
        correlationId: 'corr-3',
      })
      const result = ProtocolBridge.a2aToMcp(msg)

      expect(result.payload.type).toBe('tool_result')
      if (result.payload.type === 'tool_result') {
        expect(result.payload.isError).toBe(true)
        expect(result.payload.result).toEqual({ error: 'Something broke' })
      }
    })
  })

  describe('bridge()', () => {
    it('sends message through target adapter', async () => {
      const source = createMockAdapter('mcp')
      const target = createMockAdapter('a2a')

      const bridge = new ProtocolBridge({ source, target })
      const msg = makeToolCallMessage()

      await bridge.bridge(msg)

      expect(target.lastSent).toBeDefined()
      expect(target.lastSent!.protocol).toBe('a2a')
    })

    it('applies transform when provided', async () => {
      const source = createMockAdapter('mcp')
      const target = createMockAdapter('a2a')

      const bridge = new ProtocolBridge({
        source,
        target,
        transform: (message, direction) => {
          expect(direction).toBe('source-to-target')
          return ProtocolBridge.mcpToA2A(message)
        },
      })

      const msg = makeToolCallMessage()
      await bridge.bridge(msg)

      expect(target.lastSent).toBeDefined()
      expect(target.lastSent!.payload.type).toBe('task')
    })

    it('updates protocol field to target protocol', async () => {
      const source = createMockAdapter('mcp')
      const target = createMockAdapter('a2a')

      const bridge = new ProtocolBridge({ source, target })
      const msg = makeToolCallMessage()

      await bridge.bridge(msg)

      expect(target.lastSent!.protocol).toBe('a2a')
    })
  })

  describe('start()/stop() lifecycle', () => {
    it('subscribes on source adapter', () => {
      const source = createMockAdapter('mcp')
      const target = createMockAdapter('a2a')

      const bridge = new ProtocolBridge({ source, target })
      const handle = bridge.start('mcp://localhost/*')

      expect(source.subscribeMock).toHaveBeenCalledTimes(1)
      expect(source.subscribeMock).toHaveBeenCalledWith(
        'mcp://localhost/*',
        expect.any(Function),
      )

      handle.stop()
    })

    it('stop() tears down subscription', () => {
      const source = createMockAdapter('mcp')
      const target = createMockAdapter('a2a')

      // Track unsubscribe
      let unsubscribed = false
      source.subscribe = (_pattern: string, _handler: MessageHandler) => {
        return { unsubscribe: () => { unsubscribed = true } }
      }

      const bridge = new ProtocolBridge({ source, target })
      const handle = bridge.start('mcp://localhost/*')
      expect(unsubscribed).toBe(false)

      handle.stop()
      expect(unsubscribed).toBe(true)
    })

    it('forwards received messages to target', async () => {
      const source = createMockAdapter('mcp')
      const target = createMockAdapter('a2a')

      let capturedHandler: MessageHandler | undefined

      source.subscribe = (_pattern: string, handler: MessageHandler) => {
        capturedHandler = handler
        return { unsubscribe: () => {} }
      }

      const bridge = new ProtocolBridge({
        source,
        target,
        transform: ProtocolBridge.mcpToA2A,
      })
      bridge.start('mcp://localhost/*')

      // Simulate an incoming message
      expect(capturedHandler).toBeDefined()
      const msg = makeToolCallMessage()
      await capturedHandler!(msg)

      expect(target.lastSent).toBeDefined()
      expect(target.lastSent!.payload.type).toBe('task')
      expect(target.lastSent!.protocol).toBe('a2a')
    })
  })
})
