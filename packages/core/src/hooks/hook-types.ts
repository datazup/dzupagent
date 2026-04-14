import type { DzupEventBus } from '../events/event-bus.js'
import type { BudgetUsage } from '../events/event-types.js'

/**
 * Context passed to lifecycle hooks.
 */
export interface HookContext {
  agentId: string
  runId: string
  eventBus?: DzupEventBus
  metadata: Record<string, unknown>
}

/**
 * Lifecycle hooks for DzupAgent execution.
 *
 * All hooks are optional and run sequentially (not parallel).
 * Hook errors are caught and logged — they never break agent execution.
 *
 * Tool hooks can return modified values:
 * - `beforeToolCall` returning a value replaces the input
 * - `afterToolCall` returning a value replaces the result
 * - Returning `undefined`/`void` passes through unchanged
 */
export interface AgentHooks {
  // --- Run lifecycle ---
  onRunStart?: (ctx: HookContext) => Promise<void>
  onRunComplete?: (ctx: HookContext, result: unknown) => Promise<void>
  onRunError?: (ctx: HookContext, error: Error) => Promise<void>

  // --- Tool lifecycle ---
  /** Runs before each tool call. Return modified input or void for pass-through. */
  beforeToolCall?: (toolName: string, input: unknown, ctx: HookContext) => Promise<unknown | void>
  /** Runs after each tool call. Return modified result or void for pass-through. */
  afterToolCall?: (toolName: string, input: unknown, result: string, ctx: HookContext) => Promise<string | void>
  onToolError?: (toolName: string, error: Error, ctx: HookContext) => Promise<void>

  // --- Pipeline lifecycle ---
  onPhaseChange?: (phase: string, previousPhase: string, ctx: HookContext) => Promise<void>
  onApprovalRequired?: (plan: unknown, ctx: HookContext) => Promise<void>

  // --- Budget lifecycle ---
  onBudgetWarning?: (level: 'warn' | 'critical', usage: BudgetUsage, ctx: HookContext) => Promise<void>
  onBudgetExceeded?: (reason: string, usage: BudgetUsage, ctx: HookContext) => Promise<void>
}
