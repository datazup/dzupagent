/**
 * @dzupagent/flow-compiler — compile-stage orchestration façade (internal).
 *
 * This module is the internal entry point that backs the public
 * `createFlowCompiler` factory. It is intentionally NOT part of the package
 * public barrel (`index.ts`); `index.ts` stays a thin façade that wires
 * dependencies (resolvers + the `emit` callback) and delegates here.
 *
 * The orchestration was originally a single ~880-LOC module. Under the MJ-01
 * deferred-decomposition track it was split into focused leaf modules under
 * `./compile-orchestrator/`, and this file collapsed to a thin re-export that
 * preserves the pre-split import surface exactly (structural move only — no
 * behavior change):
 *
 *   - `./compile-orchestrator/pipeline.ts`    — the four-stage `runCompile`
 *     pipeline plus the `CompileOrchestratorDeps` / `FlowCompileEvent` contracts.
 *   - `./compile-orchestrator/document.ts`    — the `runCompileDocument` /
 *     `runCompileDsl` source-shaped entry points and document-policy extraction.
 *   - `./compile-orchestrator/evidence.ts`    — compile-evidence construction
 *     and deterministic source hashing.
 *   - `./compile-orchestrator/diagnostics.ts` — diagnostic/telemetry helpers.
 */

export { runCompile } from "./compile-orchestrator/pipeline.js";
export type {
  CompileOrchestratorDeps,
  FlowCompileEvent,
} from "./compile-orchestrator/pipeline.js";
export {
  runCompileDocument,
  runCompileDsl,
} from "./compile-orchestrator/document.js";
