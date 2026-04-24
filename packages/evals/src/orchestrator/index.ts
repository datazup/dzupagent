/**
 * Eval + benchmark orchestrators. Moved from @dzupagent/server in MC-A02 to
 * fix the server -> evals layer inversion. Consumers inject these into the
 * server via the EvalOrchestratorLike / BenchmarkOrchestratorLike contracts
 * from @dzupagent/eval-contracts.
 */

export {
  EvalOrchestrator,
  EvalExecutionUnavailableError,
  EvalRunInvalidStateError,
} from './eval-orchestrator.js'
export type {
  EvalOrchestratorConfig,
  EvalExecutionContext,
  EvalExecutionTarget,
  EvalQueueStats,
} from './eval-orchestrator.js'

export { BenchmarkOrchestrator } from './benchmark-orchestrator.js'
export type {
  BenchmarkOrchestratorConfig,
  BenchmarkRunArtifactInput,
} from './benchmark-orchestrator.js'
