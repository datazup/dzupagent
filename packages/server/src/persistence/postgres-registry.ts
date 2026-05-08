/**
 * PostgresRegistry — ECO-048/049.
 *
 * AgentRegistry implementation backed by a SQL-compatible store abstraction.
 * Uses an in-memory Map as the default backing store. Production deployments
 * can swap in a real Postgres-backed store via the RegistryStore interface.
 *
 * Supports GIN-style capability filtering (simulated via array containment).
 *
 * MC-044: Module split into focused siblings while keeping this file as the
 * public import path for callers.
 */

export type {
  AgentRow,
  PostgresRegistryConfig,
  RegistryStore,
  Subscription,
} from './postgres-registry-types.js'

export { InMemoryRegistryStore } from './postgres-registry-queries.js'
export { PostgresRegistry } from './postgres-registry-core.js'
