/**
 * Lightweight trace context propagation for cross-process boundaries.
 *
 * These helpers serialize/deserialize W3C-compatible trace IDs into
 * run job metadata so that traces correlate across the
 * queue -> worker -> agent execution pipeline.
 *
 * IMPORTANT: This module has ZERO dependency on @opentelemetry/api or
 * @dzupagent/otel. It deals only with opaque string IDs that any
 * OTel-compatible backend can later link together.
 */

import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal trace context that can be serialized into run metadata
 * for cross-process propagation (queue -> worker -> agent).
 */
export interface TraceContext {
  /** W3C trace ID — 32 lowercase hex chars */
  traceId: string
  /** Span ID — 16 lowercase hex chars */
  spanId: string
  /** W3C trace flags (default 1 = sampled) */
  traceFlags: number
}

/** The metadata key used to store serialized trace context. */
const TRACE_KEY = '_trace' as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a 32-char lowercase hex trace ID from crypto.randomUUID().
 * UUID v4 is 32 hex chars when dashes are stripped — perfect for W3C trace IDs.
 */
function generateTraceId(): string {
  return randomUUID().replace(/-/g, '')
}

/**
 * Generate a 16-char lowercase hex span ID from the last 16 hex chars of a UUID.
 */
function generateSpanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

/**
 * Format a TraceContext as a W3C traceparent string.
 * Format: `{version}-{traceId}-{spanId}-{flags}`
 */
export function formatTraceparent(ctx: TraceContext): string {
  const flags = ctx.traceFlags.toString(16).padStart(2, '0')
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`
}

/**
 * Parse a W3C traceparent string into a TraceContext.
 * Returns null if the string is malformed.
 */
export function parseTraceparent(traceparent: string): TraceContext | null {
  const parts = traceparent.split('-')
  if (parts.length < 4) return null

  const traceId = parts[1]
  const spanId = parts[2]
  const flagsHex = parts[3]

  if (!traceId || !spanId || !flagsHex) return null
  if (traceId.length !== 32 || !/^[0-9a-f]{32}$/.test(traceId)) return null
  if (spanId.length !== 16 || !/^[0-9a-f]{16}$/.test(spanId)) return null

  const traceFlags = parseInt(flagsHex, 16)
  if (Number.isNaN(traceFlags)) return null

  return { traceId, spanId, traceFlags }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inject a new trace context into metadata for cross-process propagation.
 *
 * If the metadata already contains a `_trace` entry with a valid traceparent,
 * it is preserved (idempotent). Otherwise a fresh traceId + spanId pair is
 * generated and stored as `metadata._trace.traceparent`.
 *
 * @returns A new metadata object (the original is not mutated).
 */
export function injectTraceContext(
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  // If already injected and valid, return as-is (shallow copy)
  const existing = extractTraceContext(metadata)
  if (existing) {
    return { ...metadata }
  }

  const ctx: TraceContext = {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    traceFlags: 1, // sampled
  }

  return {
    ...metadata,
    [TRACE_KEY]: {
      traceparent: formatTraceparent(ctx),
    },
  }
}

/**
 * Extract trace context from metadata previously injected by `injectTraceContext`.
 *
 * @returns The parsed TraceContext, or `null` if metadata is missing,
 *          does not contain `_trace`, or the traceparent is invalid.
 */
export function extractTraceContext(
  metadata?: Record<string, unknown>,
): TraceContext | null {
  if (!metadata) return null

  const trace = metadata[TRACE_KEY]
  if (!trace || typeof trace !== 'object') return null

  const traceparent = (trace as Record<string, unknown>)['traceparent']
  if (typeof traceparent !== 'string') return null

  return parseTraceparent(traceparent)
}
