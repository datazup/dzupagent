/**
 * Core evaluation types.
 *
 * As of MC-A02 the shared subset (EvalResult, EvalScorer, EvalCase, EvalSuite,
 * EvalRunResult) is canonically defined in @dzupagent/eval-contracts so that
 * @dzupagent/server (Layer 4) can reference the contracts without a runtime
 * dependency on @dzupagent/evals (Layer 5). This module re-exports them so
 * existing consumers of @dzupagent/evals continue to compile unchanged.
 */

export type {
  EvalResult,
  EvalScorer,
  EvalCase,
  EvalSuite,
  EvalRunResult,
} from '@dzupagent/eval-contracts';

// --- Enhanced Scorer Types (ECO-111) ---

/**
 * Enhanced evaluation input with metadata for richer scoring.
 */
export interface EvalInput {
  input: string;
  output: string;
  reference?: string | undefined;
  tags?: string[] | undefined;
  latencyMs?: number | undefined;
  costCents?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Configuration for an enhanced scorer.
 */
export interface ScorerConfig {
  id: string;
  name: string;
  description?: string | undefined;
  type: 'deterministic' | 'llm-judge' | 'composite' | 'custom';
  threshold?: number | undefined;
  version?: string | undefined;
}

/**
 * Result from an enhanced scorer, with per-criterion breakdown.
 */
export interface ScorerResult {
  scorerId: string;
  scores: Array<{ criterion: string; score: number; reasoning: string }>;
  aggregateScore: number;
  passed: boolean;
  durationMs: number;
  costCents?: number | undefined;
}

/**
 * Enhanced scorer interface with typed config and rich results.
 */
export interface Scorer<TInput = EvalInput> {
  readonly config: ScorerConfig;
  score(input: TInput): Promise<ScorerResult>;
}
