/**
 * @forgeagent/evals — Evaluation framework for ForgeAgent.
 *
 * Provides: LLM-as-judge, deterministic scorers, composite scorers,
 * batch evaluation runner, and regression detection.
 */

// --- Types ---
export type { EvalInput, EvalResult, Scorer, EvalRecord, EvalResultStore } from './types.js'

// --- Scorers ---
export {
  createLLMJudge,
  createDeterministicScorer,
  containsScorer,
  jsonValidScorer,
  lengthScorer,
  regexScorer,
  exactMatchScorer,
  createCompositeScorer,
} from './scorers/index.js'
export type { LLMJudgeConfig, DeterministicScorerConfig, CompositeScorerConfig } from './scorers/index.js'

// --- Runner ---
export { EvalRunner } from './runner/index.js'

// --- Version ---
export const FORGEAGENT_EVALS_VERSION = '0.1.0'
