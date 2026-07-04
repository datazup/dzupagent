import type { BaseMessage } from "@langchain/core/messages";
import type { DzupEventBus } from "../events/event-bus.js";
import type { BudgetUsage } from "../events/event-types.js";

/**
 * Context passed to lifecycle hooks.
 */
export interface HookContext {
  agentId: string;
  runId: string;
  eventBus?: DzupEventBus;
  metadata: Record<string, unknown>;
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
 *
 * Model hooks mirror the tool-lifecycle contract:
 * - `beforeModelCall` returning a message array replaces the messages
 * - Returning `undefined`/`void` passes through unchanged
 * - `afterModelCall` runs only for successful calls; `onModelError` for failures
 */
export interface AgentHooks {
  // --- Run lifecycle ---
  onRunStart?: (ctx: HookContext) => Promise<void>;
  onRunComplete?: (ctx: HookContext, result: unknown) => Promise<void>;
  onRunError?: (ctx: HookContext, error: Error) => Promise<void>;

  // --- Tool lifecycle ---
  /** Runs before each tool call. Return modified input or void for pass-through. */
  beforeToolCall?: (
    toolName: string,
    input: unknown,
    ctx: HookContext
  ) => Promise<unknown | void>;
  /** Runs after each tool call. Return modified result or void for pass-through. */
  afterToolCall?: (
    toolName: string,
    input: unknown,
    result: string,
    ctx: HookContext
  ) => Promise<string | void>;
  onToolError?: (
    toolName: string,
    error: Error,
    ctx: HookContext
  ) => Promise<void>;

  // --- Model lifecycle ---
  /** Runs before each LLM invocation. Return a modified message array or void for pass-through. */
  beforeModelCall?: (
    messages: BaseMessage[],
    modelId: string,
    ctx: HookContext
  ) => Promise<BaseMessage[] | void>;
  /** Runs after each successful LLM invocation (never for failed calls — see onModelError). */
  afterModelCall?: (
    messages: BaseMessage[],
    response: BaseMessage,
    modelId: string,
    ctx: HookContext
  ) => Promise<void>;
  /** Runs when an LLM invocation fails. */
  onModelError?: (
    error: Error,
    modelId: string,
    ctx: HookContext
  ) => Promise<void>;

  // --- Pipeline lifecycle ---
  onPhaseChange?: (
    phase: string,
    previousPhase: string,
    ctx: HookContext
  ) => Promise<void>;
  onApprovalRequired?: (plan: unknown, ctx: HookContext) => Promise<void>;

  // --- Budget lifecycle ---
  onBudgetWarning?: (
    level: "warn" | "critical",
    usage: BudgetUsage,
    ctx: HookContext
  ) => Promise<void>;
  onBudgetExceeded?: (
    reason: string,
    usage: BudgetUsage,
    ctx: HookContext
  ) => Promise<void>;
}
