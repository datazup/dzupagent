// Barrel module: the run-stages persistence helpers were split into focused
// leaf modules under `run-stages-persistence/` to keep each file under the
// size budget. The canonical homes are:
//
//   - run-stages-persistence/terminal.ts   — terminal success/cancel/failure
//                                             persistence
//   - run-stages-persistence/telemetry.ts  — distributed cost ledger + metrics
//   - run-stages-persistence/learning.ts   — post-run learning (reflection,
//                                             outcome analysis, context transfer)
//   - run-stages-persistence/shared.ts     — shared type + best-effort logger
//
// Existing callers (run-worker-stages.ts barrel, tests) continue to import
// from this module for backward compatibility.

export type { TerminalPersistenceResult } from "./run-stages-persistence/shared.js";
export {
  persistCancellation,
  persistFailure,
  persistTerminalSuccess,
} from "./run-stages-persistence/terminal.js";
export {
  recordDistributedCost,
  recordTelemetryStage,
} from "./run-stages-persistence/telemetry.js";
export { runPostRunLearningStage } from "./run-stages-persistence/learning.js";
