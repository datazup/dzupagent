/**
 * Model Tier Escalation Policy
 *
 * Tracks consecutive low-quality reflection scores per agent/intent key
 * and recommends escalating to a higher model tier when quality is
 * persistently below threshold.
 */
import type { ModelTier } from '../llm/model-config.js'

/** Configuration for the escalation policy */
export interface EscalationPolicyConfig {
  /** Score threshold below which a run counts as "low quality" (default: 0.5) */
  lowScoreThreshold?: number
  /** Number of consecutive low scores before escalation triggers (default: 3) */
  consecutiveCount?: number
  /** Cooldown period after escalation in ms (default: 300_000 = 5 min) */
  cooldownMs?: number
  /** Tier escalation chain, ordered from cheapest to most capable (default: ['chat', 'codegen', 'reasoning']) */
  tierChain?: ModelTier[]
}

/** Result returned by recordScore */
export interface EscalationResult {
  /** Whether tier escalation is recommended */
  shouldEscalate: boolean
  /** Current tier the agent is on */
  fromTier: ModelTier
  /** Recommended tier to escalate to */
  toTier: ModelTier
  /** Human-readable reason for the decision */
  reason: string
  /** How many consecutive low scores have been recorded */
  consecutiveLowScores: number
}

interface TrackedEntry {
  scores: number[]
  currentTier: ModelTier
  lastEscalatedAt: number
}

const DEFAULTS = {
  lowScoreThreshold: 0.5,
  consecutiveCount: 3,
  cooldownMs: 300_000,
  tierChain: ['chat', 'codegen', 'reasoning'] as ModelTier[],
} as const

export class ModelTierEscalationPolicy {
  private readonly lowScoreThreshold: number
  private readonly consecutiveCount: number
  private readonly cooldownMs: number
  private readonly tierChain: readonly ModelTier[]
  private readonly scoreHistory: Map<string, TrackedEntry> = new Map()

  constructor(config?: EscalationPolicyConfig) {
    this.lowScoreThreshold = config?.lowScoreThreshold ?? DEFAULTS.lowScoreThreshold
    this.consecutiveCount = config?.consecutiveCount ?? DEFAULTS.consecutiveCount
    this.cooldownMs = config?.cooldownMs ?? DEFAULTS.cooldownMs
    this.tierChain = config?.tierChain ?? DEFAULTS.tierChain
  }

  /**
   * Record a reflection score for a given key (e.g. agentId or agentId:intent).
   *
   * Returns an EscalationResult indicating whether the agent should be
   * moved to a higher model tier.
   */
  recordScore(key: string, score: number, currentTier: ModelTier): EscalationResult {
    let entry = this.scoreHistory.get(key)
    if (!entry) {
      entry = { scores: [], currentTier, lastEscalatedAt: 0 }
      this.scoreHistory.set(key, entry)
    }

    entry.currentTier = currentTier

    // A score at or above threshold is "good" — reset the consecutive streak
    if (score >= this.lowScoreThreshold) {
      entry.scores = []
      return {
        shouldEscalate: false,
        fromTier: currentTier,
        toTier: currentTier,
        reason: 'score above threshold',
        consecutiveLowScores: 0,
      }
    }

    // Low score — append and keep only the last N
    entry.scores.push(score)
    if (entry.scores.length > this.consecutiveCount) {
      entry.scores = entry.scores.slice(-this.consecutiveCount)
    }

    const consecutiveLow = entry.scores.length

    // Not enough consecutive low scores yet
    if (consecutiveLow < this.consecutiveCount) {
      return {
        shouldEscalate: false,
        fromTier: currentTier,
        toTier: currentTier,
        reason: `${consecutiveLow}/${this.consecutiveCount} consecutive low scores`,
        consecutiveLowScores: consecutiveLow,
      }
    }

    // Already at highest tier in the chain
    const currentIndex = this.tierChain.indexOf(currentTier)
    if (currentIndex === -1 || currentIndex >= this.tierChain.length - 1) {
      return {
        shouldEscalate: false,
        fromTier: currentTier,
        toTier: currentTier,
        reason: 'already at highest tier',
        consecutiveLowScores: consecutiveLow,
      }
    }

    // Check cooldown
    const now = Date.now()
    if (now - entry.lastEscalatedAt < this.cooldownMs) {
      return {
        shouldEscalate: false,
        fromTier: currentTier,
        toTier: currentTier,
        reason: 'escalation cooldown active',
        consecutiveLowScores: consecutiveLow,
      }
    }

    // Escalate to next tier
    const nextTier = this.tierChain[currentIndex + 1]!
    entry.lastEscalatedAt = now
    entry.scores = [] // reset after escalation

    return {
      shouldEscalate: true,
      fromTier: currentTier,
      toTier: nextTier,
      reason: `${this.consecutiveCount} consecutive scores below ${this.lowScoreThreshold}`,
      consecutiveLowScores: consecutiveLow,
    }
  }

  /** Reset tracking for a key */
  reset(key: string): void {
    this.scoreHistory.delete(key)
  }

  /** Get current consecutive low score count for a key (0 if not tracked) */
  getConsecutiveLowCount(key: string): number {
    return this.scoreHistory.get(key)?.scores.length ?? 0
  }
}
