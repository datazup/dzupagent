/**
 * EvalOrchestrator — queue / lease / retry orchestration for eval runs.
 *
 * Public-facing barrel for the orchestrator. The implementation lives in
 * eval-orchestrator-impl.ts (split from this file in MC-016 to keep the
 * entrypoint a thin coordinator). Errors live in eval-orchestrator-errors.ts
 * and pure attempt-history helpers live in eval-orchestrator-attempts.ts.
 *
 * Originally moved from @dzupagent/server in MC-A02 to fix the
 * server -> evals layer inversion. Server consumes via the
 * EvalOrchestratorLike contract from @dzupagent/eval-contracts.
 */

export type {
  EvalExecutionContext,
  EvalExecutionTarget,
  EvalQueueStats,
} from '@dzupagent/eval-contracts'

export {
  EvalCostExceededError,
  EvalExecutionUnavailableError,
  EvalRunInvalidStateError,
} from './eval-orchestrator-errors.js'

export { EvalOrchestrator } from './eval-orchestrator-impl.js'
export type { EvalOrchestratorConfig } from './eval-orchestrator-impl.js'
