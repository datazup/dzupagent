/**
 * @forgeagent/agent — Top-level agent abstraction
 *
 * Provides: ForgeAgent class (generate/stream/asTool), guardrails
 * with iteration budgets, generic tool factory, auto-compression,
 * and structured output support.
 */

// --- Agent ---
export { ForgeAgent } from './agent/forge-agent.js'
export type {
  ForgeAgentConfig,
  GenerateOptions,
  GenerateResult,
  AgentStreamEvent,
} from './agent/agent-types.js'
export { runToolLoop } from './agent/tool-loop.js'
export type { ToolLoopConfig, ToolLoopResult } from './agent/tool-loop.js'

// --- Guardrails ---
export { IterationBudget } from './guardrails/iteration-budget.js'
export { StuckDetector } from './guardrails/stuck-detector.js'
export type { StuckDetectorConfig, StuckStatus } from './guardrails/stuck-detector.js'
export type {
  GuardrailConfig,
  BudgetState,
  BudgetWarning,
} from './guardrails/guardrail-types.js'

// --- Workflow ---
export { WorkflowBuilder, CompiledWorkflow, createWorkflow } from './workflow/workflow-builder.js'
export type { WorkflowConfig } from './workflow/workflow-builder.js'
export type {
  WorkflowStep,
  WorkflowContext,
  WorkflowEvent,
  MergeStrategy,
} from './workflow/workflow-types.js'

// --- Orchestration ---
export { AgentOrchestrator } from './orchestration/orchestrator.js'
export type { MergeFn } from './orchestration/orchestrator.js'
export { mapReduce, mapReduceMulti } from './orchestration/map-reduce.js'
export type { MapReduceConfig, MapReduceResult, AgentOutput } from './orchestration/map-reduce.js'
export {
  concatMerge,
  voteMerge,
  numberedMerge,
  jsonArrayMerge,
  getMergeStrategy,
} from './orchestration/merge-strategies.js'
export type { MergeStrategyFn } from './orchestration/merge-strategies.js'

// --- Context ---
export { autoCompress, FrozenSnapshot } from './context/auto-compress.js'
export type { AutoCompressConfig, CompressResult } from './context/auto-compress.js'

// --- Approval ---
export { ApprovalGate } from './approval/approval-gate.js'
export type { ApprovalConfig, ApprovalMode, ApprovalResult } from './approval/approval-types.js'

// --- Tool Registry ---
export { DynamicToolRegistry } from './agent/tool-registry.js'
export type { ToolRegistryEvent } from './agent/tool-registry.js'

// --- Tools ---
export { createForgeTool } from './tools/create-tool.js'
export type { ForgeToolConfig } from './tools/create-tool.js'

// --- State ---
export { serializeMessages, deserializeMessages } from './agent/agent-state.js'
export type { AgentStateSnapshot, SerializedMessage } from './agent/agent-state.js'

// --- Streaming ---
export { StreamActionParser } from './streaming/stream-action-parser.js'
export type {
  StreamedToolCall,
  StreamActionEvent,
  StreamActionParserConfig,
} from './streaming/stream-action-parser.js'

// --- Templates ---
export { AGENT_TEMPLATES, getAgentTemplate, listAgentTemplates } from './templates/agent-templates.js'
export type { AgentTemplate } from './templates/agent-templates.js'

// --- Version ---
export const FORGEAGENT_AGENT_VERSION = '0.1.0'
