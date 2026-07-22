/**
 * Bid strategy implementations for ContractNetOrchestrator.
 *
 * Strategies generate per-provider bids for a given task. The default
 * `StaticBidStrategy` uses static cost/duration tables and tag-based
 * confidence scoring (mirrored from TagBasedRouter).
 */

import type { AdapterProviderId, TaskDescriptor } from "../types.js";
import type {
  Bid,
  BidSelectionCriteria,
  BidStrategy,
} from "./contract-net-types.js";

// ---------------------------------------------------------------------------
// Tag sets (mirrored from TagBasedRouter for confidence scoring)
// ---------------------------------------------------------------------------

const REASONING_TAGS = new Set([
  "reasoning",
  "review",
  "architecture",
  "design",
  "analysis",
  "planning",
  "refactor",
  "explain",
]);

const EXECUTION_TAGS = new Set([
  "fix-tests",
  "implement",
  "execute",
  "code",
  "build",
  "debug",
  "test",
  "migrate",
]);

const LOCAL_TAGS = new Set([
  "local",
  "offline",
  "private",
  "fast",
  "simple",
  "quick",
]);

// ---------------------------------------------------------------------------
// Static cost and speed tables
// ---------------------------------------------------------------------------

/**
 * Approximate cost in cents per estimated 10K tokens.
 *
 * ARCH-M-08 note: this is an intentionally *coarse ordinal ranking* heuristic
 * for contract-net bid scoring, NOT real per-token pricing. It is deliberately
 * kept separate from the canonical `PROVIDER_RATE_TABLE`
 * (`@dzupagent/core/middleware`, cents per 1M tokens): these integers are
 * ranking weights consumed by `scoreBid`'s `1 / (cost + 1)` inversion and are
 * asserted verbatim by `contract-net.test.ts` (claude=5, crush=1). Deriving
 * them from the real 1M-token rates would change bid economics and break those
 * locked tests, so the two tables diverge on purpose. Keep the *ordering* here
 * consistent with the canonical input-rate ordering when editing.
 */
const COST_PER_10K_TOKENS: Record<AdapterProviderId, number> = {
  ollama: 0,
  crush: 1,
  goose: 1,
  qwen: 2,
  gemini: 3,
  "gemini-sdk": 3,
  codex: 4,
  claude: 5,
  openrouter: 5,
  openai: 4,
};

/** Default estimated duration in ms for a standard task. */
const DEFAULT_DURATION_MS: Record<AdapterProviderId, number> = {
  ollama: 3_000,
  crush: 2_000,
  goose: 3_000,
  qwen: 3_000,
  gemini: 4_000,
  "gemini-sdk": 4_000,
  codex: 5_000,
  claude: 5_000,
  openrouter: 5_000,
  openai: 4_000,
};

// ---------------------------------------------------------------------------
// StaticBidStrategy
// ---------------------------------------------------------------------------

/**
 * Default bid strategy that generates bids from static heuristics.
 *
 * - Cost: per-provider cost ranking
 * - Confidence: tag matching (reasoning -> claude, execution -> codex,
 *   local -> crush/qwen)
 * - Duration: estimated from static defaults
 */
export class StaticBidStrategy implements BidStrategy {
  readonly name = "static";

  async generateBids(
    task: TaskDescriptor,
    availableProviders: AdapterProviderId[]
  ): Promise<Bid[]> {
    const tags = task.tags.map((t) => t.toLowerCase());
    const isReasoning =
      task.requiresReasoning === true ||
      tags.some((t) => REASONING_TAGS.has(t));
    const isExecution =
      task.requiresExecution === true ||
      tags.some((t) => EXECUTION_TAGS.has(t));
    const isLocal = tags.some((t) => LOCAL_TAGS.has(t));

    return availableProviders.map((providerId) => {
      const estimatedCostCents = COST_PER_10K_TOKENS[providerId];
      const estimatedDurationMs = DEFAULT_DURATION_MS[providerId];
      const confidence = this.computeConfidence(
        providerId,
        isReasoning,
        isExecution,
        isLocal
      );

      return {
        providerId,
        estimatedCostCents,
        confidence,
        estimatedDurationMs,
        approach: this.describeApproach(providerId, isReasoning, isExecution),
      };
    });
  }

  private computeConfidence(
    providerId: AdapterProviderId,
    isReasoning: boolean,
    isExecution: boolean,
    isLocal: boolean
  ): number {
    // Base confidence
    let confidence = 0.5;

    if (isReasoning) {
      if (providerId === "claude") confidence = 0.95;
      else if (providerId === "gemini") confidence = 0.75;
      else if (providerId === "codex") confidence = 0.6;
      else confidence = 0.4;
    } else if (isExecution) {
      if (providerId === "codex") confidence = 0.9;
      else if (providerId === "claude") confidence = 0.8;
      else if (providerId === "gemini") confidence = 0.7;
      else confidence = 0.5;
    } else if (isLocal) {
      if (providerId === "crush") confidence = 0.85;
      else if (providerId === "qwen") confidence = 0.8;
      else confidence = 0.5;
    }

    return confidence;
  }

  private describeApproach(
    providerId: AdapterProviderId,
    isReasoning: boolean,
    isExecution: boolean
  ): string {
    if (isReasoning) {
      return `${providerId}: deep reasoning and analysis approach`;
    }
    if (isExecution) {
      return `${providerId}: direct implementation approach`;
    }
    return `${providerId}: general-purpose approach`;
  }
}

// ---------------------------------------------------------------------------
// Bid scoring
// ---------------------------------------------------------------------------

/**
 * Score a bid using the given criteria. Higher score is better.
 *
 * The score is a weighted sum of:
 * - Cost score: inversely proportional to estimated cost
 * - Confidence score: the bid's confidence value directly
 * - Speed score: inversely proportional to estimated duration
 */
export function scoreBid(bid: Bid, criteria: BidSelectionCriteria): number {
  if (criteria.customScorer) {
    return criteria.customScorer(bid);
  }

  const costWeight = criteria.costWeight ?? 0.3;
  const confidenceWeight = criteria.confidenceWeight ?? 0.5;
  const speedWeight = criteria.speedWeight ?? 0.2;

  // Cost score: invert so lower cost = higher score. +1 to avoid div/0.
  const costScore = 1 / (bid.estimatedCostCents + 1);

  // Confidence score is already 0-1
  const confidenceScore = bid.confidence;

  // Speed score: invert so lower duration = higher score. +1 to avoid div/0.
  const durationMs = bid.estimatedDurationMs ?? 5_000;
  const speedScore = 1_000 / (durationMs + 1);

  return (
    costScore * costWeight +
    confidenceScore * confidenceWeight +
    speedScore * speedWeight
  );
}
