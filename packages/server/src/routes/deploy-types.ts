import type { DeploymentHistoryStoreInterface } from '../deploy/deployment-history-store.js'
import type { RollbackChecker, AgentConfigLike } from '../deploy/signal-checkers.js'
import type { DeployConfidenceConfig } from '../deploy/confidence-types.js'

export interface DeployRouteConfig {
  /** Deployment history store (Postgres or in-memory). */
  historyStore: DeploymentHistoryStoreInterface
  /** Default environment for confidence computation (default: 'production'). */
  defaultEnvironment?: string
  /** Optional rollback checker for project revision availability. */
  rollbackChecker?: RollbackChecker
  /** Optional default agent config for recovery copilot detection. */
  agentConfig?: AgentConfigLike
  /** Optional confidence threshold overrides. */
  confidenceThresholds?: Partial<DeployConfidenceConfig['thresholds']>
}
