/**
 * In-memory implementation of the AgentRegistry interface.
 *
 * Suitable for development, testing, and single-process deployments.
 * Uses immutable update patterns (S6 fix) and numeric semver comparison (S7 fix).
 */
import { ForgeError } from '../errors/forge-error.js'
import type { DzupEventBus } from '../events/event-bus.js'
import type { DzupEvent } from '../events/event-types.js'
import { CapabilityMatcher, compareSemver } from './capability-matcher.js'
import type {
  AgentHealth,
  AgentHealthStatus,
  AgentRegistry,
  AgentRegistryConfig,
  DeregistrationReason,
  DiscoveryQuery,
  DiscoveryResultPage,
  DiscoveryResult,
  RegisterAgentInput,
  RegisteredAgent,
  RegistryEvent,
  RegistryStats,
  RegistrySubscriptionFilter,
  ScoreBreakdown,
} from './types.js'

// ---------------------------------------------------------------------------
// Subscription entry
// ---------------------------------------------------------------------------

interface Subscription {
  filter: RegistrySubscriptionFilter
  handler: (event: RegistryEvent) => void
}

// ---------------------------------------------------------------------------
// InMemoryRegistry
// ---------------------------------------------------------------------------

export class InMemoryRegistry implements AgentRegistry {
  private readonly agents = new Map<string, RegisteredAgent>()
  private readonly subscriptions = new Set<Subscription>()
  private readonly eventBus: DzupEventBus | undefined
  private readonly matcher = new CapabilityMatcher()
  private idCounter = 0

  constructor(config?: AgentRegistryConfig) {
    this.eventBus = config?.eventBus
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

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

    this.idCounter++
    const id = `agent-${Date.now().toString(36)}-${this.idCounter.toString(36)}`
    const now = new Date()

    const agent: RegisteredAgent = {
      id,
      name: input.name,
      description: input.description,
      protocols: input.protocols ?? [],
      capabilities: [...input.capabilities],
      health: { status: 'unknown' },
      registeredAt: now,
      lastUpdatedAt: now,
      ...(input.endpoint !== undefined && { endpoint: input.endpoint }),
      ...(input.authentication !== undefined && { authentication: input.authentication }),
      ...(input.version !== undefined && { version: input.version }),
      ...(input.sla !== undefined && { sla: { ...input.sla } }),
      ...(input.metadata !== undefined && { metadata: { ...input.metadata } }),
      ...(input.ttlMs !== undefined && { ttlMs: input.ttlMs }),
      ...(input.identity !== undefined && { identity: { ...input.identity } }),
      ...(input.uri !== undefined && { uri: input.uri }),
    }

    this.agents.set(id, agent)

    const event: RegistryEvent = {
      type: 'registry:agent_registered',
      agentId: id,
      name: input.name,
    }
    this.emitRegistryEvent(event)

    return { ...agent }
  }

  // -----------------------------------------------------------------------
  // Deregistration
  // -----------------------------------------------------------------------

  async deregister(agentId: string, reason: DeregistrationReason = 'manual'): Promise<void> {
    if (!this.agents.has(agentId)) {
      throw new ForgeError({
        code: 'REGISTRY_AGENT_NOT_FOUND',
        message: `Agent not found: ${agentId}`,
        recoverable: false,
      })
    }

    this.agents.delete(agentId)

    const event: RegistryEvent = {
      type: 'registry:agent_deregistered',
      agentId,
      reason,
    }
    this.emitRegistryEvent(event)
  }

  // -----------------------------------------------------------------------
  // Update (S6 fix: spread for immutability)
  // -----------------------------------------------------------------------

  async update(agentId: string, changes: Partial<RegisterAgentInput>): Promise<RegisteredAgent> {
    const existing = this.agents.get(agentId)
    if (!existing) {
      throw new ForgeError({
        code: 'REGISTRY_AGENT_NOT_FOUND',
        message: `Agent not found: ${agentId}`,
        recoverable: false,
      })
    }

    const changedFields: string[] = []

    // Build updated agent via spread (S6 fix — no direct mutation)
    const updated: RegisteredAgent = {
      ...existing,
      lastUpdatedAt: new Date(),
    }

    if (changes.name !== undefined) {
      updated.name = changes.name
      changedFields.push('name')
    }
    if (changes.description !== undefined) {
      updated.description = changes.description
      changedFields.push('description')
    }
    if (changes.endpoint !== undefined) {
      updated.endpoint = changes.endpoint
      changedFields.push('endpoint')
    }
    if (changes.protocols !== undefined) {
      updated.protocols = [...changes.protocols]
      changedFields.push('protocols')
    }
    if (changes.capabilities !== undefined) {
      // Detect newly added capabilities
      const existingNames = new Set(existing.capabilities.map((c) => c.name))
      for (const cap of changes.capabilities) {
        if (!existingNames.has(cap.name)) {
          this.emitRegistryEvent({
            type: 'registry:capability_added',
            agentId,
            capability: cap.name,
          })
        }
      }
      updated.capabilities = [...changes.capabilities]
      changedFields.push('capabilities')
    }
    if (changes.authentication !== undefined) {
      updated.authentication = changes.authentication
      changedFields.push('authentication')
    }
    if (changes.version !== undefined) {
      updated.version = changes.version
      changedFields.push('version')
    }
    if (changes.sla !== undefined) {
      updated.sla = { ...changes.sla }
      changedFields.push('sla')
    }
    if (changes.metadata !== undefined) {
      updated.metadata = { ...changes.metadata }
      changedFields.push('metadata')
    }
    if (changes.ttlMs !== undefined) {
      updated.ttlMs = changes.ttlMs
      changedFields.push('ttlMs')
    }
    if (changes.identity !== undefined) {
      updated.identity = { ...changes.identity }
      changedFields.push('identity')
    }
    if (changes.uri !== undefined) {
      updated.uri = changes.uri
      changedFields.push('uri')
    }

    this.agents.set(agentId, updated)

    if (changedFields.length > 0) {
      this.emitRegistryEvent({
        type: 'registry:agent_updated',
        agentId,
        fields: changedFields,
      })
    }

    return { ...updated }
  }

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  async discover(query: DiscoveryQuery): Promise<DiscoveryResultPage> {
    const limit = query.limit ?? 10
    const offset = query.offset ?? 0

    const scored: DiscoveryResult[] = []

    for (const agent of this.agents.values()) {
      // Health filter
      if (query.healthFilter && query.healthFilter.length > 0) {
        if (!query.healthFilter.includes(agent.health.status)) continue
      }

      // Protocol filter
      if (query.protocols && query.protocols.length > 0) {
        const hasProtocol = query.protocols.some((p) => agent.protocols.includes(p))
        if (!hasProtocol) continue
      }

      const breakdown = this.scoreAgent(agent, query)
      const matchScore =
        breakdown.capabilityScore * 0.4 +
        breakdown.tagScore * 0.2 +
        breakdown.healthAdjustment * 0.3 +
        breakdown.slaScore * 0.1

      // Only include agents with some match
      if (matchScore > 0 || this.isUnfilteredQuery(query)) {
        scored.push({
          agent: { ...agent },
          matchScore,
          scoreBreakdown: breakdown,
        })
      }
    }

    // Sort by match score descending
    scored.sort((a, b) => b.matchScore - a.matchScore)

    const total = scored.length
    const paged = scored.slice(offset, offset + limit)

    return {
      results: paged,
      total,
      offset,
      limit,
    }
  }

  // -----------------------------------------------------------------------
  // Getters
  // -----------------------------------------------------------------------

  async getAgent(agentId: string): Promise<RegisteredAgent | undefined> {
    const agent = this.agents.get(agentId)
    return agent ? { ...agent } : undefined
  }

  async getHealth(agentId: string): Promise<AgentHealth | undefined> {
    const agent = this.agents.get(agentId)
    return agent ? { ...agent.health } : undefined
  }

  // -----------------------------------------------------------------------
  // Health update
  // -----------------------------------------------------------------------

  async updateHealth(agentId: string, health: Partial<AgentHealth>): Promise<void> {
    const existing = this.agents.get(agentId)
    if (!existing) {
      throw new ForgeError({
        code: 'REGISTRY_AGENT_NOT_FOUND',
        message: `Agent not found: ${agentId}`,
        recoverable: false,
      })
    }

    const previousStatus = existing.health.status
    const newHealth: AgentHealth = { ...existing.health, ...health }

    // S6 fix: create new agent object via spread
    const updated: RegisteredAgent = {
      ...existing,
      health: newHealth,
      lastUpdatedAt: new Date(),
    }
    this.agents.set(agentId, updated)

    if (health.status !== undefined && health.status !== previousStatus) {
      this.emitRegistryEvent({
        type: 'registry:health_changed',
        agentId,
        previousStatus,
        newStatus: health.status,
      })
    }
  }

  // -----------------------------------------------------------------------
  // Subscriptions
  // -----------------------------------------------------------------------

  subscribe(
    filter: RegistrySubscriptionFilter,
    handler: (event: RegistryEvent) => void,
  ): { unsubscribe(): void } {
    const sub: Subscription = { filter, handler }
    this.subscriptions.add(sub)
    return {
      unsubscribe: () => {
        this.subscriptions.delete(sub)
      },
    }
  }

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------

  async listAgents(
    limit = 100,
    offset = 0,
  ): Promise<{ agents: RegisteredAgent[]; total: number }> {
    const all = [...this.agents.values()]
    const total = all.length
    const paged = all.slice(offset, offset + limit).map((a) => ({ ...a }))
    return { agents: paged, total }
  }

  // -----------------------------------------------------------------------
  // Register from agent card
  // -----------------------------------------------------------------------

  async registerFromCard(cardUrl: string): Promise<RegisteredAgent> {
    // In a real implementation, this would fetch the agent card from the URL.
    // For the in-memory registry, we throw an error since we cannot fetch.
    throw new ForgeError({
      code: 'REGISTRY_CARD_FETCH_FAILED',
      message: `Cannot fetch agent card in InMemoryRegistry: ${cardUrl}`,
      recoverable: false,
      suggestion: 'Use a registry implementation that supports HTTP fetching, or register manually.',
    })
  }

  // -----------------------------------------------------------------------
  // Eviction
  // -----------------------------------------------------------------------

  async evictExpired(): Promise<string[]> {
    const now = Date.now()
    const evicted: string[] = []

    for (const [id, agent] of this.agents.entries()) {
      if (agent.ttlMs !== undefined) {
        const expiresAt = agent.registeredAt.getTime() + agent.ttlMs
        if (expiresAt < now) {
          evicted.push(id)
        }
      }
    }

    for (const id of evicted) {
      this.agents.delete(id)
      this.emitRegistryEvent({
        type: 'registry:agent_deregistered',
        agentId: id,
        reason: 'ttl_expired',
      })
    }

    return evicted
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  async stats(): Promise<RegistryStats> {
    let healthy = 0
    let degraded = 0
    let unhealthy = 0
    const capabilityNames = new Set<string>()
    const protocolCounts: Record<string, number> = {}

    for (const agent of this.agents.values()) {
      switch (agent.health.status) {
        case 'healthy':
          healthy++
          break
        case 'degraded':
          degraded++
          break
        case 'unhealthy':
          unhealthy++
          break
        // 'unknown' is not counted in any health bucket
      }

      for (const cap of agent.capabilities) {
        capabilityNames.add(cap.name)
      }

      for (const protocol of agent.protocols) {
        protocolCounts[protocol] = (protocolCounts[protocol] ?? 0) + 1
      }
    }

    return {
      totalAgents: this.agents.size,
      healthyAgents: healthy,
      degradedAgents: degraded,
      unhealthyAgents: unhealthy,
      capabilityCount: capabilityNames.size,
      protocolCounts,
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Check if a query has no filtering criteria (returns all agents). */
  private isUnfilteredQuery(query: DiscoveryQuery): boolean {
    return (
      !query.capabilityPrefix &&
      !query.capabilityExact &&
      !query.semanticQuery &&
      (!query.tags || query.tags.length === 0) &&
      (!query.healthFilter || query.healthFilter.length === 0) &&
      (!query.protocols || query.protocols.length === 0) &&
      !query.slaFilter
    )
  }

  /** Score an agent against a discovery query. */
  private scoreAgent(agent: RegisteredAgent, query: DiscoveryQuery): ScoreBreakdown {
    let capabilityScore = 0
    let tagScore = 0
    let slaScore = 1.0

    // Capability prefix matching
    if (query.capabilityPrefix) {
      let bestScore = 0
      for (const cap of agent.capabilities) {
        const score = this.matcher.match(query.capabilityPrefix, cap.name)
        if (score > bestScore) bestScore = score
      }
      capabilityScore = bestScore
    }

    // Exact capability + version matching (S7 fix: numeric semver)
    if (query.capabilityExact) {
      for (const cap of agent.capabilities) {
        if (cap.name === query.capabilityExact.name) {
          if (query.capabilityExact.minVersion) {
            if (compareSemver(cap.version, query.capabilityExact.minVersion) >= 0) {
              capabilityScore = Math.max(capabilityScore, 1.0)
            } else {
              capabilityScore = Math.max(capabilityScore, 0.3)
            }
          } else {
            capabilityScore = Math.max(capabilityScore, 1.0)
          }
        }
      }
    }

    // If no capability query, default to 1.0 (don't penalize)
    if (!query.capabilityPrefix && !query.capabilityExact) {
      capabilityScore = 1.0
    }

    // Tag matching
    if (query.tags && query.tags.length > 0) {
      const agentTags = new Set<string>()
      for (const cap of agent.capabilities) {
        if (cap.tags) {
          for (const t of cap.tags) agentTags.add(t)
        }
      }
      if (agentTags.size > 0) {
        let matched = 0
        for (const tag of query.tags) {
          if (agentTags.has(tag)) matched++
        }
        tagScore = matched / query.tags.length
      }
    } else {
      tagScore = 1.0
    }

    // Health adjustment
    const healthAdjustment = this.healthScore(agent.health.status)

    // SLA check
    if (query.slaFilter && agent.sla) {
      let slaMet = 0
      let slaChecks = 0
      if (query.slaFilter.maxLatencyMs !== undefined && agent.sla.maxLatencyMs !== undefined) {
        slaChecks++
        if (agent.sla.maxLatencyMs <= query.slaFilter.maxLatencyMs) slaMet++
      }
      if (query.slaFilter.minUptimeRatio !== undefined && agent.sla.minUptimeRatio !== undefined) {
        slaChecks++
        if (agent.sla.minUptimeRatio >= query.slaFilter.minUptimeRatio) slaMet++
      }
      if (query.slaFilter.maxErrorRate !== undefined && agent.sla.maxErrorRate !== undefined) {
        slaChecks++
        if (agent.sla.maxErrorRate <= query.slaFilter.maxErrorRate) slaMet++
      }
      if (slaChecks > 0) {
        slaScore = slaMet / slaChecks
      }
    }

    return {
      capabilityScore,
      tagScore,
      healthAdjustment,
      slaScore,
    }
  }

  private healthScore(status: AgentHealthStatus): number {
    switch (status) {
      case 'healthy':
        return 1.0
      case 'degraded':
        return 0.5
      case 'unhealthy':
        return 0.1
      case 'unknown':
        return 0.3
    }
  }

  /** Emit a registry event to subscriptions and optionally to the DzupEventBus. */
  private emitRegistryEvent(event: RegistryEvent): void {
    // Notify subscriptions
    for (const sub of this.subscriptions) {
      if (this.matchesFilter(sub.filter, event)) {
        try {
          sub.handler(event)
        } catch {
          // Subscription handler errors are non-fatal
        }
      }
    }

    // Forward to DzupEventBus if available
    if (this.eventBus) {
      this.eventBus.emit(event as DzupEvent)
    }
  }

  /** Check if an event matches a subscription filter. */
  private matchesFilter(filter: RegistrySubscriptionFilter, event: RegistryEvent): boolean {
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
}
