/**
 * Context token lifecycle manager.
 *
 * Tracks token budget consumption per conversation phase, classifies
 * pressure against warn/critical thresholds, and emits compression
 * recommendations when approaching model context limits.
 *
 * This module is stateful but entirely in-memory — attach one manager
 * per run / per conversation.
 *
 * @example
 * ```ts
 * const mgr = new TokenLifecycleManager({
 *   budget: createTokenBudget(200_000, 4_096),
 * })
 * mgr.track('system-prompt', 1200)
 * mgr.track('history', 45_000)
 * if (mgr.status === 'warn') {
 *   // compress before next turn
 * }
 * console.log(mgr.report.recommendation)
 * ```
 */

export interface TokenBudget {
  /** Total context window tokens (e.g. model limit) */
  total: number
  /** Tokens reserved for output — subtracted from available */
  reserved: number
  /** Computed: total - reserved (never negative) */
  available: number
}

export interface TokenPhaseUsage {
  /** Phase label (e.g. 'system-prompt', 'history', 'tool-output') */
  phase: string
  /** Tokens charged to this phase (single track() call) */
  tokens: number
  /** Wall-clock timestamp (ms since epoch) */
  timestamp: number
}

export interface TokenLifecycleConfig {
  budget: TokenBudget
  /** 0..1 — warn when pct >= this. Default 0.8 */
  warnThresholdPct?: number
  /** 0..1 — critical when pct >= this. Default 0.95 */
  criticalThresholdPct?: number
}

export type TokenLifecycleStatus = 'ok' | 'warn' | 'critical' | 'exhausted'

export interface TokenLifecycleReport {
  used: number
  available: number
  /** usedTokens / available, clamped to [0, 1] */
  pct: number
  status: TokenLifecycleStatus
  phases: TokenPhaseUsage[]
  recommendation?: string
}

/**
 * Pluggable token counter. Implementations may use chars/4 heuristics
 * (cheap, imprecise) or real model-specific encoders (e.g. `js-tiktoken`).
 *
 * Call sites that need to budget tokens should accept an optional
 * `TokenCounter` so downstream consumers can opt in to precise counting
 * without pulling heavyweight deps into this package.
 */
export interface TokenCounter {
  /**
   * Count tokens for a piece of text.
   * @param text  The text to count.
   * @param model Optional model identifier (e.g. `gpt-4o-mini`). Counters
   *              that support model-specific vocabularies should use it;
   *              heuristic counters may ignore it.
   */
  count(text: string, model?: string): number
}

const DEFAULT_WARN = 0.8
const DEFAULT_CRITICAL = 0.95

const RECOMMENDATIONS: Record<TokenLifecycleStatus, string | undefined> = {
  ok: undefined,
  warn: 'Consider compressing conversation history',
  critical: 'Compress or truncate history immediately',
  exhausted: 'Context window exhausted — must compress before next call',
}

/**
 * Create a {@link TokenBudget}. Convenience factory to avoid computing
 * `available` by hand.
 */
export function createTokenBudget(total: number, reserved: number): TokenBudget {
  const available = Math.max(0, total - reserved)
  return { total, reserved, available }
}

export class TokenLifecycleManager {
  private readonly budget: TokenBudget
  private readonly warnThresholdPct: number
  private readonly criticalThresholdPct: number
  private readonly _phases: TokenPhaseUsage[] = []
  private _used = 0

  constructor(config: TokenLifecycleConfig) {
    this.budget = config.budget
    this.warnThresholdPct = config.warnThresholdPct ?? DEFAULT_WARN
    this.criticalThresholdPct = config.criticalThresholdPct ?? DEFAULT_CRITICAL
  }

  /** Record that a phase consumed the given number of tokens. */
  track(phase: string, tokens: number): void {
    this._phases.push({ phase, tokens, timestamp: Date.now() })
    this._used += tokens
  }

  /** Total tokens tracked so far across all phases. */
  get usedTokens(): number {
    return this._used
  }

  /** Remaining headroom in the budget (never negative). */
  get remainingTokens(): number {
    return Math.max(0, this.budget.available - this._used)
  }

  /** Current status classification based on used/available ratio. */
  get status(): TokenLifecycleStatus {
    if (this.budget.available <= 0) return 'exhausted'
    if (this._used >= this.budget.available) return 'exhausted'
    const pct = this._used / this.budget.available
    if (pct >= this.criticalThresholdPct) return 'critical'
    if (pct >= this.warnThresholdPct) return 'warn'
    return 'ok'
  }

  /** Structured report snapshot. */
  get report(): TokenLifecycleReport {
    const status = this.status
    const pct = this.budget.available <= 0
      ? 1
      : Math.min(1, this._used / this.budget.available)
    const report: TokenLifecycleReport = {
      used: this._used,
      available: this.budget.available,
      pct,
      status,
      phases: [...this._phases],
    }
    const rec = RECOMMENDATIONS[status]
    if (rec !== undefined) report.recommendation = rec
    return report
  }

  /** Clear all tracked usage — resets to a fresh state. */
  reset(): void {
    this._phases.length = 0
    this._used = 0
  }
}
