/**
 * Agent Registry types.
 *
 * Defines the core interfaces for agent registration, discovery, and health
 * tracking within the DzupAgent ecosystem.
 */
import type { ForgeCapability, ForgeIdentityRef } from '../identity/index.js'
import type { DzupEventBus } from '../events/event-bus.js'

// ---------------------------------------------------------------------------
// Backward-compat alias (C1 fix)
// ---------------------------------------------------------------------------

/** Alias for ForgeCapability — use ForgeCapability directly in new code. */
export type CapabilityDescriptor = ForgeCapability

// ---------------------------------------------------------------------------
// Health & SLA
// ---------------------------------------------------------------------------

/** Agent health status (W6 fix: typed enum, not plain string). */
export type AgentHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'

/** Reason for agent deregistration (W6 fix: typed enum). */
export type DeregistrationReason = 'manual' | 'ttl_expired' | 'health_failed' | 'superseded'

/** Health snapshot for a registered agent. */
export interface AgentHealth {
  status: AgentHealthStatus
  lastCheckedAt?: Date
  lastSuccessAt?: Date
  latencyP50Ms?: number
  latencyP95Ms?: number
  latencyP99Ms?: number
  errorRate?: number
  consecutiveSuccesses?: number
  consecutiveFailures?: number
  uptimeRatio?: number
  circuitState?: 'closed' | 'open' | 'half-open'
}

/** SLA constraints for an agent. */
export interface AgentSLA {
  maxLatencyMs?: number
  minUptimeRatio?: number
  maxErrorRate?: number
  maxRps?: number
}

/** Authentication configuration for an agent. */
export interface AgentAuthentication {
  type: 'none' | 'bearer' | 'api-key' | 'oauth2' | 'mtls' | 'delegation'
  config?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Registered Agent
// ---------------------------------------------------------------------------

/** Full record of a registered agent. */
export interface RegisteredAgent {
  id: string
  name: string
  description: string
  endpoint?: string
  protocols: string[]
  capabilities: ForgeCapability[]
  authentication?: AgentAuthentication
  version?: string
  sla?: AgentSLA
  health: AgentHealth
  metadata?: Record<string, unknown>
  registeredAt: Date
  lastUpdatedAt: Date
  ttlMs?: number
  /** C4 fix: optional identity reference for progressive adoption. */
  identity?: ForgeIdentityRef
  /** C4 fix: forge:// URI for this agent. */
  uri?: string
}

// ---------------------------------------------------------------------------
// Registration input
// ---------------------------------------------------------------------------

/** Input for registering a new agent. */
export interface RegisterAgentInput {
  name: string
  description: string
  endpoint?: string
  protocols?: string[]
  capabilities: ForgeCapability[]
  authentication?: AgentAuthentication
  version?: string
  sla?: AgentSLA
  metadata?: Record<string, unknown>
  ttlMs?: number
  identity?: ForgeIdentityRef
  uri?: string
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Query parameters for agent discovery. */
export interface DiscoveryQuery {
  capabilityPrefix?: string
  capabilityExact?: { name: string; minVersion?: string }
  semanticQuery?: string
  tags?: string[]
  healthFilter?: AgentHealthStatus[]
  slaFilter?: Partial<AgentSLA>
  protocols?: string[]
  limit?: number
  offset?: number
}

/** Breakdown of how a discovery match score was computed. */
export interface ScoreBreakdown {
  capabilityScore: number
  tagScore: number
  healthAdjustment: number
  slaScore: number
  semanticScore?: number
}

/** A single discovery result with scoring. */
export interface DiscoveryResult {
  agent: RegisteredAgent
  matchScore: number
  scoreBreakdown: ScoreBreakdown
}

/** Paginated discovery result set. */
export interface DiscoveryResultPage {
  results: DiscoveryResult[]
  total: number
  offset: number
  limit: number
}

// ---------------------------------------------------------------------------
// Registry stats & subscriptions
// ---------------------------------------------------------------------------

/** Aggregate statistics about the registry. */
export interface RegistryStats {
  totalAgents: number
  healthyAgents: number
  degradedAgents: number
  unhealthyAgents: number
  capabilityCount: number
  protocolCounts: Record<string, number>
}

/** Event types emitted by the registry. */
export type RegistryEventType =
  | 'registry:agent_registered'
  | 'registry:agent_deregistered'
  | 'registry:agent_updated'
  | 'registry:health_changed'
  | 'registry:capability_added'

/** Filter for registry event subscriptions. */
export interface RegistrySubscriptionFilter {
  agentIds?: string[]
  eventTypes?: RegistryEventType[]
  capabilities?: string[]
}

// ---------------------------------------------------------------------------
// Registry events (W6 fix: typed enums for event fields)
// ---------------------------------------------------------------------------

/** Discriminated union of registry events. */
export type RegistryEvent =
  | { type: 'registry:agent_registered'; agentId: string; name: string }
  | { type: 'registry:agent_deregistered'; agentId: string; reason: DeregistrationReason }
  | { type: 'registry:agent_updated'; agentId: string; fields: string[] }
  | { type: 'registry:health_changed'; agentId: string; previousStatus: AgentHealthStatus; newStatus: AgentHealthStatus }
  | { type: 'registry:capability_added'; agentId: string; capability: string }

// ---------------------------------------------------------------------------
// AgentRegistry interface
// ---------------------------------------------------------------------------

/** Configuration for an AgentRegistry implementation. */
export interface AgentRegistryConfig {
  eventBus?: DzupEventBus
}

/** The AgentRegistry interface — core abstraction for agent registration and discovery. */
export interface AgentRegistry {
  register(input: RegisterAgentInput): Promise<RegisteredAgent>
  deregister(agentId: string, reason?: DeregistrationReason): Promise<void>
  update(agentId: string, changes: Partial<RegisterAgentInput>): Promise<RegisteredAgent>
  discover(query: DiscoveryQuery): Promise<DiscoveryResultPage>
  getAgent(agentId: string): Promise<RegisteredAgent | undefined>
  getHealth(agentId: string): Promise<AgentHealth | undefined>
  updateHealth(agentId: string, health: Partial<AgentHealth>): Promise<void>
  subscribe(
    filter: RegistrySubscriptionFilter,
    handler: (event: RegistryEvent) => void,
  ): { unsubscribe(): void }
  listAgents(limit?: number, offset?: number): Promise<{ agents: RegisteredAgent[]; total: number }>
  registerFromCard(cardUrl: string): Promise<RegisteredAgent>
  evictExpired(): Promise<string[]>
  stats(): Promise<RegistryStats>
}
