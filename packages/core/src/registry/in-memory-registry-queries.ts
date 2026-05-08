/**
 * Read-only query helpers for the in-memory registry.
 *
 * `discover` and `stats` are pure functions of the current agent map plus a
 * `CapabilityMatcher`; pulling them out keeps the registry class focused on
 * lifecycle (register / update / deregister / evict) and event fan-out.
 */
import type { CapabilityMatcher } from './capability-matcher.js'
import {
  computeMatchScore,
  isUnfilteredQuery,
  scoreAgent,
} from './in-memory-registry-scoring.js'
import type {
  DiscoveryQuery,
  DiscoveryResult,
  DiscoveryResultPage,
  RegisteredAgent,
  RegistryStats,
} from './types.js'

/**
 * Run a discovery query against an in-memory agent map. Returns a paged
 * result sorted by descending match score.
 */
export function discoverAgents(
  agents: ReadonlyMap<string, RegisteredAgent>,
  matcher: CapabilityMatcher,
  query: DiscoveryQuery,
): DiscoveryResultPage {
  const limit = query.limit ?? 10
  const offset = query.offset ?? 0
  const unfiltered = isUnfilteredQuery(query)

  const scored: DiscoveryResult[] = []

  for (const agent of agents.values()) {
    // Health filter
    if (query.healthFilter && query.healthFilter.length > 0) {
      if (!query.healthFilter.includes(agent.health.status)) continue
    }

    // Protocol filter
    if (query.protocols && query.protocols.length > 0) {
      const hasProtocol = query.protocols.some((p) => agent.protocols.includes(p))
      if (!hasProtocol) continue
    }

    const breakdown = scoreAgent(matcher, agent, query)
    const matchScore = computeMatchScore(breakdown)

    if (matchScore > 0 || unfiltered) {
      scored.push({
        agent: { ...agent },
        matchScore,
        scoreBreakdown: breakdown,
      })
    }
  }

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

/** Compute aggregate `RegistryStats` from the current agent map. */
export function computeRegistryStats(
  agents: ReadonlyMap<string, RegisteredAgent>,
): RegistryStats {
  let healthy = 0
  let degraded = 0
  let unhealthy = 0
  const capabilityNames = new Set<string>()
  const protocolCounts: Record<string, number> = {}

  for (const agent of agents.values()) {
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
    totalAgents: agents.size,
    healthyAgents: healthy,
    degradedAgents: degraded,
    unhealthyAgents: unhealthy,
    capabilityCount: capabilityNames.size,
    protocolCounts,
  }
}

/**
 * Find agents whose TTL has expired relative to `now`. Pure: does not mutate
 * the map. The caller is responsible for actually deleting and emitting
 * deregistration events.
 */
export function findExpiredAgents(
  agents: ReadonlyMap<string, RegisteredAgent>,
  now: number,
): string[] {
  const evicted: string[] = []
  for (const [id, agent] of agents.entries()) {
    if (agent.ttlMs !== undefined) {
      const expiresAt = agent.registeredAt.getTime() + agent.ttlMs
      if (expiresAt < now) {
        evicted.push(id)
      }
    }
  }
  return evicted
}
