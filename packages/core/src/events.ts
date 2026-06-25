/**
 * @dzupagent/core/events — Event bus, hooks, agent message bus, errors.
 *
 * This subpath groups the foundational event/error primitives so consumers
 * that only need event plumbing don't pull in the full core barrel.
 *
 * @example
 * ```ts
 * import { createEventBus, AgentBus, ForgeError } from '@dzupagent/core/events'
 * ```
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export { ForgeError } from "./errors/forge-error.js";
export type { ForgeErrorOptions } from "./errors/forge-error.js";
export type { ForgeErrorCode } from "./errors/error-codes.js";

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------
export { createEventBus, typedEmit } from "./events/event-bus.js";
export type { DzupEventBus } from "./events/event-bus.js";
export type {
  AdapterProgressDzupEvent,
  AdapterRuntimeDzupEvent,
  DzupEvent,
  DzupEventOf,
  BudgetUsage,
  LlmInvocationRecord,
  MapReduceDzupEvent,
  RunLifecycleEvent,
  ToolCallAuditRecord,
  ToolCallAuditSink,
  ToolStatSummary,
} from "./events/event-types.js";

// ---------------------------------------------------------------------------
// LLM audit bridge
// ---------------------------------------------------------------------------
export { attachLlmAuditEventBridge } from "./events/llm-audit-bridge.js";
export type { LlmAuditSink } from "./events/llm-audit-bridge.js";

// ---------------------------------------------------------------------------
// Degraded operation events
// ---------------------------------------------------------------------------
export { emitDegradedOperation } from "./events/degraded-operation.js";

// ---------------------------------------------------------------------------
// Tool event correlation
// ---------------------------------------------------------------------------
export { requireTerminalToolExecutionRunId } from "./events/tool-event-correlation.js";
export type {
  TerminalToolExecutionRunIdOptions,
  TerminalToolEventType,
} from "./events/tool-event-correlation.js";

// ---------------------------------------------------------------------------
// Agent message bus
// ---------------------------------------------------------------------------
export { AgentBus } from "./events/agent-bus.js";
export type { AgentMessage, AgentMessageHandler } from "./events/agent-bus.js";

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------
export type { AgentHooks, HookContext } from "./hooks/hook-types.js";
export { runHooks, runModifierHook, mergeHooks } from "./hooks/hook-runner.js";
