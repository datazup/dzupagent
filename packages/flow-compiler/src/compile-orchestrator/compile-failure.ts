/**
 * compile-failure.ts — the one way a compile run reports failure.
 *
 * Every stage that can halt the pipeline has to do the same two things, in the
 * same order: emit `flow:compile_failed` carrying the failing stage, the error
 * count and the elapsed duration, then return a `CompileFailure` whose
 * category counts are derived from those same errors.
 *
 * Keeping that pairing in one function is not only deduplication. The emitted
 * event and the returned value are two views of a single fact, and a caller
 * that returned without emitting -- or emitted a stage number that disagreed
 * with the errors it returned -- would desynchronise the event stream from the
 * compile result while every type still checked. There is no way to do one
 * half here.
 *
 * @module compile-orchestrator/compile-failure
 */

import type { CompilationError, CompileFailure } from "../types.js";

import { countDiagnosticsByCategory } from "./diagnostics.js";
import type { FlowCompileEvent } from "./contracts.js";

/** The stages that can halt a compile run and report errors. */
export type CompileFailureStage = 1 | 2 | 3 | 4;

/**
 * The per-run state a failure needs: where to send the lifecycle event, which
 * compile it belongs to, and when the run began. Captured once at the top of
 * `runCompile` so no call site has to re-thread three arguments.
 */
export interface CompileFailureSink {
  readonly emit: (event: FlowCompileEvent) => void;
  readonly compileId: string;
  readonly startedAt: number;
}

/**
 * Announce and construct a compile failure.
 *
 * `durationMs` is measured at the moment of the emit rather than passed in, so
 * it always reports the true elapsed time of the run that failed.
 */
export function failCompile(
  sink: CompileFailureSink,
  stage: CompileFailureStage,
  errors: CompilationError[],
): CompileFailure {
  sink.emit({
    type: "flow:compile_failed",
    compileId: sink.compileId,
    stage,
    errorCount: errors.length,
    durationMs: Date.now() - sink.startedAt,
  });
  return {
    errors,
    compileId: sink.compileId,
    diagnosticCountsByCategory: countDiagnosticsByCategory(errors),
  };
}
