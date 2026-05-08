/**
 * PostgresRegistry types — ECO-048/049.
 *
 * Row shape and store interface for the agent registry persistence layer.
 */

import type { ForgeCapability } from '@dzupagent/core/identity'
import type { AgentHealthStatus, AgentRegistryConfig, RegistryEvent, RegistrySubscriptionFilter } from '@dzupagent/core/pipeline'

// ------------------------------------------------------------------ Store abstraction

/** Row shape matching a SQL table for registered agents. */
export interface AgentRow {
  id: string
  name: string
  description: string
  endpoint: string | null
  protocols: string[]
  capabilities: ForgeCapability[]
  authentication_type: string | null
  authentication_config: Record<string, unknown> | null
  version: string | null
  sla: Record<string, unknown> | null
  health_status: AgentHealthStatus
  health_data: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  registered_at: string
  last_updated_at: string
  ttl_ms: number | null
  identity: Record<string, unknown> | null
  uri: string | null
}

/**
 * Store interface for registry persistence.
 * In-memory implementation is provided; swap for Drizzle/Postgres in production.
 */
export interface RegistryStore {
  insert(row: AgentRow): Promise<void>
  update(id: string, row: Partial<AgentRow>): Promise<void>
  delete(id: string): Promise<void>
  getById(id: string): Promise<AgentRow | undefined>
  list(limit: number, offset: number): Promise<AgentRow[]>
  count(): Promise<number>
  /** Find agents whose capabilities array contains a capability with the given name prefix. */
  findByCapabilityPrefix(prefix: string, limit: number, offset: number): Promise<AgentRow[]>
  /** Find agents whose capabilities array contains an exact capability name. */
  findByCapabilityExact(name: string, limit: number, offset: number): Promise<AgentRow[]>
  /** Find all agents whose ttl has expired. */
  findExpired(nowMs: number): Promise<AgentRow[]>
}

// ------------------------------------------------------------------ Subscription

export interface Subscription {
  filter: RegistrySubscriptionFilter
  handler: (event: RegistryEvent) => void
}

// ------------------------------------------------------------------ Registry config

export interface PostgresRegistryConfig extends AgentRegistryConfig {
  store?: RegistryStore
}
