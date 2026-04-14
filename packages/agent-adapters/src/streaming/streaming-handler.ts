/**
 * StreamingHandler — transforms adapter event streams into structured
 * output formats suitable for real-time UIs, SSE endpoints, and WebSocket
 * connections.
 *
 * Consumes an AsyncGenerator<AgentEvent> and produces either structured
 * StreamOutputEvent objects or serialized strings in SSE/JSONL/NDJSON format.
 */

import type { DzupEventBus } from '@dzupagent/core'

import type {
  AgentCompletedEvent,
  AgentEvent,
  AgentFailedEvent,
  AgentMessageEvent,
  AgentStartedEvent,
  AgentStreamDeltaEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
} from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StreamFormat = 'sse' | 'jsonl' | 'ndjson'

export interface StreamingConfig {
  /** Output format. Default: 'jsonl' */
  format?: StreamFormat
  /** Whether to include tool call details. Default true */
  includeToolCalls?: boolean
  /** Whether to include raw events. Default false */
  includeRawEvents?: boolean
  /** Whether to track and emit progress updates. Default true */
  trackProgress?: boolean
  /** Event bus for observability */
  eventBus?: DzupEventBus | undefined
}

/** Structured output event for UIs */
export interface StreamOutputEvent {
  /** Event type for UI routing */
  type: 'status' | 'content' | 'tool_call' | 'tool_result' | 'progress' | 'error' | 'done'
  /** ISO timestamp */
  timestamp: string
  /** The data payload */
  data: StreamEventData
}

export type StreamEventData =
  | StatusData
  | ContentData
  | ToolCallData
  | ToolResultData
  | ProgressData
  | ErrorData
  | DoneData

export interface StatusData {
  type: 'status'
  status: 'started' | 'running' | 'completed' | 'failed'
  providerId?: string | undefined
  sessionId?: string | undefined
}

export interface ContentData {
  type: 'content'
  text: string
  role: 'assistant' | 'user' | 'system'
}

export interface ToolCallData {
  type: 'tool_call'
  name: string
  input: unknown
}

export interface ToolResultData {
  type: 'tool_result'
  name: string
  output: string
  durationMs: number
}

export interface ProgressData {
  type: 'progress'
  percent: number
  currentStep?: string | undefined
  totalSteps?: number | undefined
  tokensUsed?: number | undefined
}

export interface ErrorData {
  type: 'error'
  message: string
  code?: string | undefined
  recoverable: boolean
}

export interface DoneData {
  type: 'done'
  result: string
  durationMs: number
  usage?: { inputTokens: number; outputTokens: number } | undefined
}

/** Progress tracking state */
export interface ProgressState {
  totalEvents: number
  toolCallCount: number
  messageCount: number
  startTime: number
  lastEventTime: number
  estimatedPercent: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Assumed typical tool call count for progress estimation */
const TYPICAL_TOOL_CALLS = 10

/** Progress range allocated to the tool-calling phase (30% - 80%) */
const TOOL_PHASE_START = 30
const TOOL_PHASE_END = 80

// ---------------------------------------------------------------------------
// StreamingHandler
// ---------------------------------------------------------------------------

export class StreamingHandler {
  private readonly config: Required<
    Pick<StreamingConfig, 'format' | 'includeToolCalls' | 'includeRawEvents' | 'trackProgress'>
  > & { eventBus?: DzupEventBus | undefined }

  private progress: ProgressState

  constructor(config?: StreamingConfig) {
    this.config = {
      format: config?.format ?? 'jsonl',
      includeToolCalls: config?.includeToolCalls ?? true,
      includeRawEvents: config?.includeRawEvents ?? false,
      trackProgress: config?.trackProgress ?? true,
      eventBus: config?.eventBus,
    }
    this.progress = StreamingHandler.createInitialProgress()
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Transform an adapter event stream into formatted output events.
   * Yields StreamOutputEvent objects.
   */
  async *transform(
    source: AsyncGenerator<AgentEvent, void, undefined>,
  ): AsyncGenerator<StreamOutputEvent, void, undefined> {
    for await (const event of source) {
      this.updateProgress(event)

      const outputEvents = this.mapEvent(event)
      for (const outputEvent of outputEvents) {
        this.emitObservability(outputEvent)
        yield outputEvent
      }
    }
  }

  /**
   * Transform and serialize to the configured format.
   * Yields formatted strings (SSE, JSONL, or NDJSON).
   */
  async *serialize(
    source: AsyncGenerator<AgentEvent, void, undefined>,
  ): AsyncGenerator<string, void, undefined> {
    for await (const outputEvent of this.transform(source)) {
      yield this.formatEvent(outputEvent)
    }
  }

  /**
   * Create a ReadableStream from adapter events (for Web API compatibility).
   */
  toReadableStream(source: AsyncGenerator<AgentEvent, void, undefined>): ReadableStream<string> {
    const serializer = this.serialize(source)

    return new ReadableStream<string>({
      async pull(controller) {
        const { value, done } = await serializer.next()
        if (done) {
          controller.close()
        } else {
          controller.enqueue(value)
        }
      },
      cancel() {
        // Best-effort return on the generator
        void serializer.return(undefined)
      },
    })
  }

  /** Get current progress state */
  getProgress(): ProgressState {
    return { ...this.progress }
  }

  /** Reset progress tracking */
  reset(): void {
    this.progress = StreamingHandler.createInitialProgress()
  }

  // -------------------------------------------------------------------------
  // Internal: event mapping
  // -------------------------------------------------------------------------

  private mapEvent(event: AgentEvent): StreamOutputEvent[] {
    const events: StreamOutputEvent[] = []

    switch (event.type) {
      case 'adapter:started':
        events.push(this.mapStarted(event))
        break

      case 'adapter:message':
        events.push(this.mapMessage(event))
        break

      case 'adapter:tool_call':
        if (this.config.includeToolCalls) {
          events.push(this.mapToolCall(event))
        }
        break

      case 'adapter:tool_result':
        if (this.config.includeToolCalls) {
          events.push(this.mapToolResult(event))
        }
        break

      case 'adapter:stream_delta':
        events.push(this.mapStreamDelta(event))
        break

      case 'adapter:completed':
        events.push(this.mapCompleted(event))
        break

      case 'adapter:failed':
        events.push(this.mapFailed(event))
        break
    }

    // Emit progress event after every source event when tracking is enabled
    if (this.config.trackProgress && event.type !== 'adapter:completed' && event.type !== 'adapter:failed') {
      events.push(this.createProgressEvent())
    }

    return events
  }

  private mapStarted(event: AgentStartedEvent): StreamOutputEvent {
    return this.createOutputEvent('status', {
      type: 'status',
      status: 'started',
      providerId: event.providerId,
      sessionId: event.sessionId,
    })
  }

  private mapMessage(event: AgentMessageEvent): StreamOutputEvent {
    return this.createOutputEvent('content', {
      type: 'content',
      text: event.content,
      role: event.role,
    })
  }

  private mapToolCall(event: AgentToolCallEvent): StreamOutputEvent {
    return this.createOutputEvent('tool_call', {
      type: 'tool_call',
      name: event.toolName,
      input: event.input,
    })
  }

  private mapToolResult(event: AgentToolResultEvent): StreamOutputEvent {
    return this.createOutputEvent('tool_result', {
      type: 'tool_result',
      name: event.toolName,
      output: event.output,
      durationMs: event.durationMs,
    })
  }

  private mapStreamDelta(event: AgentStreamDeltaEvent): StreamOutputEvent {
    return this.createOutputEvent('content', {
      type: 'content',
      text: event.content,
      role: 'assistant',
    })
  }

  private mapCompleted(event: AgentCompletedEvent): StreamOutputEvent {
    const usage = event.usage
      ? { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens }
      : undefined

    return this.createOutputEvent('done', {
      type: 'done',
      result: event.result,
      durationMs: event.durationMs,
      usage,
    })
  }

  private mapFailed(event: AgentFailedEvent): StreamOutputEvent {
    return this.createOutputEvent('error', {
      type: 'error',
      message: event.error,
      code: event.code,
      recoverable: false,
    })
  }

  // -------------------------------------------------------------------------
  // Internal: progress tracking
  // -------------------------------------------------------------------------

  private updateProgress(event: AgentEvent): void {
    const now = Date.now()
    this.progress.totalEvents++
    this.progress.lastEventTime = now

    if (this.progress.startTime === 0) {
      this.progress.startTime = now
    }

    switch (event.type) {
      case 'adapter:started':
        this.progress.estimatedPercent = 5
        break

      case 'adapter:message':
        this.progress.messageCount++
        if (this.progress.estimatedPercent < 20) {
          this.progress.estimatedPercent = 20
        }
        break

      case 'adapter:tool_call':
        this.progress.toolCallCount++
        this.progress.estimatedPercent = this.estimateToolProgress()
        break

      case 'adapter:tool_result':
        // Progress already advanced by tool_call; small bump for result
        this.progress.estimatedPercent = Math.min(
          this.progress.estimatedPercent + 2,
          TOOL_PHASE_END,
        )
        break

      case 'adapter:stream_delta':
        if (this.progress.estimatedPercent < 20) {
          this.progress.estimatedPercent = 20
        }
        break

      case 'adapter:completed':
        this.progress.estimatedPercent = 100
        break

      case 'adapter:failed':
        this.progress.estimatedPercent = 100
        break
    }
  }

  /**
   * Estimate progress during the tool-calling phase.
   * Maps tool call count to the 30%–80% range assuming ~TYPICAL_TOOL_CALLS total.
   */
  private estimateToolProgress(): number {
    const ratio = Math.min(this.progress.toolCallCount / TYPICAL_TOOL_CALLS, 1)
    return Math.round(TOOL_PHASE_START + ratio * (TOOL_PHASE_END - TOOL_PHASE_START))
  }

  private createProgressEvent(): StreamOutputEvent {
    return this.createOutputEvent('progress', {
      type: 'progress',
      percent: this.progress.estimatedPercent,
      currentStep: this.describeCurrentStep(),
      totalSteps: undefined,
      tokensUsed: undefined,
    })
  }

  private describeCurrentStep(): string {
    if (this.progress.estimatedPercent <= 5) return 'initializing'
    if (this.progress.toolCallCount > 0) return `tool call #${this.progress.toolCallCount}`
    if (this.progress.messageCount > 0) return 'generating response'
    return 'processing'
  }

  // -------------------------------------------------------------------------
  // Internal: serialization
  // -------------------------------------------------------------------------

  private formatEvent(event: StreamOutputEvent): string {
    const json = JSON.stringify(event)

    const fmt = this.config.format
    switch (fmt) {
      case 'sse':
        return `data: ${json}\n\n`
      case 'jsonl':
      case 'ndjson':
      default:
        return `${json}\n`
    }
  }

  // -------------------------------------------------------------------------
  // Internal: observability
  // -------------------------------------------------------------------------

  private emitObservability(event: StreamOutputEvent): void {
    if (!this.config.eventBus) return

    try {
      this.config.eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'streaming-handler',
        runId: 'streaming',
        content: `[${event.type}] ${this.summarizeData(event.data)}`,
      })
    } catch {
      // Observability failures are non-fatal — silently continue
    }
  }

  private summarizeData(data: StreamEventData): string {
    switch (data.type) {
      case 'status':
        return data.status
      case 'content':
        return data.text.slice(0, 80)
      case 'tool_call':
        return data.name
      case 'tool_result':
        return `${data.name} (${data.durationMs}ms)`
      case 'progress':
        return `${data.percent}%`
      case 'error':
        return data.message.slice(0, 80)
      case 'done':
        return `completed (${data.durationMs}ms)`
    }
  }

  // -------------------------------------------------------------------------
  // Internal: helpers
  // -------------------------------------------------------------------------

  private createOutputEvent(
    type: StreamOutputEvent['type'],
    data: StreamEventData,
  ): StreamOutputEvent {
    return {
      type,
      timestamp: new Date().toISOString(),
      data,
    }
  }

  private static createInitialProgress(): ProgressState {
    return {
      totalEvents: 0,
      toolCallCount: 0,
      messageCount: 0,
      startTime: 0,
      lastEventTime: 0,
      estimatedPercent: 0,
    }
  }
}
