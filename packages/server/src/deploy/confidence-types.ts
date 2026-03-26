/**
 * Core types for the Confidence-Weighted Deploy Assistant.
 *
 * The deploy confidence system aggregates signals from Doctor, Scorecard,
 * guardrails, test coverage, and historical data to compute a deployment
 * confidence score and gate deployments accordingly.
 */

/** Decision the deploy gate makes based on the overall confidence score. */
export type GateDecision = 'auto_deploy' | 'deploy_with_warnings' | 'require_approval' | 'block'

/** A single signal contributing to the overall confidence score. */
export interface ConfidenceSignal {
  /** Human-readable name of the signal. */
  name: string
  /** Score from 0 to 100 (higher = more confident). */
  score: number
  /** Weight from 0 to 1 for weighted average computation. */
  weight: number
  /** Source system that produced this signal (e.g., 'doctor', 'scorecard'). */
  source: string
  /** True if the signal data exceeds the configured max age. */
  stale: boolean
  /** Optional human-readable details about the signal. */
  details?: string
  /** When this signal was produced. */
  timestamp: Date
}

/** Full confidence assessment for a deployment. */
export interface DeployConfidence {
  /** Weighted average of all signals, 0-100. */
  overallScore: number
  /** Gate decision derived from thresholds. */
  decision: GateDecision
  /** All signals that contributed to the score. */
  signals: ConfidenceSignal[]
  /** Human-readable explanation of the decision. */
  explanation: string
  /** Target deployment environment (e.g., 'production', 'staging'). */
  environment: string
  /** When this confidence was computed. */
  computedAt: Date
}

/** Thresholds that map confidence scores to gate decisions. */
export interface ConfidenceThresholds {
  /** Minimum score for fully automated deployment (default: 90). */
  autoDeploy: number
  /** Minimum score for deployment with warnings (default: 70). */
  deployWithWarnings: number
  /** Minimum score for manual approval required (default: 50). Below this = block. */
  requireApproval: number
}

/** Configuration for the confidence calculator. */
export interface DeployConfidenceConfig {
  /** Override default thresholds. */
  thresholds?: Partial<ConfidenceThresholds>
  /** Target deployment environment. */
  environment: string
  /** Max age in ms before a signal is considered stale (default: 1 hour). */
  signalMaxAge?: number
  /** Custom weight overrides keyed by signal name. */
  weightOverrides?: Record<string, number>
}

/** A record of a past deployment with its confidence and outcome. */
export interface DeploymentRecord {
  /** Unique identifier for this deployment record. */
  id: string
  /** Target environment. */
  environment: string
  /** Confidence assessment at time of deployment. */
  confidence: DeployConfidence
  /** Gate decision that was applied. */
  decision: GateDecision
  /** Outcome of the deployment, if known. */
  outcome?: 'success' | 'failure' | 'rollback'
  /** When deployment was initiated. */
  deployedAt: Date
  /** When deployment completed (or failed/rolled back). */
  completedAt?: Date
}
