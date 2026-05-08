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
import { createStreamingProgressEvent } from './streaming-progress.js'
import type {
  ProgressState,
  ResolvedStreamingConfig,
  StreamEventData,
  StreamOutputEvent,
} from './streaming-handler-types.js'

export function mapStreamingEvent(
  event: AgentEvent,
  config: Pick<ResolvedStreamingConfig, 'includeToolCalls' | 'trackProgress'>,
  progress: ProgressState,
): StreamOutputEvent[] {
  const events: StreamOutputEvent[] = []

  switch (event.type) {
    case 'adapter:started':
      events.push(mapStarted(event))
      break

    case 'adapter:message':
      events.push(mapMessage(event))
      break

    case 'adapter:tool_call':
      if (config.includeToolCalls) {
        events.push(mapToolCall(event))
      }
      break

    case 'adapter:tool_result':
      if (config.includeToolCalls) {
        events.push(mapToolResult(event))
      }
      break

    case 'adapter:stream_delta':
      events.push(mapStreamDelta(event))
      break

    case 'adapter:completed':
      events.push(mapCompleted(event))
      break

    case 'adapter:failed':
      events.push(mapFailed(event))
      break
  }

  if (config.trackProgress && event.type !== 'adapter:completed' && event.type !== 'adapter:failed') {
    events.push(createStreamingProgressEvent(progress))
  }

  return events
}

export function createStreamOutputEvent(
  type: StreamOutputEvent['type'],
  data: StreamEventData,
): StreamOutputEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    data,
  }
}

function mapStarted(event: AgentStartedEvent): StreamOutputEvent {
  return createStreamOutputEvent('status', {
    type: 'status',
    status: 'started',
    providerId: event.providerId,
    sessionId: event.sessionId,
  })
}

function mapMessage(event: AgentMessageEvent): StreamOutputEvent {
  return createStreamOutputEvent('content', {
    type: 'content',
    text: event.content,
    role: event.role,
  })
}

function mapToolCall(event: AgentToolCallEvent): StreamOutputEvent {
  return createStreamOutputEvent('tool_call', {
    type: 'tool_call',
    name: event.toolName,
    input: event.input,
  })
}

function mapToolResult(event: AgentToolResultEvent): StreamOutputEvent {
  return createStreamOutputEvent('tool_result', {
    type: 'tool_result',
    name: event.toolName,
    output: event.output,
    durationMs: event.durationMs,
  })
}

function mapStreamDelta(event: AgentStreamDeltaEvent): StreamOutputEvent {
  return createStreamOutputEvent('content', {
    type: 'content',
    text: event.content,
    role: 'assistant',
  })
}

function mapCompleted(event: AgentCompletedEvent): StreamOutputEvent {
  const usage = event.usage
    ? { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens }
    : undefined

  return createStreamOutputEvent('done', {
    type: 'done',
    result: event.result,
    durationMs: event.durationMs,
    usage,
  })
}

function mapFailed(event: AgentFailedEvent): StreamOutputEvent {
  return createStreamOutputEvent('error', {
    type: 'error',
    message: event.error,
    code: event.code,
    recoverable: false,
  })
}
