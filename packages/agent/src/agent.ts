/**
 * @dzupagent/agent/agent — core agent surface.
 *
 * This subpath collects the symbols required to build, run, and govern an
 * individual agent: the `DzupAgent` class, the ReAct tool loop, guardrails,
 * approval gates, and agent-level error types. Use this entry instead of the
 * root barrel when you want the smallest tree-shakable surface for embedding
 * an agent into another runtime.
 */

// --- Agent core ---
export { DzupAgent } from './agent/dzip-agent.js'
export { createAgentWithMemory } from './agent/agent-factory.js'
export type {
  DzupAgentConfig,
  AgentMailboxConfig,
  ArrowMemoryConfig,
  GenerateOptions,
  GenerateResult,
  AgentStreamEvent,
  CompressionLogEntry,
  ToolExecutionConfig,
  PerToolTimeoutMap,
  ArgumentValidator,
  ToolTracer,
} from './agent/agent-types.js'
export { getMemoryProfilePreset, resolveArrowMemoryConfig } from './agent/memory-profiles.js'
export type { MemoryProfile, MemoryProfilePreset } from './agent/memory-profiles.js'
export {
  createAllowlistPermissionPolicy,
  createProductionToolGovernancePreset,
  withProductionToolGovernancePreset,
} from './agent/production-tool-governance-preset.js'
export type {
  ProductionToolGovernancePreset,
  ProductionToolGovernancePresetOptions,
  ProductionToolPermissionOptions,
} from './agent/production-tool-governance-preset.js'

// --- Tool loop ---
export { runToolLoop } from './agent/tool-loop.js'
export type { ToolLoopConfig, ToolLoopResult, ToolStat, StopReason } from './agent/tool-loop.js'
export { ToolOutputValidator } from './agent/tool-loop/output-validator.js'
export type {
  ToolOutputSchema,
  ToolOutputValidationResult,
} from './agent/tool-loop/output-validator.js'

// --- Run handles ---
export type {
  RunHandle,
  RunResult,
  LaunchOptions,
  Unsubscribe,
  CheckpointInfo,
} from './agent/run-handle-types.js'
export { ConcreteRunHandle } from './agent/run-handle.js'

// --- Parallel executor ---
export { executeToolsParallel } from './agent/parallel-executor.js'
export type {
  ParallelToolCall,
  ToolExecutionResult,
  ToolLookup,
  ParallelExecutorOptions,
} from './agent/parallel-executor.js'

// --- Guardrails ---
export { IterationBudget } from './guardrails/iteration-budget.js'
export { StuckDetector } from './guardrails/stuck-detector.js'
export type { StuckDetectorConfig, StuckStatus } from './guardrails/stuck-detector.js'
export { CascadingTimeout } from './guardrails/cascading-timeout.js'
export type { CascadingTimeoutConfig } from './guardrails/cascading-timeout.js'
export type {
  GuardrailConfig,
  BudgetState,
  BudgetWarning,
} from './guardrails/guardrail-types.js'

// --- Approval ---
export { ApprovalGate } from './approval/approval-gate.js'
export {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ApprovalConfig,
  type ApprovalMode,
  type ApprovalResult,
  type ApprovalWaitOptions,
} from './approval/approval-types.js'

// --- Agent-level errors ---
export { StuckError } from './agent/stuck-error.js'
export type {
  EscalationLevel,
  RecoveryAction as StuckRecoveryAction,
} from './agent/stuck-error.js'
export {
  TOOL_TIMEOUT_ERROR_CODE,
  ToolTimeoutError,
  isToolTimeoutError,
} from './agent/tool-timeout-error.js'
export {
  InvalidRunStateError,
  CheckpointExpiredError,
  ForkLimitExceededError,
  RunNotFoundError,
} from './agent/run-handle-types.js'

// --- Tool argument validation ---
export { validateAndRepairToolArgs, formatSchemaHint } from './agent/tool-arg-validator.js'
export type { ValidationResult, ToolArgValidatorConfig } from './agent/tool-arg-validator.js'
