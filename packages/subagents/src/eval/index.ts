/**
 * Fanout eval harness — see `types.ts` for the design rationale (why this is
 * a self-contained, dependency-free harness inside `@dzupagent/subagents`
 * rather than a module inside `@dzupagent/evals`).
 *
 * Three deterministic scorers, each targeting a distinct fan-out
 * correctness surface:
 *
 *  - {@link createSpawnDecisionScorer} — SpawnGate admission + scope-narrowing.
 *  - {@link createAgentIdentityResolutionScorer} — per-item agentId/instruction resolution.
 *  - {@link createFanoutReportAccuracyScorer} — FanoutReport/FanoutBatchRecord invariants.
 *
 * Plus a small runner ({@link runFanoutEvalSuite}) that scores a set of
 * {@link FanoutEvalCase}s with a scorer and produces a {@link FanoutSuiteReport}.
 */

export type {
  FanoutEvalResult,
  FanoutScorerConfig,
  FanoutScorer,
  FanoutEvalCase,
  FanoutCaseScore,
  FanoutSuiteReport,
} from "./types.js";

export { runFanoutEvalSuite, runFanoutEvalSuites } from "./harness.js";

export {
  createSpawnDecisionScorer,
  type SpawnDecisionCase,
} from "./spawn-decision-scorer.js";

export {
  createAgentIdentityResolutionScorer,
  type AgentIdentityResolutionCase,
} from "./agent-identity-resolution-scorer.js";

export {
  createFanoutReportAccuracyScorer,
  scoreFanoutBatchRecord,
  checkReportInternalConsistency,
  type FanoutReportAccuracyCase,
} from "./fanout-report-accuracy-scorer.js";

export {
  SPAWN_DECISION_SCENARIOS,
  SPAWN_DECISION_KNOWN_BAD_CASE,
  AGENT_IDENTITY_RESOLUTION_SCENARIOS,
  AGENT_IDENTITY_RESOLUTION_KNOWN_BAD_CASE,
  FANOUT_REPORT_ACCURACY_SCENARIOS,
  FANOUT_REPORT_ACCURACY_KNOWN_BAD_CASE,
} from "./scenarios/index.js";
