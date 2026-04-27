/**
 * @dzupagent/agent-adapters/recovery
 *
 * Recovery plane: adapter recovery copilot, recovery strategies, escalation,
 * cross-provider handoff, and approval gates.
 */

// --- Recovery copilot & traces ---
export { AdapterRecoveryCopilot, ExecutionTraceCapture } from './recovery/adapter-recovery.js'
export type {
  RecoveryStrategy,
  RecoveryConfig,
  TraceEvictionConfig,
  FailureContext,
  RecoverySuccessResult,
  RecoveryFailureResult,
  RecoveryCancelledResult,
  RecoveryResult,
  ExecutionTrace,
  TraceDecision,
  TracedEvent,
} from './recovery/adapter-recovery.js'

// --- Recovery Policies ---
export { RecoveryPolicySelector, RECOVERY_POLICIES } from './recovery/recovery-policies.js'
export type { RecoveryPolicy, RecoveryStrategyConfig, PolicyContext } from './recovery/recovery-policies.js'

// --- Escalation & cross-provider handoff ---
export { EventBusEscalationHandler, WebhookEscalationHandler } from './recovery/escalation-handler.js'
export { CrossProviderHandoff } from './recovery/cross-provider-handoff.js'
export type { HandoffItem, CrossProviderHandoffOptions } from './recovery/cross-provider-handoff.js'
export type {
  EscalationHandler,
  EscalationContext,
  EscalationResolution,
  RecoveryAttemptSummary,
} from './recovery/escalation-handler.js'

// --- Approval ---
export { AdapterApprovalGate } from './approval/adapter-approval.js'
export type {
  AdapterApprovalConfig,
  ApprovalContext,
  ApprovalRequest,
  ApprovalMode,
  ApprovalResult,
} from './approval/adapter-approval.js'
export { InMemoryApprovalAuditStore } from './approval/approval-audit.js'
export type {
  ApprovalAuditEntry,
  AuditQueryFilters,
  ApprovalAuditStore,
} from './approval/approval-audit.js'
export { createPolicyCondition, compareBlastRadius } from './approval/policy-driven-approval.js'
export type { PolicyConditionConfig } from './approval/policy-driven-approval.js'

// --- Guardrails (recovery-adjacent) ---
export { AdapterGuardrails, AdapterStuckDetector } from './guardrails/adapter-guardrails.js'
export type {
  AdapterGuardrailsConfig,
  StuckDetectorConfig as AdapterStuckDetectorConfig,
  GuardrailStatus,
  GuardrailViolation,
  BudgetState as GuardrailBudgetState,
  StuckStatus,
} from './guardrails/adapter-guardrails.js'
