// Barrel module: run-worker stages were split into focused modules to keep
// each file under the size budget. The canonical homes are:
//
//   - run-stages-admission.ts  — admission + approval gates
//   - run-stages-execution.ts  — main run dispatch + prior-context loading
//   - run-stages-persistence.ts — terminal/cancel/failure persistence,
//                                  telemetry, and post-run learning
//   - run-stages-utils.ts      — small helpers shared across the stages
//
// Existing callers (run-worker.ts, tests) continue to import from this
// barrel for backward compatibility.

export type { AdmissionStageResult } from './run-stages-admission.js'
export { runAdmissionStage, waitForRunApproval } from './run-stages-admission.js'

export type { ExecutionStageResult } from './run-stages-execution.js'
export { dispatchExecutionStage } from './run-stages-execution.js'

export type { TerminalPersistenceResult } from './run-stages-persistence.js'
export {
  persistCancellation,
  persistFailure,
  persistTerminalSuccess,
  recordTelemetryStage,
  runPostRunLearningStage,
} from './run-stages-persistence.js'

export {
  closeTraceWithTerminalStep,
  throwIfAborted,
} from './run-stages-utils.js'
