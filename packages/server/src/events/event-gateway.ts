import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

export interface EventEnvelope {
  id: string
  version: 'v1'
  type: DzupEvent['type']
  timestamp: string
  runId?: string
  agentId?: string
  compileId?: string
  payload: DzupEvent
}

export interface EventSubscriptionFilter {
  runId?: string
  agentId?: string
  compileId?: string
  eventTypes?: DzupEvent['type'][]
}

export type EventSink = (event: EventEnvelope) => boolean | void

export interface EventSubscription {
  id: string
  unsubscribe(): void
}

export interface EventGateway {
  subscribe(
    filter: EventSubscriptionFilter,
    sink: EventSink,
    options?: { maxQueueSize?: number; overflowStrategy?: OverflowStrategy },
  ): EventSubscription
  publish(event: DzupEvent): void
  readonly subscriberCount: number
  destroy(): void
}

export type OverflowStrategy = 'drop_oldest' | 'drop_new' | 'disconnect'

interface InternalSubscription {
  id: string
  filter: EventSubscriptionFilter
  sink: EventSink
  queue: EventEnvelope[]
  draining: boolean
  maxQueueSize: number
  overflowStrategy: OverflowStrategy
}

export interface InMemoryEventGatewayConfig {
  maxQueueSize?: number
  overflowStrategy?: OverflowStrategy
}

let globalEnvelopeCounter = 0

function toEnvelope(event: DzupEvent): EventEnvelope {
  const hasRunId = 'runId' in event && typeof (event as { runId?: unknown }).runId === 'string'
  const hasAgentId = 'agentId' in event && typeof (event as { agentId?: unknown }).agentId === 'string'
  const hasCompileId = 'compileId' in event && typeof (event as { compileId?: unknown }).compileId === 'string'
  return {
    id: `evt-${Date.now()}-${++globalEnvelopeCounter}`,
    version: 'v1',
    type: event.type,
    timestamp: new Date().toISOString(),
    runId: hasRunId ? (event as { runId: string }).runId : undefined,
    agentId: hasAgentId ? (event as { agentId: string }).agentId : undefined,
    compileId: hasCompileId ? (event as { compileId: string }).compileId : undefined,
    payload: event,
  }
}

function matchesFilter(envelope: EventEnvelope, filter: EventSubscriptionFilter): boolean {
  if (filter.runId && envelope.runId !== filter.runId) return false
  if (filter.agentId && envelope.agentId !== filter.agentId) return false
  if (filter.compileId && envelope.compileId !== filter.compileId) return false
  if (filter.eventTypes) {
    // Explicit empty list means deny-all (useful as a safe baseline before scoped subscribe).
    if (filter.eventTypes.length === 0) return false
    if (!filter.eventTypes.includes(envelope.type)) return false
  }
  return true
}

export class InMemoryEventGateway implements EventGateway {
  private readonly subscriptions = new Map<string, InternalSubscription>()
  private eventBusUnsubscribe: (() => void) | null = null
  private subscriptionCounter = 0
  private readonly defaultMaxQueueSize: number
  private readonly defaultOverflowStrategy: OverflowStrategy

  constructor(eventBus?: DzupEventBus, config?: InMemoryEventGatewayConfig) {
    this.defaultMaxQueueSize = config?.maxQueueSize ?? 256
    this.defaultOverflowStrategy = config?.overflowStrategy ?? 'drop_oldest'

    if (eventBus) {
      this.eventBusUnsubscribe = eventBus.onAny((event) => this.publish(event))
    }
  }

  subscribe(
    filter: EventSubscriptionFilter,
    sink: EventSink,
    options?: { maxQueueSize?: number; overflowStrategy?: OverflowStrategy },
  ): EventSubscription {
    const id = `sub-${++this.subscriptionCounter}`
    const sub: InternalSubscription = {
      id,
      filter,
      sink,
      queue: [],
      draining: false,
      maxQueueSize: options?.maxQueueSize ?? this.defaultMaxQueueSize,
      overflowStrategy: options?.overflowStrategy ?? this.defaultOverflowStrategy,
    }
    this.subscriptions.set(id, sub)
    return {
      id,
      unsubscribe: () => {
        this.subscriptions.delete(id)
      },
    }
  }

  publish(event: DzupEvent): void {
    const envelope = toEnvelope(event)
    for (const sub of this.subscriptions.values()) {
      if (!matchesFilter(envelope, sub.filter)) continue
      if (sub.queue.length >= sub.maxQueueSize) {
        if (sub.overflowStrategy === 'disconnect') {
          this.subscriptions.delete(sub.id)
          continue
        }
        if (sub.overflowStrategy === 'drop_new') {
          continue
        }
        sub.queue.shift()
      }
      sub.queue.push(envelope)
      this.drain(sub)
    }
  }

  private drain(sub: InternalSubscription): void {
    if (sub.draining) return
    sub.draining = true
    queueMicrotask(() => {
      sub.draining = false
      if (!this.subscriptions.has(sub.id)) return

      while (sub.queue.length > 0) {
        const event = sub.queue.shift()
        if (!event) continue

        const keep = sub.sink(event)
        if (keep === false) {
          this.subscriptions.delete(sub.id)
          break
        }
      }
    })
  }

  get subscriberCount(): number {
    return this.subscriptions.size
  }

  destroy(): void {
    if (this.eventBusUnsubscribe) {
      this.eventBusUnsubscribe()
      this.eventBusUnsubscribe = null
    }
    this.subscriptions.clear()
  }
}
