/**
 * Guardrail and iteration budget types for agent safety boundaries.
 */

import type { StuckDetectorConfig } from './stuck-detector.js'
import type { RateLimiterClient } from './distributed-rate-limiter.js'
import type { CostLedgerClient } from './distributed-budget.js'

/** Configuration for agent guardrails */
export interface GuardrailConfig {
  /** Maximum total input + output tokens across all LLM calls */
  maxTokens?: number
  /** Maximum spend in cents across all LLM calls */
  maxCostCents?: number
  /** Maximum tool-call loop iterations (overrides DzupAgentConfig.maxIterations) */
  maxIterations?: number
  /** Tool names that this agent is forbidden from calling */
  blockedTools?: string[]
  /** Thresholds (0-1) at which budget warnings are emitted (default: [0.7, 0.9]) */
  budgetWarnings?: number[]
  /** Content filter applied to the agent's final output */
  outputFilter?: (output: string) => Promise<string | null>
  /**
   * Stuck detector configuration. When provided, these thresholds override
   * the StuckDetector defaults (maxRepeatCalls=3, maxErrorsInWindow=5, etc.).
   * Set to `false` to disable stuck detection entirely.
   */
  stuckDetector?: Partial<StuckDetectorConfig> | false

  /**
   * Distributed rate limit + cost ledger (MC-07).
   *
   * When set, agents enrolled in a multi-instance fleet share the
   * configured ceilings via Redis (or any structurally compatible
   * key/value store) instead of each replica holding its own in-process
   * counter. Both fields are optional — callers can opt into one
   * without the other.
   *
   * The `client` field is structurally typed (`RateLimiterClient` /
   * `CostLedgerClient`) so callers inject `ioredis`, `node-redis`, or a
   * test mock without dragging a Redis dependency into this package.
   *
   * On Redis errors the limiter and ledger fall back gracefully — see
   * `DistributedRateLimiter` / `DistributedCostLedger` for the exact
   * fail-open / fail-local semantics.
   */
  distributed?: DistributedGuardrailConfig
}

/** Configuration for distributed (Redis-backed) guardrails. */
export interface DistributedGuardrailConfig {
  /** Per-tenant + per-agent fixed-window rate limit. */
  rateLimiter?: {
    client: RateLimiterClient
    /** Window length in milliseconds (default: 60_000). */
    windowMs?: number
    /** Max requests per window (default: 60). */
    maxRequests?: number
    /** Key prefix (default: `'dzupagent:rl'`). */
    keyPrefix?: string
  }
  /** Per-tenant + per-agent cumulative cost ceiling. */
  costLedger?: {
    client: CostLedgerClient
    /** Hard ceiling in USD (default: Infinity). */
    maxCostUsd?: number
    /** Key TTL in milliseconds (default: 24 h). */
    ttlMs?: number
    /** Key prefix (default: `'dzupagent:cost'`). */
    keyPrefix?: string
  }
}

/** Budget tracking state shared across parent and child agents */
export interface BudgetState {
  totalInputTokens: number
  totalOutputTokens: number
  totalCostCents: number
  llmCalls: number
  iterations: number
  warnings: BudgetWarning[]
}

/** A budget warning emitted when a threshold is crossed */
export interface BudgetWarning {
  type: 'tokens' | 'cost' | 'iterations'
  threshold: number
  current: number
  limit: number
  message: string
}
