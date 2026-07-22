/**
 * Structural tracing shapes for the tool loop.
 *
 * Extracted from `../types.ts` (DZUPAGENT-ARCH-M-06) so the god-module of
 * type declarations stays under the 500-LOC ceiling. The root `../types.ts`
 * barrel re-exports every symbol here unchanged — existing callers continue
 * to import from `../types.js` / `../tool-loop.js`.
 */

/**
 * Minimal tool span shape. Structurally compatible with OTel's `Span` and
 * with `@dzupagent/otel`'s `OTelSpan`. Only the calls made by the tool
 * loop are declared.
 */
export interface ToolLoopSpan {
  setAttribute(key: string, value: string | number | boolean): unknown;
  end(): void;
}

/**
 * Structural tracer interface for the tool loop. Compatible with
 * `DzupTracer` from `@dzupagent/otel` without importing it.
 */
export interface ToolLoopTracer {
  startToolSpan(
    toolName: string,
    options?: { inputSize?: number }
  ): ToolLoopSpan;
  endSpanWithError(span: ToolLoopSpan, error: unknown): void;
}
