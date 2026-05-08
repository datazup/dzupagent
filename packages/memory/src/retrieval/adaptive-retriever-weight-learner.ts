/**
 * Dynamic weight learning for the adaptive retriever.
 *
 * Uses an exponential moving average (EMA) over feedback signals to nudge
 * intent-specific weight vectors toward configurations that produced better
 * results. Weights are clamped to [minWeight, maxWeight] and renormalized.
 */

import type { QueryIntent, RetrievalWeights } from './adaptive-retriever-types.js';
import { SOURCE_NAMES } from './adaptive-retriever-types.js';

/** Configuration for the weight learner */
export interface WeightLearnerConfig {
  /** EMA learning rate (default: 0.05) */
  learningRate?: number | undefined;
  /** Minimum weight for any provider (default: 0.05) */
  minWeight?: number | undefined;
  /** Maximum weight for any provider (default: 0.8) */
  maxWeight?: number | undefined;
}

/** Feedback quality rating for a search result */
export type FeedbackQuality = 'good' | 'bad' | 'mixed';

/** Internal record of feedback for a given intent */
interface IntentFeedbackState {
  /** Accumulated EMA-adjusted weights */
  weights: RetrievalWeights;
  /** Number of feedback signals received */
  count: number;
}

/**
 * Learns retrieval weight adjustments from search quality feedback
 * using exponential moving average (EMA).
 *
 * When 'good' feedback is received, the current weights are reinforced.
 * When 'bad' feedback is received, weights shift toward alternatives.
 * When 'mixed' feedback is received, a smaller adjustment is made.
 *
 * All weights are clamped to [minWeight, maxWeight] and renormalized to sum to ~1.0.
 */
export class WeightLearner {
  readonly learningRate: number;
  private readonly minWeight: number;
  private readonly maxWeight: number;
  private readonly state = new Map<QueryIntent, IntentFeedbackState>();

  constructor(config: WeightLearnerConfig = {}) {
    this.learningRate = config.learningRate ?? 0.05;
    this.minWeight = config.minWeight ?? 0.05;
    this.maxWeight = config.maxWeight ?? 0.8;
  }

  /**
   * Record feedback for a search. Adjusts the learned weights for the given intent.
   *
   * @param intent  The classified query intent
   * @param currentWeights  The weights that were used for this search
   * @param quality  Quality rating of the results
   */
  recordFeedback(
    intent: QueryIntent,
    currentWeights: RetrievalWeights,
    quality: FeedbackQuality,
  ): void {
    const existing = this.state.get(intent);
    const targetWeights = this.computeTarget(currentWeights, quality);

    if (!existing) {
      // First feedback — initialize directly from the target
      this.state.set(intent, {
        weights: this.clampAndNormalize(targetWeights),
        count: 1,
      });
      return;
    }

    // EMA update: learned = (1 - alpha) * learned + alpha * target
    const alpha = this.learningRate;
    const updated: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };
    for (const s of SOURCE_NAMES) {
      updated[s] = (1 - alpha) * existing.weights[s] + alpha * targetWeights[s];
    }

    existing.weights = this.clampAndNormalize(updated);
    existing.count += 1;
  }

  /**
   * Get the current learned weight adjustments for all intents that have received feedback.
   */
  getAdjustments(): Map<QueryIntent, RetrievalWeights> {
    const result = new Map<QueryIntent, RetrievalWeights>();
    for (const [intent, feedbackState] of this.state) {
      result.set(intent, { ...feedbackState.weights });
    }
    return result;
  }

  /**
   * Get learned weights for a specific intent, or undefined if no feedback has been recorded.
   */
  getIntentAdjustment(intent: QueryIntent): RetrievalWeights | undefined {
    const feedbackState = this.state.get(intent);
    if (!feedbackState) return undefined;
    return { ...feedbackState.weights };
  }

  /** Clear all learned adjustments */
  reset(): void {
    this.state.clear();
  }

  /**
   * Blend raw (default) weights with learned weights.
   * Returns: (1 - blendRate) * rawWeights + blendRate * learnedWeights
   */
  blend(rawWeights: RetrievalWeights, intent: QueryIntent, blendRate: number): RetrievalWeights {
    const learned = this.getIntentAdjustment(intent);
    if (!learned) return { ...rawWeights };

    const blended: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };
    for (const s of SOURCE_NAMES) {
      blended[s] = (1 - blendRate) * rawWeights[s] + blendRate * learned[s];
    }
    return this.clampAndNormalize(blended);
  }

  /**
   * Compute a target weight vector based on feedback quality.
   *
   * - 'good': reinforce current weights (push them further in their direction)
   * - 'bad': shift toward equal distribution (dampen dominant weights)
   * - 'mixed': small shift toward equal distribution
   */
  private computeTarget(currentWeights: RetrievalWeights, quality: FeedbackQuality): RetrievalWeights {
    const equal = 1 / SOURCE_NAMES.length;
    const target: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };

    switch (quality) {
      case 'good': {
        // Reinforce: amplify deviation from equal
        for (const s of SOURCE_NAMES) {
          const deviation = currentWeights[s] - equal;
          target[s] = currentWeights[s] + deviation * 0.2;
        }
        break;
      }
      case 'bad': {
        // Dampen: shift toward equal weights (away from current)
        for (const s of SOURCE_NAMES) {
          target[s] = currentWeights[s] * 0.6 + equal * 0.4;
        }
        break;
      }
      case 'mixed': {
        // Small shift toward equal
        for (const s of SOURCE_NAMES) {
          target[s] = currentWeights[s] * 0.85 + equal * 0.15;
        }
        break;
      }
    }

    return target;
  }

  /**
   * Clamp each weight to [minWeight, maxWeight] and renormalize so they sum to ~1.0.
   */
  private clampAndNormalize(weights: RetrievalWeights): RetrievalWeights {
    const clamped: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };

    for (const s of SOURCE_NAMES) {
      clamped[s] = Math.max(this.minWeight, Math.min(this.maxWeight, weights[s]));
    }

    const sum = SOURCE_NAMES.reduce((acc, s) => acc + clamped[s], 0);
    if (sum > 0) {
      for (const s of SOURCE_NAMES) {
        clamped[s] = clamped[s] / sum;
      }
    }

    // Re-clamp after normalization (edge case: normalization could push beyond bounds)
    for (const s of SOURCE_NAMES) {
      clamped[s] = Math.max(this.minWeight, Math.min(this.maxWeight, clamped[s]));
    }

    // Final normalization pass
    const finalSum = SOURCE_NAMES.reduce((acc, s) => acc + clamped[s], 0);
    if (finalSum > 0 && Math.abs(finalSum - 1.0) > 1e-10) {
      for (const s of SOURCE_NAMES) {
        clamped[s] = clamped[s] / finalSum;
      }
    }

    return clamped;
  }
}
