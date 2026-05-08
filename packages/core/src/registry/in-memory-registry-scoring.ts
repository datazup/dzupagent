/**
 * Discovery scoring helpers for the in-memory registry.
 *
 * Pure functions that take a `CapabilityMatcher` plus inputs and return a
 * score breakdown. Extracted from `in-memory-registry.ts` so the scoring
 * logic can be reasoned about independently from registry plumbing.
 */
import { compareSemver } from './capability-matcher.js'
import type { CapabilityMatcher } from './capability-matcher.js'
import type {
  AgentHealthStatus,
  DiscoveryQuery,
  RegisteredAgent,
  ScoreBreakdown,
} from './types.js'

/** Check if a query has no filtering criteria (returns all agents). */
export function isUnfilteredQuery(query: DiscoveryQuery): boolean {
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

/** Map a health status to a numeric score used by discovery ranking. */
export function healthScore(status: AgentHealthStatus): number {
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

/** Score an agent against a discovery query. */
export function scoreAgent(
  matcher: CapabilityMatcher,
  agent: RegisteredAgent,
  query: DiscoveryQuery,
): ScoreBreakdown {
  let capabilityScore = 0
  let tagScore = 0
  let slaScore = 1.0

  // Capability prefix matching
  if (query.capabilityPrefix) {
    let bestScore = 0
    for (const cap of agent.capabilities) {
      const score = matcher.match(query.capabilityPrefix, cap.name)
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
  const healthAdjustment = healthScore(agent.health.status)

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

/** Combine a `ScoreBreakdown` into a single weighted match score. */
export function computeMatchScore(breakdown: ScoreBreakdown): number {
  return (
    breakdown.capabilityScore * 0.4 +
    breakdown.tagScore * 0.2 +
    breakdown.healthAdjustment * 0.3 +
    breakdown.slaScore * 0.1
  )
}
