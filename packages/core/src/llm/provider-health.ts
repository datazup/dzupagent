/**
 * Provider health tracking for weighted provider selection.
 *
 * Complements the binary {@link CircuitBreaker} (open/closed/half-open health)
 * with a continuous success-rate signal per provider key. The circuit breaker
 * answers "is this provider allowed to receive traffic right now?"; the health
 * tracker answers "among the providers that ARE allowed, which has historically
 * been the most reliable?".
 *
 * This is an EMA (exponentially weighted moving average) of success/failure
 * outcomes only — no latency is tracked in this pass. State is in-memory and
 * resets on process restart, matching the {@link ModelRegistry} lifetime.
 *
 * The tracker is intentionally passive: it never blocks a provider. It only
 * produces a weight in [0, 1] used as a tie-breaker WITHIN a priority tier when
 * the registry is in `'weighted'` selection mode. During warm-up (before
 * `minSamples` observations) it returns a neutral weight of 1.0 so a
 * cold provider is never penalised for lack of history.
 */

/** Configuration for {@link ProviderHealthTracker}. */
export interface ProviderHealthConfig {
  /**
   * EMA smoothing factor in (0, 1] (default: 0.2). Higher values weight recent
   * outcomes more heavily; lower values produce a smoother, slower-moving
   * success rate. `s = alpha * outcome + (1 - alpha) * s`.
   */
  alpha?: number;
  /**
   * Minimum number of observations before {@link ProviderHealthTracker.getWeight}
   * returns the measured success rate (default: 5). Below this threshold the
   * weight is the neutral value 1.0 so a cold provider is not down-ranked for
   * lack of history.
   */
  minSamples?: number;
}

const DEFAULT_ALPHA = 0.2;
const DEFAULT_MIN_SAMPLES = 5;
/** Neutral weight returned during warm-up (treated as fully healthy). */
const NEUTRAL_WEIGHT = 1.0;

interface HealthEntry {
  /** EMA of success outcomes in [0, 1]. */
  successRate: number;
  /** Number of recorded outcomes (success + failure). */
  samples: number;
  /** Epoch ms of the last recorded outcome. */
  lastUpdated: number;
}

/** A read-only snapshot entry for diagnostics. */
export interface ProviderHealthSnapshotEntry {
  successRate: number;
  samples: number;
}

/**
 * Tracks a per-provider-key EMA success rate. Not persisted; resets on restart.
 */
export class ProviderHealthTracker {
  private readonly entries = new Map<string, HealthEntry>();
  private readonly alpha: number;
  private readonly minSamples: number;

  constructor(config?: ProviderHealthConfig) {
    // Clamp alpha into (0, 1]; a non-positive or NaN alpha would freeze the EMA.
    const rawAlpha = config?.alpha ?? DEFAULT_ALPHA;
    this.alpha =
      Number.isFinite(rawAlpha) && rawAlpha > 0
        ? Math.min(rawAlpha, 1)
        : DEFAULT_ALPHA;
    const rawMin = config?.minSamples ?? DEFAULT_MIN_SAMPLES;
    this.minSamples =
      Number.isFinite(rawMin) && rawMin >= 0
        ? Math.floor(rawMin)
        : DEFAULT_MIN_SAMPLES;
  }

  /** Record a successful invocation for the provider key. */
  recordSuccess(key: string): void {
    this.update(key, 1);
  }

  /** Record a failed invocation for the provider key. */
  recordFailure(key: string): void {
    this.update(key, 0);
  }

  private update(key: string, outcome: 0 | 1): void {
    const existing = this.entries.get(key);
    if (!existing) {
      // Seed the EMA with the first observed outcome so it is unbiased.
      this.entries.set(key, {
        successRate: outcome,
        samples: 1,
        lastUpdated: Date.now(),
      });
      return;
    }
    existing.successRate =
      this.alpha * outcome + (1 - this.alpha) * existing.successRate;
    existing.samples += 1;
    existing.lastUpdated = Date.now();
  }

  /**
   * Weight in [0, 1] used as a within-priority-tier tie-breaker. Returns the
   * neutral value 1.0 until at least `minSamples` observations have accrued.
   */
  getWeight(key: string): number {
    const entry = this.entries.get(key);
    if (!entry || entry.samples < this.minSamples) return NEUTRAL_WEIGHT;
    return entry.successRate;
  }

  /** Read-only snapshot of tracked providers for diagnostics. */
  snapshot(): Record<string, ProviderHealthSnapshotEntry> {
    const out: Record<string, ProviderHealthSnapshotEntry> = {};
    for (const [key, entry] of this.entries) {
      out[key] = { successRate: entry.successRate, samples: entry.samples };
    }
    return out;
  }
}
