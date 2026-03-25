/**
 * Noop implementations for when OTel SDK is not installed.
 *
 * All operations are safe no-ops that satisfy the minimal interfaces
 * without producing any telemetry.
 */

import type { OTelSpan, OTelTracer, OTelSpanOptions, OTelContext } from './otel-types.js'

let noopSpanIdCounter = 0

/**
 * A span that does nothing. All method calls are safe no-ops.
 */
export class NoopSpan implements OTelSpan {
  private readonly _spanId: string
  private readonly _traceId: string

  constructor(traceId?: string) {
    this._traceId = traceId ?? '00000000000000000000000000000000'
    this._spanId = (++noopSpanIdCounter).toString(16).padStart(16, '0')
  }

  setAttribute(_key: string, _value: string | number | boolean): this {
    return this
  }

  setStatus(_status: { code: number; message?: string }): this {
    return this
  }

  addEvent(_name: string, _attributes?: Record<string, string | number | boolean>): this {
    return this
  }

  end(): void {
    // noop
  }

  spanContext(): { traceId: string; spanId: string } {
    return { traceId: this._traceId, spanId: this._spanId }
  }

  isRecording(): boolean {
    return false
  }
}

/**
 * A tracer that produces NoopSpan instances.
 */
export class NoopTracer implements OTelTracer {
  startSpan(_name: string, _options?: OTelSpanOptions, _context?: OTelContext): OTelSpan {
    return new NoopSpan()
  }
}
