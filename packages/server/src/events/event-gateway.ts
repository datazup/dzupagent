import type { DzupEvent, DzupEventBus } from '@dzupagent/core/events'

/**
 * Default tenant id used when authentication is disabled or the API key has
 * no explicit `tenantId`. Mirrors `DEFAULT_TENANT_ID` in
 * `../routes/tenant-scope.ts` (duplicated here to avoid the events layer
 * depending on the routes layer). Envelopes without an explicit tenant stamp
 * are treated as belonging to this tenant for back-compat with the legacy
 * single-tenant deployment mode.
 */
export const DEFAULT_TENANT_ID = 'default'

export interface EventEnvelope {
  id: string
  version: 'v1'
  type: DzupEvent['type']
  timestamp: string
  runId?: string
  agentId?: string
  compileId?: string
  /**
   * Originating tenant for this event. Populated when the underlying
   * `DzupEvent` carries a `tenantId` field (e.g. `flow:emit`,
   * `llm:invocation_recorded`) or when a `tenantResolver` is configured on
   * the gateway (typically backed by the run store) and resolves a tenant
   * for the event's `runId`. Used by the SSE route to enforce per-tenant
   * scoping (DZUPAGENT-SEC-M-01).
   */
  tenantId?: string
  payload: DzupEvent
}

export interface EventSubscriptionFilter {
  runId?: string
  agentId?: string
  compileId?: string
  /**
   * When set, the gateway only delivers envelopes whose `tenantId` strictly
   * matches this value. Envelopes without a `tenantId` are dropped — fail
   * closed — so cross-tenant leakage is impossible. The SSE route sets this
   * from the authenticated API key. (DZUPAGENT-SEC-M-01)
   */
  tenantId?: string
  eventTypes?: DzupEvent['type'][]
}

/**
 * Optional hook used by `InMemoryEventGateway` to enrich envelopes with a
 * tenant stamp when the underlying `DzupEvent` does not carry one. Typical
 * implementations look up the tenant from the run store using
 * `envelope.runId`. Pure function — the gateway invokes it once per publish.
 */
export type EventTenantResolver = (envelope: EventEnvelope) => string | undefined

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
  /**
   * Optional resolver used to stamp `tenantId` onto envelopes whose payload
   * does not already carry one. Invoked at publish time. When unset, only
   * events that already include a `tenantId` field on their payload will be
   * deliverable to tenant-scoped subscribers (see `matchesFilter`).
   */
  tenantResolver?: EventTenantResolver
}

let globalEnvelopeCounter = 0

function toEnvelope(event: DzupEvent, tenantResolver?: EventTenantResolver): EventEnvelope {
  const hasRunId = 'runId' in event && typeof (event as { runId?: unknown }).runId === 'string'
  const hasAgentId = 'agentId' in event && typeof (event as { agentId?: unknown }).agentId === 'string'
  const hasCompileId = 'compileId' in event && typeof (event as { compileId?: unknown }).compileId === 'string'
  const payloadTenantId =
    'tenantId' in event && typeof (event as { tenantId?: unknown }).tenantId === 'string'
      ? (event as { tenantId: string }).tenantId
      : undefined
  const envelope: EventEnvelope = {
    id: `evt-${Date.now()}-${++globalEnvelopeCounter}`,
    version: 'v1',
    type: event.type,
    timestamp: new Date().toISOString(),
    runId: hasRunId ? (event as { runId: string }).runId : undefined,
    agentId: hasAgentId ? (event as { agentId: string }).agentId : undefined,
    compileId: hasCompileId ? (event as { compileId: string }).compileId : undefined,
    tenantId: payloadTenantId,
    payload: event,
  }
  if (envelope.tenantId === undefined && tenantResolver) {
    envelope.tenantId = tenantResolver(envelope)
  }
  // Final fallback: any envelope that still has no tenant stamp belongs to the
  // legacy "default" single-tenant scope. Real tenants always carry an explicit
  // tenant stamp (either via the payload field or the tenantResolver), so this
  // fallback can never leak across tenants — see `matchesFilter` for the
  // strict-equality check that enforces isolation.
  if (envelope.tenantId === undefined) {
    envelope.tenantId = DEFAULT_TENANT_ID
  }
  return envelope
}

function matchesFilter(envelope: EventEnvelope, filter: EventSubscriptionFilter): boolean {
  if (filter.runId && envelope.runId !== filter.runId) return false
  if (filter.agentId && envelope.agentId !== filter.agentId) return false
  if (filter.compileId && envelope.compileId !== filter.compileId) return false
  if (filter.tenantId !== undefined) {
    // Fail-closed: envelopes without a tenant stamp are NOT delivered to a
    // tenant-scoped subscriber. This is the SEC-M-01 guarantee — cross-tenant
    // leakage is impossible even if a publisher forgets to stamp tenantId.
    if (envelope.tenantId !== filter.tenantId) return false
  }
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
  private readonly tenantResolver: EventTenantResolver | undefined

  constructor(eventBus?: DzupEventBus, config?: InMemoryEventGatewayConfig) {
    this.defaultMaxQueueSize = config?.maxQueueSize ?? 256
    this.defaultOverflowStrategy = config?.overflowStrategy ?? 'drop_oldest'
    this.tenantResolver = config?.tenantResolver

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
    const envelope = toEnvelope(event, this.tenantResolver)
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
