/**
 * In-memory implementation of the AgentRegistry interface.
 *
 * Suitable for development, testing, and single-process deployments.
 * Uses immutable update patterns (S6 fix) and numeric semver comparison (S7 fix).
 *
 * MC-040: this file is a thin coordinator. The implementation is split across:
 *  - `in-memory-registry-types.ts`     — internal subscription record shape
 *  - `in-memory-registry-scoring.ts`   — discovery scoring + match weighting
 *  - `in-memory-registry-events.ts`    — subscription fan-out + event-bus forwarding
 *  - `in-memory-registry-mutations.ts` — pure register/update helpers
 *  - `in-memory-registry-queries.ts`   — pure read-only helpers (discover/stats/eviction)
 *
 * Re-exports keep the public surface unchanged for callers that import from
 * this module path.
 */
import { ForgeError } from '../errors/forge-error.js'
import type { DzupEventBus } from '../events/event-bus.js'
import { CapabilityMatcher } from './capability-matcher.js'
import { dispatchRegistryEvent } from './in-memory-registry-events.js'
import {
  applyUpdateChanges,
  buildRegisteredAgent,
} from './in-memory-registry-mutations.js'
import {
  computeRegistryStats,
  discoverAgents,
  findExpiredAgents,
} from './in-memory-registry-queries.js'
import type { Subscription } from './in-memory-registry-types.js'
import type {
  AgentHealth,
  AgentRegistry,
  AgentRegistryConfig,
  DeregistrationReason,
  DiscoveryQuery,
  DiscoveryResultPage,
  RegisterAgentInput,
  RegisteredAgent,
  RegistryEvent,
  RegistryStats,
  RegistrySubscriptionFilter,
} from './types.js'

// Re-export internal helpers so siblings remain reachable for advanced
// consumers (testing, custom registry implementations) without expanding the
// barrel `registry/index.ts`.
export {
  computeMatchScore,
  isUnfilteredQuery,
  scoreAgent,
} from './in-memory-registry-scoring.js'
export { dispatchRegistryEvent, matchesFilter } from './in-memory-registry-events.js'
export {
  applyUpdateChanges,
  buildRegisteredAgent,
} from './in-memory-registry-mutations.js'
export {
  computeRegistryStats,
  discoverAgents,
  findExpiredAgents,
} from './in-memory-registry-queries.js'
export type { UpdateApplicationResult } from './in-memory-registry-mutations.js'
export type { Subscription } from './in-memory-registry-types.js'

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
    const agent = buildRegisteredAgent(id, input, new Date())

    this.agents.set(id, agent)

    this.emitRegistryEvent({
      type: 'registry:agent_registered',
      agentId: id,
      name: input.name,
    })

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

    this.emitRegistryEvent({
      type: 'registry:agent_deregistered',
      agentId,
      reason,
    })
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

    const { updated, changedFields, addedCapabilities } = applyUpdateChanges(
      existing,
      changes,
      new Date(),
    )

    // Emit capability_added events before persisting the snapshot so handlers
    // observing the addition see the prior agent state when they query back.
    for (const capability of addedCapabilities) {
      this.emitRegistryEvent({
        type: 'registry:capability_added',
        agentId,
        capability,
      })
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
    return discoverAgents(this.agents, this.matcher, query)
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
    const evicted = findExpiredAgents(this.agents, Date.now())

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
    return computeRegistryStats(this.agents)
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Emit a registry event to subscriptions and optionally to the DzupEventBus. */
  private emitRegistryEvent(event: RegistryEvent): void {
    dispatchRegistryEvent(this.subscriptions, this.eventBus, event)
  }
}
