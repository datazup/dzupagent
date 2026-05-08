/**
 * Subscription fan-out and event-bus forwarding for the in-memory registry.
 *
 * Extracted helpers around the registry event lifecycle:
 *  - `matchesFilter` decides whether an event matches a subscription filter.
 *  - `dispatchRegistryEvent` notifies in-process subscriptions and forwards
 *    to an optional `DzupEventBus`.
 *
 * Subscription handler errors are intentionally swallowed — handlers are
 * non-fatal to the registry, matching the contract documented on
 * `AgentRegistry.subscribe`.
 */
import type { DzupEventBus } from '../events/event-bus.js'
import type { DzupEvent } from '../events/event-types.js'
import type { Subscription } from './in-memory-registry-types.js'
import type { RegistryEvent, RegistrySubscriptionFilter } from './types.js'

/** Check if an event matches a subscription filter. */
export function matchesFilter(
  filter: RegistrySubscriptionFilter,
  event: RegistryEvent,
): boolean {
  if (filter.eventTypes && filter.eventTypes.length > 0) {
    if (!filter.eventTypes.includes(event.type)) return false
  }

  if (filter.agentIds && filter.agentIds.length > 0) {
    if (!filter.agentIds.includes(event.agentId)) return false
  }

  if (filter.capabilities && filter.capabilities.length > 0) {
    if (event.type === 'registry:capability_added') {
      if (!filter.capabilities.includes(event.capability)) return false
    }
    // For non-capability events, the capability filter doesn't exclude
  }

  return true
}

/**
 * Notify all matching subscriptions and optionally forward to a `DzupEventBus`.
 *
 * Handler errors are swallowed so that one misbehaving subscriber cannot
 * disrupt registry operations or other subscribers.
 */
export function dispatchRegistryEvent(
  subscriptions: ReadonlySet<Subscription>,
  eventBus: DzupEventBus | undefined,
  event: RegistryEvent,
): void {
  for (const sub of subscriptions) {
    if (matchesFilter(sub.filter, event)) {
      try {
        sub.handler(event)
      } catch {
        // Subscription handler errors are non-fatal
      }
    }
  }

  if (eventBus) {
    eventBus.emit(event as DzupEvent)
  }
}
