/**
 * A2AClientAdapter — ProtocolAdapter for Google A2A protocol communication.
 *
 * Translates ForgeMessage envelopes to/from A2A JSON-RPC task requests,
 * communicating with remote A2A-compatible agents over HTTP.
 *
 * A2A spec reference: https://github.com/google/A2A
 */
import type {
  ProtocolAdapter,
  AdapterState,
  AdapterHealthStatus,
  SendOptions,
  MessageHandler,
  Subscription,
} from './adapter.js'
import type { ForgeMessage, ForgePayload } from './message-types.js'
import { createForgeMessage, createMessageId } from './message-factory.js'
import { ForgeError } from '../errors/forge-error.js'
import { streamA2ATask } from './a2a-sse-stream.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface A2AClientConfig {
  /** Base URL of the A2A agent endpoint. */
  baseUrl?: string
  /** Default timeout in ms (default: 60000). */
  defaultTimeoutMs?: number
  /** Maximum retry attempts (default: 3). */
  maxRetries?: number
  /** Initial retry delay in ms (default: 1000). */
  retryDelayMs?: number
  /** Custom fetch function (for testing). */
  fetch?: typeof globalThis.fetch
}

// ---------------------------------------------------------------------------
// A2A JSON-RPC types (minimal subset)
// ---------------------------------------------------------------------------

/** A2A message part. */
interface A2AMessagePart {
  type: 'text' | 'data' | 'file'
  text?: string
  data?: Record<string, unknown>
  mimeType?: string
}

/** A2A message within a task. */
interface A2AMessage {
  role: 'user' | 'agent'
  parts: A2AMessagePart[]
}

/** A2A task status. */
interface A2ATaskStatus {
  state: 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed'
  message?: A2AMessage
}

/** A2A task object. */
interface A2ATask {
  id: string
  status: A2ATaskStatus
  artifacts?: Array<{
    parts: A2AMessagePart[]
    name?: string
  }>
}

/** A2A JSON-RPC response. */
interface A2AJsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: A2ATask
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

/**
 * Convert ForgePayload to A2A message parts.
 */
function forgePayloadToA2AParts(payload: ForgePayload): A2AMessagePart[] {
  switch (payload.type) {
    case 'text':
      return [{ type: 'text', text: payload.content }]
    case 'json':
      return [{ type: 'data', data: payload.data }]
    case 'task':
      return [{ type: 'text', text: payload.description }, ...(payload.context ? [{ type: 'data' as const, data: payload.context }] : [])]
    case 'tool_call':
      return [{ type: 'data', data: { toolName: payload.toolName, arguments: payload.arguments, callId: payload.callId } }]
    case 'tool_result':
      return [{ type: 'data', data: { callId: payload.callId, result: payload.result as Record<string, unknown> } }]
    case 'error':
      return [{ type: 'text', text: `Error [${payload.code}]: ${payload.message}` }]
    case 'binary':
      return [{ type: 'file', mimeType: payload.mimeType }]
  }
}

/**
 * Convert A2A task response to ForgePayload.
 */
function a2aTaskToForgePayload(task: A2ATask): ForgePayload {
  // Check status message first
  const statusMsg = task.status.message
  if (statusMsg) {
    const textParts = statusMsg.parts.filter((p) => p.type === 'text' && p.text)
    const dataParts = statusMsg.parts.filter((p) => p.type === 'data' && p.data)
    if (dataParts.length > 0 && dataParts[0]?.data) {
      return { type: 'json', data: dataParts[0].data }
    }
    if (textParts.length > 0 && textParts[0]?.text) {
      return { type: 'text', content: textParts[0].text }
    }
  }

  // Check artifacts
  if (task.artifacts && task.artifacts.length > 0) {
    const firstArtifact = task.artifacts[0]
    if (firstArtifact) {
      const textParts = firstArtifact.parts.filter((p) => p.type === 'text' && p.text)
      const dataParts = firstArtifact.parts.filter((p) => p.type === 'data' && p.data)
      if (dataParts.length > 0 && dataParts[0]?.data) {
        return { type: 'json', data: dataParts[0].data }
      }
      if (textParts.length > 0 && textParts[0]?.text) {
        return { type: 'text', content: textParts[0].text }
      }
    }
  }

  // Fallback: task completed with no message content
  return { type: 'text', content: `Task ${task.id} ${task.status.state}` }
}

/**
 * Resolve base URL from message.to URI or config.
 */
function resolveBaseUrl(uri: string, configBaseUrl?: string): string {
  if (configBaseUrl) return configBaseUrl
  // Convert a2a://host/path -> https://host/path
  if (uri.startsWith('a2a://')) {
    return 'https://' + uri.slice('a2a://'.length)
  }
  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    return uri
  }
  return uri
}

// ---------------------------------------------------------------------------
// A2AClientAdapter
// ---------------------------------------------------------------------------

export class A2AClientAdapter implements ProtocolAdapter {
  readonly protocol = 'a2a' as const
  private adapterState: AdapterState = 'disconnected'
  private readonly configBaseUrl: string | undefined
  private readonly defaultTimeoutMs: number
  private readonly maxRetries: number
  private readonly retryDelayMs: number
  private readonly fetchFn: typeof globalThis.fetch
  private lastError: string | undefined
  private lastConnectedAt: string | undefined

  constructor(config?: A2AClientConfig) {
    this.configBaseUrl = config?.baseUrl
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? 60_000
    this.maxRetries = config?.maxRetries ?? 3
    this.retryDelayMs = config?.retryDelayMs ?? 1_000
    this.fetchFn = config?.fetch ?? globalThis.fetch.bind(globalThis)
  }

  get state(): AdapterState {
    return this.adapterState
  }

  /**
   * Validate agent card endpoint reachability.
   */
  async connect(): Promise<void> {
    this.adapterState = 'connecting'
    try {
      const baseUrl = this.configBaseUrl ?? ''
      const url = baseUrl.endsWith('/')
        ? `${baseUrl}.well-known/agent.json`
        : `${baseUrl}/.well-known/agent.json`

      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      })

      if (!response.ok) {
        throw new ForgeError({
          code: 'PROTOCOL_CONNECTION_FAILED',
          message: `A2A agent card endpoint returned ${response.status}`,
          recoverable: true,
          context: { url, status: response.status },
        })
      }

      this.adapterState = 'connected'
      this.lastConnectedAt = new Date().toISOString()
    } catch (err) {
      this.adapterState = 'error'
      const message = err instanceof Error ? err.message : String(err)
      this.lastError = message
      if (ForgeError.is(err)) throw err
      throw new ForgeError({
        code: 'PROTOCOL_CONNECTION_FAILED',
        message: `Failed to connect to A2A endpoint: ${message}`,
        recoverable: true,
        ...(err instanceof Error && { cause: err }),
      })
    }
  }

  async disconnect(): Promise<void> {
    this.adapterState = 'disconnected'
  }

  /**
   * Send ForgeMessage as A2A task.
   *
   * Translates ForgeMessage -> A2A tasks/send JSON-RPC -> HTTP POST ->
   * A2A response -> ForgeMessage response.
   *
   * Retries on transient errors (5xx, network) with exponential backoff.
   */
  async send(message: ForgeMessage, options?: SendOptions): Promise<ForgeMessage> {
    const baseUrl = resolveBaseUrl(message.to, this.configBaseUrl)
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs
    const maxRetries = options?.retries ?? this.maxRetries

    const taskId = message.correlationId ?? createMessageId() as string
    const a2aRequest = {
      jsonrpc: '2.0' as const,
      id: taskId,
      method: 'tasks/send',
      params: {
        id: taskId,
        message: {
          role: 'user' as const,
          parts: forgePayloadToA2AParts(message.payload),
        },
      },
    }

    let lastErr: Error | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Check abort signal
      if (options?.signal?.aborted) {
        throw new ForgeError({
          code: 'PROTOCOL_SEND_FAILED',
          message: 'Send aborted by signal',
          recoverable: false,
        })
      }

      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)

        // Compose abort signal
        if (options?.signal) {
          options.signal.addEventListener('abort', () => controller.abort(), { once: true })
        }

        let response: Response
        try {
          response = await this.fetchFn(baseUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify(a2aRequest),
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timer)
        }

        // Non-transient error — don't retry
        if (!response.ok && response.status < 500) {
          const body = await response.text()
          throw new ForgeError({
            code: 'PROTOCOL_SEND_FAILED',
            message: `A2A request failed with status ${response.status}: ${body}`,
            recoverable: false,
            context: { status: response.status, body },
          })
        }

        // Transient error (5xx) — retry
        if (!response.ok) {
          throw new ForgeError({
            code: 'PROTOCOL_SEND_FAILED',
            message: `A2A request failed with status ${response.status}`,
            recoverable: true,
            context: { status: response.status },
          })
        }

        // Parse response
        const jsonResponse = (await response.json()) as A2AJsonRpcResponse
        if (jsonResponse.error) {
          throw new ForgeError({
            code: 'PROTOCOL_SEND_FAILED',
            message: `A2A JSON-RPC error: ${jsonResponse.error.message}`,
            recoverable: false,
            context: { errorCode: jsonResponse.error.code },
          })
        }

        if (!jsonResponse.result) {
          throw new ForgeError({
            code: 'PROTOCOL_SEND_FAILED',
            message: 'A2A response contained no result',
            recoverable: false,
          })
        }

        // Convert A2A task result to ForgeMessage
        this.adapterState = 'connected'
        return createForgeMessage({
          type: 'response',
          from: message.to,
          to: message.from,
          protocol: 'a2a',
          payload: a2aTaskToForgePayload(jsonResponse.result),
          correlationId: message.id,
          metadata: {
            a2aTaskId: jsonResponse.result.id,
            a2aTaskState: jsonResponse.result.status.state,
          },
        })
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err))

        // Don't retry non-recoverable errors
        if (ForgeError.is(err) && !err.recoverable) {
          throw err
        }

        // Don't retry if this was the last attempt
        if (attempt >= maxRetries) {
          break
        }

        // Exponential backoff
        const delay = this.retryDelayMs * Math.pow(2, attempt)
        await sleep(delay, options?.signal)
      }
    }

    this.adapterState = 'error'
    this.lastError = lastErr?.message ?? 'Unknown error'
    throw ForgeError.wrap(lastErr ?? new Error('Unknown error'), {
      code: 'PROTOCOL_SEND_FAILED',
      recoverable: false,
      context: { retriesExhausted: maxRetries },
    })
  }

  /**
   * Stream A2A task updates via SSE.
   *
   * Submits the task via send(), then streams updates from the
   * A2A SSE endpoint using streamA2ATask().
   */
  async *stream(message: ForgeMessage, options?: SendOptions): AsyncIterable<ForgeMessage> {
    // Submit the task first
    const response = await this.send(message, options)
    yield response

    // Extract task ID from the response metadata
    const taskId = response.metadata['a2aTaskId']
    if (typeof taskId !== 'string') {
      return
    }

    // If the task already completed in the send response, no need to stream
    const taskState = response.metadata['a2aTaskState']
    if (taskState === 'completed' || taskState === 'failed' || taskState === 'canceled') {
      return
    }

    // Stream updates via SSE
    const baseUrl = resolveBaseUrl(message.to, this.configBaseUrl)
    yield* streamA2ATask(baseUrl, taskId, {
      ...(options?.signal !== undefined && { signal: options.signal }),
      fetch: this.fetchFn,
      maxReconnects: this.maxRetries,
      reconnectDelayMs: this.retryDelayMs,
    })
  }

  /**
   * Subscribe to incoming messages.
   *
   * A2A is a client-side protocol — subscriptions are not natively supported.
   * This is a no-op that returns an empty subscription.
   */
  subscribe(_pattern: string, _handler: MessageHandler): Subscription {
    // A2A is request-driven, no server-push subscription model.
    return {
      unsubscribe: () => {
        // No-op
      },
    }
  }

  health(): AdapterHealthStatus {
    return {
      state: this.adapterState,
      ...(this.lastError !== undefined && { lastError: this.lastError }),
      ...(this.lastConnectedAt !== undefined && { lastConnectedAt: this.lastConnectedAt }),
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sleep for the given duration, respecting an optional abort signal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new ForgeError({
          code: 'PROTOCOL_SEND_FAILED',
          message: 'Send aborted during retry delay',
          recoverable: false,
        }),
      )
      return
    }

    const timer = setTimeout(resolve, ms)

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(
          new ForgeError({
            code: 'PROTOCOL_SEND_FAILED',
            message: 'Send aborted during retry delay',
            recoverable: false,
          }),
        )
      },
      { once: true },
    )
  })
}
