/**
 * OTel structural types for the team runtime.
 *
 * These are kept in their own module so pattern strategy modules can import
 * the span/tracer shapes without pulling in the full `team-runtime.ts`.
 *
 * `@dzupagent/agent` deliberately does not depend on `@dzupagent/otel`; the
 * concrete `OTelSpan` / `DzupTracer` types from that package conform to
 * these structural interfaces via subtyping.
 */

/**
 * Minimal span interface compatible with `OTelSpan` from `@dzupagent/otel`.
 * Uses structural typing so consumers can pass any compatible span
 * (DzupTracer-produced spans, Noop spans, mock test doubles).
 */
export interface TeamOTelSpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): unknown
  end(): void
}

/**
 * Structural tracer interface for team runtime instrumentation. Compatible
 * with `DzupTracer` from `@dzupagent/otel` but does not import it, keeping
 * `@dzupagent/agent` decoupled from the OTel package. The concrete
 * `DzupTracer.startPhaseSpan` returns an `OTelSpan` that conforms to
 * `TeamOTelSpanLike` via structural subtyping, and its `endSpanOk` /
 * `endSpanWithError` methods accept that span.
 *
 * `team.*` semantic attributes are set via `setAttribute` on the returned
 * span after creation rather than through `startPhaseSpan` options, because
 * `DzupTracer.startPhaseSpan`'s option surface is limited to `{ agentId,
 * runId }`.
 */
export interface TeamRuntimeTracer {
  startPhaseSpan(
    phase: string,
    options?: { agentId?: string; runId?: string },
  ): TeamOTelSpanLike
  endSpanOk(span: TeamOTelSpanLike): void
  endSpanWithError(span: TeamOTelSpanLike, error: unknown): void
}
