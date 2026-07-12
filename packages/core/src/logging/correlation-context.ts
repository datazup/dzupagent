/**
 * Minimal AsyncLocalStorage-based correlation context for `@dzupagent/core`.
 *
 * Carries request / tenant / run identifiers through async operations so that
 * internal log sites (error classification, retry, provider fallback) can
 * attach correlation ids without threading them through every signature.
 *
 * Why a local copy rather than reusing `@dzupagent/otel`'s `ForgeTraceContext`?
 * `@dzupagent/otel` depends on `@dzupagent/core` — importing it here would
 * create a circular dependency. This context deliberately mirrors the *shape*
 * of otel's `ForgeTraceContext` (same `runId` / `tenantId` / `agentId` fields)
 * so the two can be bridged: an otel-aware caller can copy its context into
 * this store, and this store stays usable in dependency-root code.
 *
 * The context is optional everywhere — a `undefined` store simply means "no
 * correlation ids available", and log sites degrade to logging without them.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Correlation identifiers attached to internal log entries. Every field is
 * optional so partial context (e.g. only a `runId`) is valid.
 */
export interface CorrelationContext {
  /** Request id (e.g. from an inbound HTTP request / server middleware). */
  requestId?: string
  /** Tenant id, for multi-tenant deployments. */
  tenantId?: string
  /** Run id — one agent execution / invocation. */
  runId?: string
  /** Agent that owns the current execution. */
  agentId?: string
}

const correlationStore = new AsyncLocalStorage<CorrelationContext>()

/**
 * Run `fn` within a correlation context. Nested calls merge onto the parent
 * context, with the provided fields taking precedence, so partial updates
 * (e.g. adding a `runId` inside a request scope) preserve outer ids.
 */
export function withCorrelationContext<T>(ctx: CorrelationContext, fn: () => T): T {
  const parent = correlationStore.getStore()
  const merged: CorrelationContext = parent ? { ...parent, ...ctx } : ctx
  return correlationStore.run(merged, fn)
}

/**
 * Get the current correlation context, or `undefined` if none is active.
 */
export function currentCorrelationContext(): CorrelationContext | undefined {
  return correlationStore.getStore()
}

/**
 * Return the current correlation ids as a plain object suitable for merging
 * into a structured log payload. Only defined fields are included; returns an
 * empty object when no context is active.
 */
export function correlationFields(): Partial<CorrelationContext> {
  const ctx = correlationStore.getStore()
  if (!ctx) return {}
  const out: Partial<CorrelationContext> = {}
  if (ctx.requestId !== undefined) out.requestId = ctx.requestId
  if (ctx.tenantId !== undefined) out.tenantId = ctx.tenantId
  if (ctx.runId !== undefined) out.runId = ctx.runId
  if (ctx.agentId !== undefined) out.agentId = ctx.agentId
  return out
}
