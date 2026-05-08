/**
 * Internal types for the in-memory registry implementation.
 *
 * Public-facing types remain in `./types.ts`. This module holds shapes that
 * are private to the implementation (e.g. subscription bookkeeping) so they
 * can be shared across the focused sibling modules without polluting the
 * public surface.
 */
import type { RegistryEvent, RegistrySubscriptionFilter } from './types.js'

/** A single subscription record kept by the in-memory registry. */
export interface Subscription {
  filter: RegistrySubscriptionFilter
  handler: (event: RegistryEvent) => void
}
