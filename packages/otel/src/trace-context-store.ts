/**
 * AsyncLocalStorage-based trace context propagation for ForgeAgent.
 *
 * Provides application-level context (agent ID, run ID, phase, tenant)
 * that flows through all async operations without explicit parameter passing.
 *
 * This is NOT a replacement for OTel Context — it is ForgeAgent's own
 * application-level context, used to correlate logs, metrics, and spans.
 *
 * @example
 * ```ts
 * import { withForgeContext, currentForgeContext } from '@forgeagent/otel'
 *
 * await withForgeContext({
 *   traceId: '0af7651916cd43dd8448eb211c80319c',
 *   spanId: 'b7ad6b7169203331',
 *   agentId: 'code-gen',
 *   runId: 'run-123',
 *   baggage: {},
 * }, async () => {
 *   const ctx = currentForgeContext()
 *   console.log(ctx?.agentId) // 'code-gen'
 * })
 * ```
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The context carried through all async operations within a ForgeAgent run.
 */
export interface ForgeTraceContext {
  /** W3C trace ID (32 hex chars) */
  traceId: string
  /** Current span ID (16 hex chars) */
  spanId: string
  /** Agent that owns this execution */
  agentId?: string
  /** Current run ID */
  runId?: string
  /** Current pipeline phase (if in a pipeline) */
  phase?: string
  /** Tenant ID (for multi-tenant deployments) */
  tenantId?: string
  /** Arbitrary baggage propagated across agent boundaries */
  baggage: Record<string, string>
}

/**
 * Global AsyncLocalStorage instance for ForgeAgent trace context.
 */
export const forgeContextStore = new AsyncLocalStorage<ForgeTraceContext>()

/**
 * Run a function within a ForgeTraceContext.
 *
 * Nested calls inherit parent context fields unless overridden.
 * The provided context is merged with any existing parent context,
 * with the new values taking precedence.
 */
export function withForgeContext<T>(ctx: ForgeTraceContext, fn: () => T): T {
  const parent = forgeContextStore.getStore()
  const merged: ForgeTraceContext = parent
    ? {
        ...parent,
        ...ctx,
        baggage: { ...parent.baggage, ...ctx.baggage },
      }
    : ctx
  return forgeContextStore.run(merged, fn)
}

/**
 * Get the current trace context, or undefined if not within an instrumented scope.
 */
export function currentForgeContext(): ForgeTraceContext | undefined {
  return forgeContextStore.getStore()
}
