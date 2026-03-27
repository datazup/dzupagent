/**
 * Deploy module — confidence-weighted deployment gating.
 *
 * Re-exports all deploy-related types, the confidence calculator,
 * deployment gate, and deployment history tracker.
 */

// --- Types ---
export type {
  GateDecision,
  ConfidenceSignal,
  DeployConfidence,
  ConfidenceThresholds,
  DeployConfidenceConfig,
  DeploymentRecord,
} from './confidence-types.js'

// --- Confidence Calculator ---
export { DeployConfidenceCalculator } from './confidence-calculator.js'

// --- Deploy Gate ---
export { DeployGate } from './deploy-gate.js'

// --- Deployment History (in-memory) ---
export { DeploymentHistory, generateDeploymentId, resetIdCounter } from './deployment-history.js'

// --- Deployment History Store (persistent) ---
export {
  PostgresDeploymentHistoryStore,
  InMemoryDeploymentHistoryStore,
} from './deployment-history-store.js'
export type {
  DeploymentHistoryStoreInterface,
  DeploymentHistoryRecord,
  DeploymentHistoryInput,
  DeploymentOutcome,
  SuccessRateResult,
} from './deployment-history-store.js'

// --- Signal Checkers ---
export {
  checkRecoveryCopilotConfigured,
  checkRollbackAvailable,
  computeAllSignals,
} from './signal-checkers.js'
export type {
  AgentConfigLike,
  RollbackCheckResult,
  RollbackChecker,
  SignalComputationResult,
  SignalComputationConfig,
} from './signal-checkers.js'

// --- Existing deploy utilities ---
export { generateDockerfile, generateDockerCompose, generateDockerignore } from './docker-generator.js'
export type { DockerConfig } from './docker-generator.js'
export { checkHealth } from './health-checker.js'
export type { HealthCheckResult } from './health-checker.js'
