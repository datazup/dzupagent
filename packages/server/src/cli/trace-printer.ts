/**
 * TracePrinter — Pretty-prints DzupEventBus events to stdout.
 *
 * Format: [HH:MM:SS] [runId] event_type — details
 *
 * In verbose mode, includes full event data as JSON.
 */
import type { DzupEventBus, DzupEvent } from '@dzupagent/core'

export class TracePrinter {
  private unsubscribe: (() => void) | null = null

  constructor(private readonly verbose: boolean = false) {}

  /** Subscribe to all events on the bus and print them. */
  attach(eventBus: DzupEventBus): void {
    this.detach()
    this.unsubscribe = eventBus.onAny((event) => {
      this.printEvent(event)
    })
  }

  /** Stop listening to events. */
  detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  /** Format a single event for display. Exposed for testing. */
  formatEvent(event: DzupEvent): string {
    const now = new Date()
    const time = formatTime(now)
    const runId = extractRunId(event)
    const runTag = runId ? `[${runId.slice(0, 8)}]` : '[--------]'
    const details = extractDetails(event)

    let line = `[${time}] ${runTag} ${event.type}`
    if (details) {
      line += ` -- ${details}`
    }

    if (this.verbose) {
      line += `\n  ${JSON.stringify(event, null, 2).split('\n').join('\n  ')}`
    }

    return line
  }

  private printEvent(event: DzupEvent): void {
    const line = this.formatEvent(event)
     
    console.log(line)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

function extractRunId(event: DzupEvent): string | undefined {
  if ('runId' in event) {
    return (event as { runId: string }).runId
  }
  return undefined
}

function extractDetails(event: DzupEvent): string {
  switch (event.type) {
    case 'agent:started':
      return `agent=${event.agentId}`
    case 'agent:completed':
      return `agent=${event.agentId} duration=${event.durationMs}ms`
    case 'agent:failed':
      return `agent=${event.agentId} error=${event.errorCode}: ${event.message}`
    case 'tool:called':
      return `tool=${event.toolName}`
    case 'tool:result':
      return `tool=${event.toolName} duration=${event.durationMs}ms`
    case 'tool:error':
      return `tool=${event.toolName} error=${event.errorCode}: ${event.message}`
    case 'memory:written':
      return `ns=${event.namespace} key=${event.key}`
    case 'memory:searched':
      return `ns=${event.namespace} query="${event.query}" results=${event.resultCount}`
    case 'memory:error':
      return `ns=${event.namespace} ${event.message}`
    case 'budget:warning':
      return `level=${event.level} ${event.usage.percent}%`
    case 'budget:exceeded':
      return event.reason
    case 'pipeline:phase_changed':
      return `${event.previousPhase} -> ${event.phase}`
    case 'pipeline:validation_failed':
      return `phase=${event.phase} errors=${event.errors.length}`
    case 'approval:requested':
      return `runId=${event.runId}`
    case 'approval:granted':
      return `runId=${event.runId}${event.approvedBy ? ` by=${event.approvedBy}` : ''}`
    case 'approval:rejected':
      return `runId=${event.runId}${event.reason ? ` reason="${event.reason}"` : ''}`
    case 'mcp:connected':
      return `server=${event.serverName} tools=${event.toolCount}`
    case 'mcp:disconnected':
      return `server=${event.serverName}`
    case 'provider:failed':
      return `provider=${event.provider} ${event.message}`
    case 'provider:circuit_opened':
    case 'provider:circuit_closed':
      return `provider=${event.provider}`
    default:
      return ''
  }
}
