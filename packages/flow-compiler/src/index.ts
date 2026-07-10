/**
 * @dzupagent/flow-compiler — public entry point.
 *
 * Exports the `createFlowCompiler` factory, convenience re-exports of each
 * pipeline stage, and all public types.
 *
 * Stage pipeline:
 *   1. parseFlow       — JSON/object → FlowNode AST  (errors: stage 1)
 *   2. validateShape   — structural validation         (errors: stage 2)
 *   3. semanticResolve — tool/persona ref resolution  (errors: stage 3, halts)
 *   4. routeTarget + lower — emit artifact            (errors: stage 4)
 *
 * Workflow ownership boundary:
 *   The flow compiler owns semantic resolution and target artifact expansion.
 *   Flow shape validation belongs in `@dzupagent/flow-ast`; text DSL parsing
 *   belongs in `@dzupagent/flow-dsl`. Adapter-oriented fluent workflows in
 *   `@dzupagent/agent-adapters` share only the `@dzupagent/core`
 *   `PipelineDefinition` runtime contract; provider routing, prompt
 *   templating, adapter retry policy, adapter loop execution, adapter parallel
 *   merge, and adapter workflow events are not compiler semantics.
 *
 * Since Wave 11 `compile()` is always asynchronous. Sync resolvers pay a
 * single unconditional microtask per compile — a negligible cost relative to
 * parse + shape-validate + lower. See ADR `DECISIONS_WAVE_11.md`.
 */

import type { DzupEventBus } from "@dzupagent/core";

import {
  runCompile,
  runCompileDocument,
  runCompileDsl,
} from "./compile-orchestrator.js";
import type {
  CompileOrchestratorDeps,
  FlowCompileEvent,
} from "./compile-orchestrator.js";

import type { CompilerOptions, FlowCompiler } from "./types.js";

export * from "./types.js";
export {
  prepareFlowInputFromDocument,
  prepareFlowInputFromDsl,
} from "./authoring-input.js";
export { compileTextInput, isFlowDocumentJson } from "./cli-input.js";
export {
  createToolResolverFromRegistry,
  createToolsetResolverFromCatalog,
  validateHostToolRegistry,
  validateToolsetCatalog,
} from "./host-tool-registry.js";
export type {
  HostToolRegistryValidationResult,
  ToolsetCatalogValidationResult,
} from "./host-tool-registry.js";
export { collectFlowArtifactMetadata } from "./flow-artifact-metadata.js";
export type {
  FlowArtifactMetadata,
  FlowArtifactNodeMetadata,
} from "./flow-artifact-metadata.js";
export {
  DZUPAGENT_PIPELINE_HOST_MANIFEST,
  FLOW_NODE_CAPABILITY_REGISTRY,
  FLOW_VALIDATION_PROFILES,
  TARGET_CAPABILITY_MANIFESTS,
  collectFlowRequirements,
  generateFlowConformanceMatrix,
  renderFlowConformanceMatrixMarkdown,
  resolveHostReadiness,
} from "./capability-manifest.js";
export type {
  FlowCapabilityOwner,
  FlowConformanceMatrix,
  FlowNodeCapabilityDescriptor,
  FlowNodeLoweringMode,
  FlowNodeSupportStatus,
  FlowRequirementSummary,
  FlowValidationProfile,
  FlowValidationProfileId,
  HostCapabilityManifest,
  HostReadinessDiagnostic,
  HostReadinessResult,
  RecommendedFlowProfile,
  TargetCapabilityLimitation,
  TargetCapabilityManifest,
} from "./capability-manifest.js";
export { validateShape } from "./stages/shape-validate.js";
export { semanticResolve } from "./stages/semantic.js";
export type { SemanticOptions, SemanticResult } from "./stages/semantic.js";
export {
  currentFlowRefFromDocument,
  inlineSubflows,
} from "./stages/subflow-inline.js";
export type {
  InlineSubflowOptions,
  InlineSubflowResult,
} from "./stages/subflow-inline.js";
export { analyzeFlowExpression } from "./stages/expression-validate.js";
export {
  routeTarget,
  computeFeatureBitmask,
  hasOnError,
  FEATURE_BITS,
  collectUnsupportedRuntimeNodes,
} from "./route-target.js";
export type { UnsupportedRuntimeNode } from "./route-target.js";
export {
  lowerCheckpointNode,
  lowerRestoreNode,
} from "./lower/lower-checkpoint.js";
export type {
  LoweredNode,
  LoweredCheckpointNode,
  LoweredRestoreNode,
} from "./lower/lower-checkpoint.js";
export { parseFlow } from "@dzupagent/flow-ast";
export type { FlowDocumentPolicy, ParseInput } from "@dzupagent/flow-ast";
export type {
  ProfileRegistry,
  ProfileLookupScope,
  ResolvedProfile,
  ResolvedProfilePolicy,
} from "./profile-registry.js";
export {
  resolveAgentProfile,
  applyProfileToNode,
} from "./stages/semantic-profile-resolver.js";

// ---------------------------------------------------------------------------
// Compiler factory (thin façade)
// ---------------------------------------------------------------------------
//
// The four-stage compile orchestration lives in `./compile-orchestrator.ts`.
// This factory only validates construction-time invariants, builds the `emit`
// callback, and delegates to the orchestrator's `runCompile` family with an
// explicit dependency object. Keep this barrel thin — orchestration logic and
// its private helpers belong in the orchestrator module, not here.

const NOOP_EMIT: (_e: FlowCompileEvent) => void = () => {
  /* no-op; forwardInnerEvents is off or no bus provided */
};

/**
 * Create a reusable flow compiler bound to the supplied resolver options.
 *
 * The returned `compile(input)` function runs the four-stage pipeline:
 *   1. Parse (stage 1)
 *   2. Shape validation (stage 2)
 *   3. Semantic resolution (stage 3) — halts on any error
 *   4. Lowering to compilation target (stage 4)
 *
 * Stages 1 and 2 errors are combined into a single returned `errors` array.
 * Stage 3 errors halt the pipeline (lowering cannot proceed without resolved
 * refs). Stage 4 errors are structural invariant violations (e.g. `on_error`
 * in a skill-chain-routed flow) that survive all earlier gates.
 *
 * Returns `Promise<CompileSuccess | CompileFailure>`. Both result shapes
 * carry a `compileId: string` (UUIDv4) so external correlation with emitted
 * lifecycle events on the shared `DzupEventBus` is trivial.
 *
 * @throws {Error} if `opts.forwardInnerEvents === true` and `opts.eventBus`
 *   is not supplied. Construct-time throw, never at compile time.
 */
export function createFlowCompiler(opts: CompilerOptions): FlowCompiler {
  if (opts.forwardInnerEvents === true && opts.eventBus === undefined) {
    throw new Error(
      "flow-compiler: forwardInnerEvents=true requires an eventBus — " +
        "pass `eventBus` in CompilerOptions or leave forwardInnerEvents unset."
    );
  }

  // Capture `emit` once at factory time. When forwarding is off the callable
  // is a no-op; emission sites pay a single indirect call and no branch.
  // See ADR §4.5 for the branchless-hot-path rationale.
  const emit: (e: FlowCompileEvent) => void =
    opts.forwardInnerEvents === true && opts.eventBus !== undefined
      ? (
          (bus: DzupEventBus) => (e: FlowCompileEvent) =>
            bus.emit(e)
        )(opts.eventBus)
      : NOOP_EMIT;

  // Inject the captured resolver options and `emit` sink into the
  // orchestration. The pipeline body and its private helpers live in
  // `./compile-orchestrator.ts`; this façade only wires dependencies.
  const deps: CompileOrchestratorDeps = { opts, emit };

  return {
    compile: (input, invocationOptions) =>
      runCompile(deps, input, invocationOptions),
    compileDocument: (document) => runCompileDocument(deps, document),
    compileDsl: (source) => runCompileDsl(deps, source),
  };
}
