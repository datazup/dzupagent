/**
 * StreamingHandler — transforms adapter event streams into structured
 * output formats suitable for real-time UIs, SSE endpoints, and WebSocket
 * connections.
 *
 * Consumes an AsyncGenerator<AgentEvent> and produces either structured
 * StreamOutputEvent objects or serialized strings in SSE/JSONL/NDJSON format.
 */

import type { AgentEvent } from '../types.js'
import { mapStreamingEvent } from './streaming-event-mapper.js'
import type {
  ProgressState,
  ResolvedStreamingConfig,
  StreamOutputEvent,
  StreamingConfig,
} from './streaming-handler-types.js'
import {
  createInitialStreamingProgress,
  updateStreamingProgress,
} from './streaming-progress.js'
import {
  formatStreamOutputEvent,
  summarizeStreamEventData,
} from './streaming-serialization.js'

export type {
  ContentData,
  DoneData,
  ErrorData,
  ProgressData,
  ProgressState,
  StatusData,
  StreamEventData,
  StreamFormat,
  StreamingConfig,
  StreamOutputEvent,
  ToolCallData,
  ToolResultData,
} from './streaming-handler-types.js'

// ---------------------------------------------------------------------------
// StreamingHandler
// ---------------------------------------------------------------------------

export class StreamingHandler {
  private readonly config: ResolvedStreamingConfig

  private progress: ProgressState

  constructor(config?: StreamingConfig) {
    this.config = {
      format: config?.format ?? 'jsonl',
      includeToolCalls: config?.includeToolCalls ?? true,
      includeRawEvents: config?.includeRawEvents ?? false,
      trackProgress: config?.trackProgress ?? true,
      eventBus: config?.eventBus,
    }
    this.progress = createInitialStreamingProgress()
  }

  /**
   * Transform an adapter event stream into formatted output events.
   * Yields StreamOutputEvent objects.
   */
  async *transform(
    source: AsyncGenerator<AgentEvent, void, undefined>,
  ): AsyncGenerator<StreamOutputEvent, void, undefined> {
    for await (const event of source) {
      updateStreamingProgress(this.progress, event)

      const outputEvents = mapStreamingEvent(event, this.config, this.progress)
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
      yield formatStreamOutputEvent(outputEvent, this.config.format)
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
    this.progress = createInitialStreamingProgress()
  }

  private emitObservability(event: StreamOutputEvent): void {
    if (!this.config.eventBus) return

    try {
      this.config.eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'streaming-handler',
        runId: 'streaming',
        content: `[${event.type}] ${summarizeStreamEventData(event.data)}`,
      })
    } catch {
      // Observability failures are non-fatal.
    }
  }
}
