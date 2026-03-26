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

// --- Deployment History ---
export { DeploymentHistory, generateDeploymentId, resetIdCounter } from './deployment-history.js'

// --- Existing deploy utilities ---
export { generateDockerfile, generateDockerCompose, generateDockerignore } from './docker-generator.js'
export type { DockerConfig } from './docker-generator.js'
export { checkHealth } from './health-checker.js'
export type { HealthCheckResult } from './health-checker.js'
