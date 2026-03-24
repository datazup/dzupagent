import type { ForgeErrorCode } from '../errors/error-codes.js'

/**
 * Budget usage snapshot — emitted with budget warnings.
 */
export interface BudgetUsage {
  tokensUsed: number
  tokensLimit: number
  costCents: number
  costLimitCents: number
  iterations: number
  iterationsLimit: number
  percent: number
}

/**
 * Discriminated union of all events emitted through ForgeEventBus.
 *
 * Each event has a `type` discriminator and type-specific payload fields.
 * Use `ForgeEvent['type']` to enumerate all event types.
 */
export type ForgeEvent =
  // --- Agent lifecycle ---
  | { type: 'agent:started'; agentId: string; runId: string }
  | { type: 'agent:completed'; agentId: string; runId: string; durationMs: number }
  | { type: 'agent:failed'; agentId: string; runId: string; errorCode: ForgeErrorCode; message: string }
  // --- Tool lifecycle ---
  | { type: 'tool:called'; toolName: string; input: unknown }
  | { type: 'tool:result'; toolName: string; durationMs: number }
  | { type: 'tool:error'; toolName: string; errorCode: ForgeErrorCode; message: string }
  // --- Memory ---
  | { type: 'memory:written'; namespace: string; key: string }
  | { type: 'memory:searched'; namespace: string; query: string; resultCount: number }
  | { type: 'memory:error'; namespace: string; message: string }
  // --- Budget ---
  | { type: 'budget:warning'; level: 'warn' | 'critical'; usage: BudgetUsage }
  | { type: 'budget:exceeded'; reason: string; usage: BudgetUsage }
  // --- Pipeline ---
  | { type: 'pipeline:phase_changed'; phase: string; previousPhase: string }
  | { type: 'pipeline:validation_failed'; phase: string; errors: string[] }
  // --- Approval ---
  | { type: 'approval:requested'; runId: string; plan: unknown }
  | { type: 'approval:granted'; runId: string; approvedBy?: string }
  | { type: 'approval:rejected'; runId: string; reason?: string }
  // --- MCP ---
  | { type: 'mcp:connected'; serverName: string; toolCount: number }
  | { type: 'mcp:disconnected'; serverName: string }
  // --- Provider ---
  | { type: 'provider:failed'; tier: string; provider: string; message: string }
  | { type: 'provider:circuit_opened'; provider: string }
  | { type: 'provider:circuit_closed'; provider: string }
  // --- Hooks / plugins ---
  | { type: 'hook:error'; hookName: string; message: string }
  | { type: 'plugin:registered'; pluginName: string }

/** Extract a specific event by its type discriminator */
export type ForgeEventOf<T extends ForgeEvent['type']> = Extract<ForgeEvent, { type: T }>
