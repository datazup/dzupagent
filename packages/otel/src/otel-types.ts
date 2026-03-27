/**
 * Minimal OTel type interfaces used throughout the package.
 *
 * When @opentelemetry/api is installed, these are compatible with its types.
 * When it is not installed, the noop implementations satisfy these interfaces.
 */

/** Minimal Span interface matching @opentelemetry/api Span */
export interface OTelSpan {
  setAttribute(key: string, value: string | number | boolean): this
  setStatus(status: { code: number; message?: string }): this
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): this
  end(): void
  readonly spanContext: () => { traceId: string; spanId: string }
  isRecording(): boolean
}

/** Minimal Tracer interface matching @opentelemetry/api Tracer */
export interface OTelTracer {
  startSpan(name: string, options?: OTelSpanOptions, context?: OTelContext): OTelSpan
}

/** Minimal SpanOptions */
export interface OTelSpanOptions {
  attributes?: Record<string, string | number | boolean>
  kind?: number
}

/** Minimal Context type */
export type OTelContext = unknown

/** Span status codes matching @opentelemetry/api SpanStatusCode */
export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const

/** Span kind values matching @opentelemetry/api SpanKind */
export const SpanKind = {
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
  PRODUCER: 3,
  CONSUMER: 4,
} as const
