/**
 * Phase helpers for `executeGenerateRunInner` (RF-25 / CODE-17).
 *
 * Originally a single 639 LOC orchestrator; now a thin coordinator that
 * re-exports the three phase modules so the public surface stays
 * identical for all existing callers (`run-engine.ts` and the
 * `run-engine-generate-helpers.test.ts` / `output-filter.test.ts`
 * suites).
 *
 * Phase modules (MC-026b-2):
 *
 *   1. `run-engine-generate-snapshot.ts`  — fire-and-forget run-state
 *      snapshot writer + run-id resolver.
 *   2. `run-engine-generate-audit.ts`     — RF-12 LLM-call audit-sink
 *      wrapping for `invokeModel`.
 *   3. `run-engine-generate-tool-loop.ts` — `prepareGuardPrelude` +
 *      `setupModelCall`: builds the {@link ToolLoopConfig} and runs the
 *      loop.
 *   4. `run-engine-generate-process.ts`   — `processGeneratedRun`:
 *      post-run telemetry, output filters, reflection callback, and
 *      final {@link GenerateResult} assembly.
 *
 * Behaviour, observable event ordering, OTel spans, and error rethrows
 * are unchanged — this module only repackages the helpers.
 */

export {
  persistRunStateSnapshot,
  createRunStateSnapshotWriter,
  resolveRunStateRunId,
  type RunStateSnapshotParams,
  type RunStateSnapshotWriter,
} from './run-engine-generate-snapshot.js'

export {
  prepareGuardPrelude,
  setupModelCall,
  type GuardPrelude,
  type RunLoopResult,
} from './run-engine-generate-tool-loop.js'

export { processGeneratedRun } from './run-engine-generate-process.js'
