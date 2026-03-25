/**
 * PostgresRegistry — ECO-048/049.
 *
 * AgentRegistry implementation backed by a SQL-compatible store abstraction.
 * Uses an in-memory Map as the default backing store. Production deployments
 * can swap in a real Postgres-backed store via the RegistryStore interface.
 *
 * Supports GIN-style capability filtering (simulated via array containment).
 */

import { ForgeError } from '@forgeagent/core'
import type { ForgeEventBus, ForgeEvent } from '@forgeagent/core'
import type { ForgeCapability } from '@forgeagent/core'
import type {
  AgentHealth,
  AgentHealthStatus,
  AgentRegistry,
  AgentRegistryConfig,
  DeregistrationReason,
  DiscoveryQuery,
  DiscoveryResult,
  DiscoveryResultPage,
  RegisterAgentInput,
  RegisteredAgent,
  RegistryEvent,
  RegistryStats,
  RegistrySubscriptionFilter,
  ScoreBreakdown,
} from '@forgeagent/core'

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

// ------------------------------------------------------------------ InMemory Store

export class InMemoryRegistryStore implements RegistryStore {
  private readonly _rows = new Map<string, AgentRow>()

  async insert(row: AgentRow): Promise<void> {
    this._rows.set(row.id, { ...row })
  }

  async update(id: string, partial: Partial<AgentRow>): Promise<void> {
    const existing = this._rows.get(id)
    if (!existing) return
    this._rows.set(id, { ...existing, ...partial })
  }

  async delete(id: string): Promise<void> {
    this._rows.delete(id)
  }

  async getById(id: string): Promise<AgentRow | undefined> {
    const row = this._rows.get(id)
    return row ? { ...row } : undefined
  }

  async list(limit: number, offset: number): Promise<AgentRow[]> {
    const all = [...this._rows.values()]
    return all.slice(offset, offset + limit)
  }

  async count(): Promise<number> {
    return this._rows.size
  }

  async findByCapabilityPrefix(prefix: string, limit: number, offset: number): Promise<AgentRow[]> {
    const lowerPrefix = prefix.toLowerCase()
    const matched: AgentRow[] = []
    for (const row of this._rows.values()) {
      const hasMatch = row.capabilities.some((c) => c.name.toLowerCase().startsWith(lowerPrefix))
      if (hasMatch) matched.push(row)
    }
    return matched.slice(offset, offset + limit)
  }

  async findByCapabilityExact(name: string, limit: number, offset: number): Promise<AgentRow[]> {
    const matched: AgentRow[] = []
    for (const row of this._rows.values()) {
      const hasMatch = row.capabilities.some((c) => c.name === name)
      if (hasMatch) matched.push(row)
    }
    return matched.slice(offset, offset + limit)
  }

  async findExpired(nowMs: number): Promise<AgentRow[]> {
    const expired: AgentRow[] = []
    for (const row of this._rows.values()) {
      if (row.ttl_ms !== null) {
        const registeredMs = new Date(row.registered_at).getTime()
        if (registeredMs + row.ttl_ms < nowMs) {
          expired.push(row)
        }
      }
    }
    return expired
  }
}

// ------------------------------------------------------------------ Helpers

let idCounter = 0
function generateId(): string {
  idCounter++
  return `pg-agent-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

function rowToAgent(row: AgentRow): RegisteredAgent {
  const health: AgentHealth = {
    status: row.health_status,
    ...(row.health_data as Partial<AgentHealth> | null),
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    endpoint: row.endpoint ?? undefined,
    protocols: row.protocols,
    capabilities: row.capabilities,
    authentication: row.authentication_type
      ? { type: row.authentication_type as AgentHealth['status'] extends string ? 'none' : 'none', config: row.authentication_config ?? undefined } as RegisteredAgent['authentication']
      : undefined,
    version: row.version ?? undefined,
    sla: row.sla as RegisteredAgent['sla'],
    health,
    metadata: row.metadata ?? undefined,
    registeredAt: new Date(row.registered_at),
    lastUpdatedAt: new Date(row.last_updated_at),
    ttlMs: row.ttl_ms ?? undefined,
    identity: row.identity as unknown as RegisteredAgent['identity'],
    uri: row.uri ?? undefined,
  }
}

function agentToRow(id: string, input: RegisterAgentInput, now: Date): AgentRow {
  return {
    id,
    name: input.name,
    description: input.description,
    endpoint: input.endpoint ?? null,
    protocols: input.protocols ?? [],
    capabilities: [...input.capabilities],
    authentication_type: input.authentication?.type ?? null,
    authentication_config: input.authentication?.config ?? null,
    version: input.version ?? null,
    sla: input.sla ? { ...input.sla } : null,
    health_status: 'unknown',
    health_data: null,
    metadata: input.metadata ? { ...input.metadata } : null,
    registered_at: now.toISOString(),
    last_updated_at: now.toISOString(),
    ttl_ms: input.ttlMs ?? null,
    identity: input.identity ? { ...input.identity } : null,
    uri: input.uri ?? null,
  }
}

// ------------------------------------------------------------------ Subscription

interface Subscription {
  filter: RegistrySubscriptionFilter
  handler: (event: RegistryEvent) => void
}

// ------------------------------------------------------------------ PostgresRegistry

export interface PostgresRegistryConfig extends AgentRegistryConfig {
  store?: RegistryStore
}

export class PostgresRegistry implements AgentRegistry {
  private readonly _store: RegistryStore
  private readonly _eventBus?: ForgeEventBus
  private readonly _subscriptions = new Set<Subscription>()

  constructor(config?: PostgresRegistryConfig) {
    this._store = config?.store ?? new InMemoryRegistryStore()
    this._eventBus = config?.eventBus
  }

  async register(input: RegisterAgentInput): Promise<RegisteredAgent> {
    if (!input.name || !input.description) {
      throw new ForgeError({
        code: 'REGISTRY_INVALID_INPUT',
        message: 'Agent name and description are required',
        recoverable: false,
      })
    }
    if (!input.capabilities || input.capabilities.length === 0) {
      throw new ForgeError({
        code: 'REGISTRY_INVALID_INPUT',
        message: 'At least one capability is required',
        recoverable: false,
      })
    }

    const id = generateId()
    const now = new Date()
    const row = agentToRow(id, input, now)

    await this._store.insert(row)

    this._emitRegistryEvent({
      type: 'registry:agent_registered',
      agentId: id,
      name: input.name,
    })

    return rowToAgent(row)
  }

  async deregister(agentId: string, reason: DeregistrationReason = 'manual'): Promise<void> {
    const row = await this._store.getById(agentId)
    if (!row) {
      throw new ForgeError({
        code: 'REGISTRY_AGENT_NOT_FOUND',
        message: `Agent not found: ${agentId}`,
        recoverable: false,
      })
    }

    await this._store.delete(agentId)

    this._emitRegistryEvent({
      type: 'registry:agent_deregistered',
      agentId,
      reason,
    })
  }

  async update(agentId: string, changes: Partial<RegisterAgentInput>): Promise<RegisteredAgent> {
    const row = await this._store.getById(agentId)
    if (!row) {
      throw new ForgeError({
        code: 'REGISTRY_AGENT_NOT_FOUND',
        message: `Agent not found: ${agentId}`,
        recoverable: false,
      })
    }

    const changedFields: string[] = []
    const partial: Partial<AgentRow> = { last_updated_at: new Date().toISOString() }

    if (changes.name !== undefined) { partial.name = changes.name; changedFields.push('name') }
    if (changes.description !== undefined) { partial.description = changes.description; changedFields.push('description') }
    if (changes.endpoint !== undefined) { partial.endpoint = changes.endpoint; changedFields.push('endpoint') }
    if (changes.protocols !== undefined) { partial.protocols = [...changes.protocols]; changedFields.push('protocols') }
    if (changes.capabilities !== undefined) {
      const existingNames = new Set(row.capabilities.map((c) => c.name))
      for (const cap of changes.capabilities) {
        if (!existingNames.has(cap.name)) {
          this._emitRegistryEvent({ type: 'registry:capability_added', agentId, capability: cap.name })
        }
      }
      partial.capabilities = [...changes.capabilities]
      changedFields.push('capabilities')
    }
    if (changes.version !== undefined) { partial.version = changes.version; changedFields.push('version') }
    if (changes.sla !== undefined) { partial.sla = { ...changes.sla }; changedFields.push('sla') }
    if (changes.metadata !== undefined) { partial.metadata = { ...changes.metadata }; changedFields.push('metadata') }
    if (changes.ttlMs !== undefined) { partial.ttl_ms = changes.ttlMs; changedFields.push('ttlMs') }
    if (changes.uri !== undefined) { partial.uri = changes.uri; changedFields.push('uri') }

    await this._store.update(agentId, partial)

    if (changedFields.length > 0) {
      this._emitRegistryEvent({ type: 'registry:agent_updated', agentId, fields: changedFields })
    }

    const updatedRow = await this._store.getById(agentId)
    return rowToAgent(updatedRow!)
  }

  async discover(query: DiscoveryQuery): Promise<DiscoveryResultPage> {
    const limit = query.limit ?? 10
    const offset = query.offset ?? 0
    const total = await this._store.count()

    // Get all agents (simple approach; in Postgres this would be a complex query)
    const rows = await this._store.list(total, 0)
    const scored: DiscoveryResult[] = []

    for (const row of rows) {
      const agent = rowToAgent(row)

      // Health filter
      if (query.healthFilter && query.healthFilter.length > 0) {
        if (!query.healthFilter.includes(agent.health.status)) continue
      }
      // Protocol filter
      if (query.protocols && query.protocols.length > 0) {
        const hasProtocol = query.protocols.some((p) => agent.protocols.includes(p))
        if (!hasProtocol) continue
      }

      const breakdown = this._scoreAgent(agent, query)
      const matchScore =
        breakdown.capabilityScore * 0.4 +
        breakdown.tagScore * 0.2 +
        breakdown.healthAdjustment * 0.3 +
        breakdown.slaScore * 0.1

      if (matchScore > 0 || this._isUnfilteredQuery(query)) {
        scored.push({ agent, matchScore, scoreBreakdown: breakdown })
      }
    }

    scored.sort((a, b) => b.matchScore - a.matchScore)
    const paged = scored.slice(offset, offset + limit)
    return { results: paged, total: scored.length, offset, limit }
  }

  async getAgent(agentId: string): Promise<RegisteredAgent | undefined> {
    const row = await this._store.getById(agentId)
    return row ? rowToAgent(row) : undefined
  }

  async getHealth(agentId: string): Promise<AgentHealth | undefined> {
    const row = await this._store.getById(agentId)
    if (!row) return undefined
    return { status: row.health_status, ...(row.health_data as Partial<AgentHealth> | null) }
  }

  async updateHealth(agentId: string, health: Partial<AgentHealth>): Promise<void> {
    const row = await this._store.getById(agentId)
    if (!row) {
      throw new ForgeError({
        code: 'REGISTRY_AGENT_NOT_FOUND',
        message: `Agent not found: ${agentId}`,
        recoverable: false,
      })
    }

    const previousStatus = row.health_status
    const merged = { ...(row.health_data ?? {}), ...health }
    const newStatus = health.status ?? previousStatus

    await this._store.update(agentId, {
      health_status: newStatus,
      health_data: merged,
      last_updated_at: new Date().toISOString(),
    })

    if (health.status !== undefined && health.status !== previousStatus) {
      this._emitRegistryEvent({
        type: 'registry:health_changed',
        agentId,
        previousStatus,
        newStatus: health.status,
      })
    }
  }

  subscribe(
    filter: RegistrySubscriptionFilter,
    handler: (event: RegistryEvent) => void,
  ): { unsubscribe(): void } {
    const sub: Subscription = { filter, handler }
    this._subscriptions.add(sub)
    return { unsubscribe: () => { this._subscriptions.delete(sub) } }
  }

  async listAgents(limit = 100, offset = 0): Promise<{ agents: RegisteredAgent[]; total: number }> {
    const rows = await this._store.list(limit, offset)
    const total = await this._store.count()
    return { agents: rows.map(rowToAgent), total }
  }

  async registerFromCard(_cardUrl: string): Promise<RegisteredAgent> {
    throw new ForgeError({
      code: 'REGISTRY_CARD_FETCH_FAILED',
      message: 'PostgresRegistry does not support card-based registration',
      recoverable: false,
    })
  }

  async evictExpired(): Promise<string[]> {
    const expired = await this._store.findExpired(Date.now())
    const evicted: string[] = []
    for (const row of expired) {
      await this._store.delete(row.id)
      evicted.push(row.id)
      this._emitRegistryEvent({ type: 'registry:agent_deregistered', agentId: row.id, reason: 'ttl_expired' })
    }
    return evicted
  }

  async stats(): Promise<RegistryStats> {
    const total = await this._store.count()
    const allRows = await this._store.list(total, 0)
    let healthy = 0, degraded = 0, unhealthy = 0
    const capNames = new Set<string>()
    const protocolCounts: Record<string, number> = {}

    for (const row of allRows) {
      switch (row.health_status) {
        case 'healthy': healthy++; break
        case 'degraded': degraded++; break
        case 'unhealthy': unhealthy++; break
      }
      for (const cap of row.capabilities) capNames.add(cap.name)
      for (const proto of row.protocols) {
        protocolCounts[proto] = (protocolCounts[proto] ?? 0) + 1
      }
    }

    return {
      totalAgents: total,
      healthyAgents: healthy,
      degradedAgents: degraded,
      unhealthyAgents: unhealthy,
      capabilityCount: capNames.size,
      protocolCounts,
    }
  }

  // --- Private ---

  private _isUnfilteredQuery(query: DiscoveryQuery): boolean {
    return (
      !query.capabilityPrefix && !query.capabilityExact && !query.semanticQuery &&
      (!query.tags || query.tags.length === 0) &&
      (!query.healthFilter || query.healthFilter.length === 0) &&
      (!query.protocols || query.protocols.length === 0) &&
      !query.slaFilter
    )
  }

  private _scoreAgent(agent: RegisteredAgent, query: DiscoveryQuery): ScoreBreakdown {
    let capabilityScore = 0
    let tagScore = 0
    let slaScore = 1.0

    if (query.capabilityPrefix) {
      for (const cap of agent.capabilities) {
        if (cap.name.startsWith(query.capabilityPrefix)) {
          capabilityScore = Math.max(capabilityScore, 1.0)
        }
      }
    }
    if (query.capabilityExact) {
      for (const cap of agent.capabilities) {
        if (cap.name === query.capabilityExact.name) {
          capabilityScore = Math.max(capabilityScore, 1.0)
        }
      }
    }
    if (!query.capabilityPrefix && !query.capabilityExact) capabilityScore = 1.0

    if (query.tags && query.tags.length > 0) {
      const agentTags = new Set<string>()
      for (const cap of agent.capabilities) {
        if (cap.tags) for (const t of cap.tags) agentTags.add(t)
      }
      let matched = 0
      for (const tag of query.tags) if (agentTags.has(tag)) matched++
      tagScore = agentTags.size > 0 ? matched / query.tags.length : 0
    } else {
      tagScore = 1.0
    }

    const healthAdjustment = this._healthScore(agent.health.status)

    if (query.slaFilter && agent.sla) {
      let met = 0, checks = 0
      if (query.slaFilter.maxLatencyMs !== undefined && agent.sla.maxLatencyMs !== undefined) {
        checks++; if (agent.sla.maxLatencyMs <= query.slaFilter.maxLatencyMs) met++
      }
      if (checks > 0) slaScore = met / checks
    }

    return { capabilityScore, tagScore, healthAdjustment, slaScore }
  }

  private _healthScore(status: AgentHealthStatus): number {
    switch (status) {
      case 'healthy': return 1.0
      case 'degraded': return 0.5
      case 'unhealthy': return 0.1
      case 'unknown': return 0.3
    }
  }

  private _emitRegistryEvent(event: RegistryEvent): void {
    for (const sub of this._subscriptions) {
      if (this._matchesFilter(sub.filter, event)) {
        try { sub.handler(event) } catch { /* non-fatal */ }
      }
    }
    if (this._eventBus) {
      this._eventBus.emit(event as ForgeEvent)
    }
  }

  private _matchesFilter(filter: RegistrySubscriptionFilter, event: RegistryEvent): boolean {
    if (filter.eventTypes && filter.eventTypes.length > 0) {
      if (!filter.eventTypes.includes(event.type)) return false
    }
    if (filter.agentIds && filter.agentIds.length > 0) {
      if (!filter.agentIds.includes(event.agentId)) return false
    }
    return true
  }
}
