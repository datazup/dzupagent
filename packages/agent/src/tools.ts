/**
 * @dzupagent/agent/tools — tool, approval, and guardrail facade.
 *
 * Use this subpath for custom tool factories, HITL approval gates, guardrails,
 * dynamic registries, and tool schema compatibility checks.
 */

export { IterationBudget } from './guardrails/iteration-budget.js'
export { StuckDetector } from './guardrails/stuck-detector.js'
export type { StuckDetectorConfig, StuckStatus } from './guardrails/stuck-detector.js'
export { StuckError } from './agent/stuck-error.js'
export type { EscalationLevel, RecoveryAction as StuckRecoveryAction } from './agent/stuck-error.js'
export { CascadingTimeout } from './guardrails/cascading-timeout.js'
export type { CascadingTimeoutConfig } from './guardrails/cascading-timeout.js'
export type {
  GuardrailConfig,
  BudgetState,
  BudgetWarning,
} from './guardrails/guardrail-types.js'
export * from './approval/index.js'
export { DynamicToolRegistry } from './agent/tool-registry.js'
export type { ToolRegistryEvent } from './agent/tool-registry.js'
export { createForgeTool } from './tools/create-tool.js'
export type { ForgeToolConfig } from './tools/create-tool.js'
export { createHumanContactTool, InMemoryPendingContactStore } from './tools/human-contact-tool.js'
export type { HumanContactInput, HumanContactToolConfig, PendingContactStore } from './tools/human-contact-tool.js'
export { ToolSchemaRegistry } from './tools/tool-schema-registry.js'
export type { ToolSchemaEntry, CompatCheckResult } from './tools/tool-schema-registry.js'

