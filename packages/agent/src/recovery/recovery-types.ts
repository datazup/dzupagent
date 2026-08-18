/**
 * Types for the Autonomous Recovery Copilot.
 *
 * Defines failure contexts, recovery strategies, actions, and plans
 * that drive automatic recovery when agent execution fails.
 *
 * @module recovery/recovery-types
 */

// ---------------------------------------------------------------------------
// Failure context
// ---------------------------------------------------------------------------

/** Classification of the failure that triggered recovery. */
export type FailureType =
  | 'build_failure'
  | 'generation_failure'
  | 'test_failure'
  | 'timeout'
  | 'resource_exhaustion'

/** Compatibility scope used by recovery callers that do not opt into tenancy. */
export const DEFAULT_RECOVERY_TENANT_ID = 'default'

/**
 * Resolve one canonical tenant identity for recovery reads and writes.
 * Missing legacy scope maps to `default`; blank or non-string runtime input
 * fails closed before recovery execution or persistence.
 */
export function normalizeRecoveryTenantId(
  tenantId?: string | null,
): string {
  if (tenantId !== undefined && tenantId !== null && typeof tenantId !== 'string') {
    throw new Error('Recovery tenantId must be a non-empty string')
  }

  const normalized = (tenantId ?? DEFAULT_RECOVERY_TENANT_ID).trim()
  if (normalized.length === 0) {
    throw new Error('Recovery tenantId must be a non-empty string')
  }
  return normalized
}

/** Full context about a failure that needs recovery. */
export interface FailureContext {
  /** Classified failure type. */
  type: FailureType
  /** Human-readable error message. */
  error: string
  /** Optional stack trace. */
  stackTrace?: string
  /** Run ID of the failing execution. */
  runId: string
  /** Pipeline node ID where failure occurred, if applicable. */
  nodeId?: string
  /** When the failure happened. */
  timestamp: Date
  /** How many times recovery has already been attempted for this failure. */
  previousAttempts: number
  /** Owning recovery-learning tenant. Missing legacy scope resolves to `default`. */
  tenantId?: string
  /** Additional metadata from the failing context. */
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Recovery actions
// ---------------------------------------------------------------------------

/** Types of actions the recovery system can take. */
export type RecoveryActionType =
  | 'retry'
  | 'rollback'
  | 'skip'
  | 'modify_params'
  | 'fallback_model'
  | 'reduce_scope'
  | 'human_escalation'

/** A single recovery action within a strategy. */
export interface RecoveryAction {
  /** What kind of action to take. */
  type: RecoveryActionType
  /** Action-specific parameters. */
  params: Record<string, unknown>
  /** Human-readable description of what this action does. */
  description: string
}

// ---------------------------------------------------------------------------
// Recovery strategies
// ---------------------------------------------------------------------------

/** Risk level of a recovery strategy. */
export type RiskLevel = 'low' | 'medium' | 'high'

/** A candidate strategy for recovering from a failure. */
export interface RecoveryStrategy {
  /** Short name for this strategy. */
  name: string
  /** Human-readable description. */
  description: string
  /** Confidence that this strategy will resolve the failure (0-1). */
  confidence: number
  /** Risk level of applying this strategy. */
  risk: RiskLevel
  /** Estimated number of steps to execute. */
  estimatedSteps: number
  /** Ordered list of actions comprising this strategy. */
  actions: RecoveryAction[]
}

/** Whether a strategy crosses the terminal human-escalation boundary. */
export function isHumanEscalationStrategy(
  strategy: RecoveryStrategy,
): boolean {
  return strategy.actions.some(action => action.type === 'human_escalation')
}

// ---------------------------------------------------------------------------
// Recovery plan
// ---------------------------------------------------------------------------

/** Status of a recovery plan lifecycle. */
export type RecoveryPlanStatus =
  | 'proposed'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'skipped'

/** A recovery plan produced by the RecoveryCopilot. */
export interface RecoveryPlan {
  /** Unique plan ID. */
  id: string
  /** The failure this plan addresses. */
  failureContext: FailureContext
  /** All candidate strategies, ranked by confidence. */
  strategies: RecoveryStrategy[]
  /** The strategy chosen for execution (null if none selected yet). */
  selectedStrategy: RecoveryStrategy | null
  /** Current lifecycle status. */
  status: RecoveryPlanStatus
  /** When the plan was created. */
  createdAt: Date
  /** When execution completed (success or failure). */
  completedAt?: Date
  /** Error message if execution failed. */
  executionError?: string
}

// ---------------------------------------------------------------------------
// Recovery configuration
// ---------------------------------------------------------------------------

/** Configuration for the RecoveryCopilot. */
export interface RecoveryCopilotConfig {
  /** Maximum recovery attempts before escalating to human (default: 3). */
  maxAttempts: number
  /** Whether high-risk strategies require human approval (default: true). */
  requireApprovalForHighRisk: boolean
  /** Whether to support dry-run mode (default: false). */
  dryRun: boolean
  /** Maximum strategies to generate per failure (default: 5). */
  maxStrategies: number
  /** Minimum confidence threshold for auto-execution (default: 0.6). */
  minAutoExecuteConfidence: number
}

/** Result of executing a recovery plan. */
export interface RecoveryResult {
  /** The executed plan. */
  plan: RecoveryPlan
  /** Whether recovery succeeded. */
  success: boolean
  /** Human-readable summary. */
  summary: string
  /** Duration of recovery execution in ms. */
  durationMs: number
}
