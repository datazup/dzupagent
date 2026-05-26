/**
 * @dzupagent/flow-compiler — public entry point.
 *
 * Exports the `createFlowCompiler` factory, convenience re-exports of each
 * pipeline stage, and all public types. The compilation pipeline
 * implementation lives in `./compile-pipeline.ts`; this module is the public
 * API barrel and must remain the stable export surface for the package.
 *
 * Stage pipeline:
 *   1. parseFlow       — JSON/object → FlowNode AST  (errors: stage 1)
 *   2. validateShape   — structural validation         (errors: stage 2)
 *   3. semanticResolve — tool/persona ref resolution  (errors: stage 3, halts)
 *   4. routeTarget + lower — emit artifact            (errors: stage 4)
 *
 * Workflow ownership boundary:
 *   The flow compiler is the canonical owner of FlowDocument/FlowNode
 *   authoring semantics and lowering. Adapter-oriented fluent workflows in
 *   `@dzupagent/agent-adapters` remain a compatibility DSL that shares only
 *   the `@dzupagent/core` `PipelineDefinition` runtime contract; provider
 *   routing, prompt templating, adapter retry policy, adapter loop execution,
 *   adapter parallel merge, and adapter workflow events are not compiler
 *   semantics.
 *
 * Since Wave 11 `compile()` is always asynchronous. Sync resolvers pay a
 * single unconditional microtask per compile — a negligible cost relative to
 * parse + shape-validate + lower. See ADR `DECISIONS_WAVE_11.md`.
 */

export { createFlowCompiler } from './compile-pipeline.js'

export * from './types.js'
export { prepareFlowInputFromDocument, prepareFlowInputFromDsl } from './authoring-input.js'
export { compileTextInput, isFlowDocumentJson } from './cli-input.js'
export {
  createToolResolverFromRegistry,
  createToolsetResolverFromCatalog,
  validateHostToolRegistry,
  validateToolsetCatalog,
} from './host-tool-registry.js'
export type {
  HostToolRegistryValidationResult,
  ToolsetCatalogValidationResult,
} from './host-tool-registry.js'
export { collectFlowArtifactMetadata } from './flow-artifact-metadata.js'
export type {
  FlowArtifactMetadata,
  FlowArtifactNodeMetadata,
} from './flow-artifact-metadata.js'
export { validateShape } from './stages/shape-validate.js'
export { semanticResolve } from './stages/semantic.js'
export type { SemanticOptions, SemanticResult } from './stages/semantic.js'
export {
  collectUnsupportedRuntimeNodes,
  routeTarget,
  computeFeatureBitmask,
  hasOnError,
  FEATURE_BITS,
} from './route-target.js'
export { lowerCheckpointNode, lowerRestoreNode } from './lower/lower-checkpoint.js'
export type {
  LoweredNode,
  LoweredCheckpointNode,
  LoweredRestoreNode,
} from './lower/lower-checkpoint.js'
export { parseFlow } from '@dzupagent/flow-ast'
export type { FlowDocumentPolicy, ParseInput } from '@dzupagent/flow-ast'
export type {
  ProfileRegistry,
  ProfileLookupScope,
  ResolvedProfile,
  ResolvedProfilePolicy,
} from './profile-registry.js'
export { resolveAgentProfile, applyProfileToNode } from './stages/semantic-profile-resolver.js'
