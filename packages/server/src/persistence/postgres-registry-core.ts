/**
 * PostgresRegistry core — ECO-048/049.
 *
 * AgentRegistry implementation backed by a SQL-compatible store abstraction.
 * Owns CRUD, discovery, health updates, subscriptions, eviction, stats.
 */

import { ForgeError } from '@dzupagent/core/events'
import type { DzupEventBus, DzupEvent } from '@dzupagent/core/events'
import type { AgentHealth, AgentRegistry, DeregistrationReason, DiscoveryQuery, DiscoveryResult, DiscoveryResultPage, RegisterAgentInput, RegisteredAgent, RegistryEvent, RegistryStats, RegistrySubscriptionFilter } from '@dzupagent/core/pipeline'

import { isUnfilteredQuery, scoreAgent } from './postgres-registry-capabilities.js'
import { InMemoryRegistryStore, agentToRow, cloneRecord, generateId, rowToAgent } from './postgres-registry-queries.js'
import type { AgentRow, PostgresRegistryConfig, RegistryStore, Subscription } from './postgres-registry-types.js'

export class PostgresRegistry implements AgentRegistry {
  private readonly _store: RegistryStore
  private readonly _eventBus?: DzupEventBus
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
    if (changes.authentication !== undefined) {
      partial.authentication_type = changes.authentication.type
      partial.authentication_config = cloneRecord(changes.authentication.config ?? null)
      changedFields.push('authentication')
    }
    if (changes.version !== undefined) { partial.version = changes.version; changedFields.push('version') }
    if (changes.sla !== undefined) { partial.sla = { ...changes.sla }; changedFields.push('sla') }
    if (changes.metadata !== undefined) { partial.metadata = { ...changes.metadata }; changedFields.push('metadata') }
    if (changes.ttlMs !== undefined) { partial.ttl_ms = changes.ttlMs; changedFields.push('ttlMs') }
    if (changes.identity !== undefined) {
      partial.identity = { ...changes.identity }
      changedFields.push('identity')
    }
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

      const breakdown = scoreAgent(agent, query)
      const matchScore =
        breakdown.capabilityScore * 0.4 +
        breakdown.tagScore * 0.2 +
        breakdown.healthAdjustment * 0.3 +
        breakdown.slaScore * 0.1

      if (matchScore > 0 || isUnfilteredQuery(query)) {
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

  private _emitRegistryEvent(event: RegistryEvent): void {
    for (const sub of this._subscriptions) {
      if (this._matchesFilter(sub.filter, event)) {
        try { sub.handler(event) } catch { /* non-fatal */ }
      }
    }
    if (this._eventBus) {
      this._eventBus.emit(event as DzupEvent)
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
