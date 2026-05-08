/**
 * PromptOptimizer types — public configuration, result shapes, and the
 * internal `EvalOutcome` shared by generator/evaluator/persistence helpers.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { EvalInput, Scorer } from '../types.js';
import type { PromptVersion, PromptVersionStore } from './prompt-version-store.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OptimizerConfig {
  /** LLM for generating prompt rewrites */
  metaModel: BaseChatModel;
  /** LLM for generating outputs during eval */
  evalModel: BaseChatModel;
  /** Scorers to evaluate prompt quality */
  scorers: Scorer<EvalInput>[];
  /** Version store for persisting prompts */
  versionStore: PromptVersionStore;
  /** Max candidates to generate per optimization round (default: 3) */
  maxCandidates?: number;
  /** Max optimization rounds (default: 3) */
  maxRounds?: number;
  /** Minimum improvement to accept a new version (default: 0.02) */
  minImprovement?: number;
  /** Abort signal */
  signal?: AbortSignal;
}

export interface OptimizationCandidate {
  content: string;
  avgScore: number;
  passRate: number;
  reasoning: string;
}

export interface OptimizationResult {
  /** Was the prompt improved? */
  improved: boolean;
  /** Original prompt version */
  originalVersion: PromptVersion;
  /** Best prompt version found (may be the original if no improvement) */
  bestVersion: PromptVersion;
  /** Score improvement (best - original) */
  scoreImprovement: number;
  /** All candidates evaluated */
  candidates: OptimizationCandidate[];
  /** Number of rounds executed */
  rounds: number;
  /** Exit reason */
  exitReason: 'improved' | 'no_improvement' | 'max_rounds' | 'aborted' | 'error';
  /** Total duration */
  durationMs: number;
}

export interface EvalOutcome {
  avgScore: number;
  passRate: number;
  scorerAverages: Record<string, number>;
  failures: Array<{
    input: string;
    output: string;
    score: number;
    feedback: string;
  }>;
}
