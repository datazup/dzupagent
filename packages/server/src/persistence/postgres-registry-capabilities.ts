/**
 * PostgresRegistry capabilities — ECO-048/049.
 *
 * Capability/tag/health/SLA scoring helpers used during discovery queries.
 */

import type { AgentHealthStatus, DiscoveryQuery, RegisteredAgent, ScoreBreakdown } from '@dzupagent/core/pipeline'

export function isUnfilteredQuery(query: DiscoveryQuery): boolean {
  return (
    !query.capabilityPrefix && !query.capabilityExact && !query.semanticQuery &&
    (!query.tags || query.tags.length === 0) &&
    (!query.healthFilter || query.healthFilter.length === 0) &&
    (!query.protocols || query.protocols.length === 0) &&
    !query.slaFilter
  )
}

export function healthScore(status: AgentHealthStatus): number {
  switch (status) {
    case 'healthy': return 1.0
    case 'degraded': return 0.5
    case 'unhealthy': return 0.1
    case 'unknown': return 0.3
  }
}

export function scoreAgent(agent: RegisteredAgent, query: DiscoveryQuery): ScoreBreakdown {
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

  const healthAdjustment = healthScore(agent.health.status)

  if (query.slaFilter && agent.sla) {
    let met = 0, checks = 0
    if (query.slaFilter.maxLatencyMs !== undefined && agent.sla.maxLatencyMs !== undefined) {
      checks++; if (agent.sla.maxLatencyMs <= query.slaFilter.maxLatencyMs) met++
    }
    if (checks > 0) slaScore = met / checks
  }

  return { capabilityScore, tagScore, healthAdjustment, slaScore }
}
