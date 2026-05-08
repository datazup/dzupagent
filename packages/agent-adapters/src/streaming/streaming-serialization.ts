import type {
  StreamEventData,
  StreamFormat,
  StreamOutputEvent,
} from './streaming-handler-types.js'

export function formatStreamOutputEvent(event: StreamOutputEvent, format: StreamFormat): string {
  const json = JSON.stringify(event)

  switch (format) {
    case 'sse':
      return `data: ${json}\n\n`
    case 'jsonl':
    case 'ndjson':
    default:
      return `${json}\n`
  }
}

export function summarizeStreamEventData(data: StreamEventData): string {
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
