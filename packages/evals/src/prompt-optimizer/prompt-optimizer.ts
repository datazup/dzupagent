/**
 * PromptOptimizer — LLM-driven prompt rewriting that takes a current prompt +
 * eval failures, generates candidate rewrites, evaluates them, and stores the
 * best version.
 *
 * MC-046: module split into focused siblings while keeping this file as the
 * public import path for callers (including
 * `__tests__/prompt-optimizer.test.ts` and the package index).
 */

export type {
  EvalOutcome,
  OptimizationCandidate,
  OptimizationResult,
  OptimizerConfig,
} from './prompt-optimizer-types.js';

export { PromptOptimizer } from './prompt-optimizer-persistence.js';
