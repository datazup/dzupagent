/**
 * TrustScorer — Computes and maintains trust profiles for agents
 * contributing to the team memory graph.
 *
 * Trust is derived from:
 *  - Contribution success rate (domain-specific)
 *  - Corroboration by other agents
 *  - Recency of activity (decay for inactive agents)
 */

import type { GraphNode, TrustProfile } from './graph-types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INITIAL_TRUST = 0.5
const MIN_TRUST = 0.0
const MAX_TRUST = 1.0

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ---------------------------------------------------------------------------
// TrustScorer
// ---------------------------------------------------------------------------

export class TrustScorer {
  private profiles = new Map<string, TrustProfile>()

  /**
   * Get or create a trust profile for an agent.
   */
  getProfile(agentId: string): TrustProfile {
    const existing = this.profiles.get(agentId)
    if (existing) return existing

    const profile: TrustProfile = {
      agentId,
      overallTrust: DEFAULT_INITIAL_TRUST,
      domainTrust: new Map<string, number>(),
      contributionCount: 0,
      successRate: 0,
      lastActive: new Date(),
    }
    this.profiles.set(agentId, profile)
    return profile
  }

  /**
   * Record a contribution from an agent (success or failure).
   * Updates both overall trust and domain-specific trust.
   */
  recordContribution(agentId: string, domain: string, success: boolean): void {
    const profile = this.getProfile(agentId)

    // Update contribution count and success rate using running average
    const prevTotal = profile.contributionCount
    const prevSuccesses = Math.round(profile.successRate * prevTotal)
    const newSuccesses = prevSuccesses + (success ? 1 : 0)
    const newTotal = prevTotal + 1

    profile.contributionCount = newTotal
    profile.successRate = clamp(newSuccesses / newTotal, MIN_TRUST, MAX_TRUST)

    // Update domain trust using exponential moving average
    const alpha = 0.3 // learning rate
    const currentDomainTrust = profile.domainTrust.get(domain) ?? DEFAULT_INITIAL_TRUST
    const observation = success ? 1.0 : 0.0
    const newDomainTrust = clamp(
      currentDomainTrust * (1 - alpha) + observation * alpha,
      MIN_TRUST,
      MAX_TRUST,
    )
    profile.domainTrust.set(domain, newDomainTrust)

    // Recompute overall trust as weighted average of success rate and mean domain trust
    const domainValues = [...profile.domainTrust.values()]
    const meanDomainTrust =
      domainValues.length > 0
        ? domainValues.reduce((a, b) => a + b, 0) / domainValues.length
        : DEFAULT_INITIAL_TRUST

    profile.overallTrust = clamp(profile.successRate * 0.6 + meanDomainTrust * 0.4, MIN_TRUST, MAX_TRUST)
    profile.lastActive = new Date()
  }

  /**
   * Compute the effective confidence of a knowledge node.
   *
   * Factors:
   *  - Author's trust score (domain-specific if available)
   *  - Original provenance confidence
   *  - Corroboration count (more agents confirming => higher confidence)
   *  - Recency (days since update)
   */
  computeConfidence(node: GraphNode, corroborationCount: number): number {
    const profile = this.getProfile(node.provenance.agentId)

    // Author trust (prefer domain-specific)
    const authorTrust = node.provenance.domain
      ? this.getDomainTrust(node.provenance.agentId, node.provenance.domain)
      : profile.overallTrust

    // Corroboration bonus: diminishing returns via log
    const corroborationBonus = Math.min(0.3, Math.log2(corroborationCount + 1) * 0.1)

    // Recency factor: gentle exponential decay over days
    const daysSinceUpdate = (Date.now() - node.updatedAt.getTime()) / (1000 * 60 * 60 * 24)
    const recencyFactor = Math.exp(-node.decayRate * daysSinceUpdate)

    // Combine factors
    const raw =
      node.provenance.confidence * 0.4 +
      authorTrust * 0.3 +
      corroborationBonus +
      recencyFactor * 0.2

    // Clamp 0.0 – 1.0 and round to avoid floating-point noise
    return clamp(Math.round(raw * 1000) / 1000, MIN_TRUST, MAX_TRUST)
  }

  /**
   * Apply trust decay for all agents that have been inactive.
   * Rate is the fraction of trust lost per day of inactivity.
   */
  applyDecay(rate: number): void {
    const now = Date.now()
    for (const profile of this.profiles.values()) {
      const inactiveDays = (now - profile.lastActive.getTime()) / (1000 * 60 * 60 * 24)
      if (inactiveDays <= 0) continue

      const decayFactor = Math.max(0, 1 - rate * inactiveDays)
      profile.overallTrust = clamp(profile.overallTrust * decayFactor, MIN_TRUST, MAX_TRUST)

      for (const [domain, trust] of profile.domainTrust) {
        profile.domainTrust.set(domain, clamp(trust * decayFactor, MIN_TRUST, MAX_TRUST))
      }
    }
  }

  /**
   * Get domain-specific trust for an agent.
   * Falls back to overall trust when domain has no history.
   */
  getDomainTrust(agentId: string, domain: string): number {
    const profile = this.getProfile(agentId)
    return profile.domainTrust.get(domain) ?? profile.overallTrust
  }

  /**
   * Get all tracked profiles.
   */
  getAllProfiles(): TrustProfile[] {
    return [...this.profiles.values()]
  }

  /**
   * Reset all trust data.
   */
  reset(): void {
    this.profiles.clear()
  }
}
