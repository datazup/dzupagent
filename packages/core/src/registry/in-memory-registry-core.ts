/**
 * In-memory implementation of the AgentRegistry interface.
 *
 * Suitable for development, testing, and single-process deployments.
 * Uses immutable update patterns (S6 fix) and numeric semver comparison (S7 fix).
 */
import type { DzupEventBus } from '../events/event-bus.js'
import { CapabilityMatcher } from './capability-matcher.js'
import {
  assertValidRegistrationInput,
  createCardFetchFailedError,
  getRegisteredAgentOrThrow,
} from './in-memory-registry-errors.js'
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

export class InMemoryRegistry implements AgentRegistry {
  private readonly agents = new Map<string, RegisteredAgent>()
  private readonly subscriptions = new Set<Subscription>()
  private readonly eventBus: DzupEventBus | undefined
  private readonly matcher = new CapabilityMatcher()
  private idCounter = 0

  constructor(config?: AgentRegistryConfig) {
    this.eventBus = config?.eventBus
  }

  async register(input: RegisterAgentInput): Promise<RegisteredAgent> {
    assertValidRegistrationInput(input)
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

  async deregister(agentId: string, reason: DeregistrationReason = 'manual'): Promise<void> {
    getRegisteredAgentOrThrow(this.agents, agentId)
    this.agents.delete(agentId)

    this.emitRegistryEvent({
      type: 'registry:agent_deregistered',
      agentId,
      reason,
    })
  }

  async update(agentId: string, changes: Partial<RegisterAgentInput>): Promise<RegisteredAgent> {
    const existing = getRegisteredAgentOrThrow(this.agents, agentId)
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

  async discover(query: DiscoveryQuery): Promise<DiscoveryResultPage> {
    return discoverAgents(this.agents, this.matcher, query)
  }

  async getAgent(agentId: string): Promise<RegisteredAgent | undefined> {
    const agent = this.agents.get(agentId)
    return agent ? { ...agent } : undefined
  }

  async getHealth(agentId: string): Promise<AgentHealth | undefined> {
    const agent = this.agents.get(agentId)
    return agent ? { ...agent.health } : undefined
  }

  async updateHealth(agentId: string, health: Partial<AgentHealth>): Promise<void> {
    const existing = getRegisteredAgentOrThrow(this.agents, agentId)
    const previousStatus = existing.health.status
    const newHealth: AgentHealth = { ...existing.health, ...health }

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

  async listAgents(
    limit = 100,
    offset = 0,
  ): Promise<{ agents: RegisteredAgent[]; total: number }> {
    const all = [...this.agents.values()]
    const total = all.length
    const paged = all.slice(offset, offset + limit).map((a) => ({ ...a }))
    return { agents: paged, total }
  }

  async registerFromCard(cardUrl: string): Promise<RegisteredAgent> {
    // In a real implementation, this would fetch the agent card from the URL.
    // For the in-memory registry, we throw an error since we cannot fetch.
    throw createCardFetchFailedError(cardUrl)
  }

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

  async stats(): Promise<RegistryStats> {
    return computeRegistryStats(this.agents)
  }

  /** Emit a registry event to subscriptions and optionally to the DzupEventBus. */
  private emitRegistryEvent(event: RegistryEvent): void {
    dispatchRegistryEvent(this.subscriptions, this.eventBus, event)
  }
}
