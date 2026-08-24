/**
 * @dzupagent/flow-compiler — four-stage compile pipeline (internal).
 *
 * Stage pipeline:
 *   1. parseFlow       — JSON/object → FlowNode AST  (errors: stage 1)
 *   2. validateShape   — structural validation         (errors: stage 2)
 *   3. semanticResolve — tool/persona ref resolution  (errors: stage 3, halts)
 *   4. routeTarget + lower — emit artifact            (errors: stage 4)
 *
 * This module owns stage *sequencing* only: what runs, in what order, and
 * which failure halts the run. The work each stage does lives in a sibling
 * module (`target-admission`, `lowering`, `primitive-admission`,
 * `v2-target-gates`), and every halt goes through `failCompile` so the emitted
 * lifecycle event and the returned failure cannot disagree.
 */

import { parseFlow } from "@dzupagent/flow-ast";
import type { ParseInput } from "@dzupagent/flow-ast";

import { validateShape } from "../stages/shape-validate.js";
import { semanticResolve } from "../stages/semantic.js";
import { routeTarget } from "../route-target.js";
import { collectFleetSteps } from "../lower/lower-fleet-nodes.js";
import type { LoweredFleetStep } from "../lower/lower-fleet-nodes.js";
import { inlineSubflows } from "../stages/subflow-inline.js";
import { collectFlowRequirements } from "../capability-manifest.js";
import {
  attachFlowCompiledClassificationEnvelope,
  createFlowCompiledClassificationEnvelope,
} from "../classification-envelope.js";
import {
  bindFlowRequirementsToPrimitiveRegistry,
} from "../primitive-registry-admission.js";

import type {
  CompileInvocationOptions,
  CompilationError,
  CompileFailure,
  FlowCompileSourceKind,
  CompileSuccess,
  FlowCompileSubflowEvidence,
} from "../types.js";

import {
  buildCompileEvidence,
  hashSource,
} from "./evidence.js";
import {
  conformanceWarnings,
  countArtifact,
  countDiagnosticsByCategory,
  defaultSourceKind,
  jsonPointerToNodePath,
  targetReasons,
  toSemanticErrors,
  toCompilationWarnings,
  toSemanticWarnings,
} from "./diagnostics.js";
import {
  createSemanticReferenceSnapshot,
  type SourceReferenceSnapshot,
} from "./reference-snapshot.js";
import { rejectInvalidPrimitiveSelection } from "./primitive-admission.js";
import { collectUnsupportedV2TargetErrors } from "./v2-target-gates.js";
import {
  collectSkillChainOnErrorErrors,
  collectUnsupportedRuntimeNodeErrors,
} from "./target-admission.js";
import { lowerAdmittedFlow } from "./lowering.js";
import { failCompile, type CompileFailureSink } from "./compile-failure.js";
import type { CompileOrchestratorDeps } from "./contracts.js";

/**
 * Run the four-stage compile pipeline for a parsed flow input.
 *
 * Stages 1 and 2 errors are combined into a single returned `errors` array.
 * Stage 3 errors halt the pipeline (lowering cannot proceed without resolved
 * refs). Stage 4 errors are structural invariant violations (e.g. `on_error`
 * in a skill-chain-routed flow) that survive all earlier gates.
 *
 * Returns `Promise<CompileSuccess | CompileFailure>`. Both result shapes carry
 * a `compileId: string` (UUIDv4) so external correlation with emitted
 * lifecycle events on the shared `DzupEventBus` is trivial.
 */
export async function runCompile(
  deps: CompileOrchestratorDeps,
  input: ParseInput,
  invocationOptions: CompileInvocationOptions = {},
  sourceReferences: SourceReferenceSnapshot = {},
): Promise<CompileSuccess | CompileFailure> {
  const { opts, emit } = deps;
  const compileId = crypto.randomUUID();
  const startedAt = Date.now();
  const fail: CompileFailureSink = { emit, compileId, startedAt };
  const sourceKind: FlowCompileSourceKind =
    invocationOptions.sourceKind ?? defaultSourceKind(input);
  const sourceHash = hashSource(invocationOptions.source ?? input);
  let subflowEvidence: FlowCompileSubflowEvidence[] = [];

  emit({
    type: "flow:compile_started",
    compileId,
    inputKind: typeof input === "string" ? "json-string" : "object",
  });

  // -----------------------------------------------------------------------
  // Stage 1: Parse
  // -----------------------------------------------------------------------
  const parseResult = parseFlow(input);

  const stage1Errors: CompilationError[] = parseResult.errors.map((e) => ({
    stage: 1 as const,
    code: e.code,
    message: e.message,
    nodePath: jsonPointerToNodePath(e.pointer),
    category: "shape",
  }));

  emit({
    type: "flow:compile_parsed",
    compileId,
    astNodeType: parseResult.ast === null ? null : parseResult.ast.type,
    errorCount: stage1Errors.length,
  });

  if (parseResult.ast === null) return failCompile(fail, 1, stage1Errors);

  let ast = parseResult.ast;

  if (opts.flowDocumentResolver !== undefined) {
    const inlineResult = await inlineSubflows(ast, opts.flowDocumentResolver, {
      currentFlowRef: invocationOptions.currentFlowRef,
    });
    if (inlineResult.diagnostics.length > 0) {
      return failCompile(fail, 2, inlineResult.diagnostics);
    }
    ast = inlineResult.root;
    subflowEvidence = inlineResult.subflows;
  }

  // -----------------------------------------------------------------------
  // Stage 2: Shape validation
  // -----------------------------------------------------------------------
  const shapeErrors = validateShape(ast);

  const stage2Errors: CompilationError[] = shapeErrors.map((e) => ({
    stage: 2 as const,
    code: e.code,
    message: e.message,
    nodePath: e.nodePath,
    category: "shape",
  }));

  emit({
    type: "flow:compile_shape_validated",
    compileId,
    errorCount: stage2Errors.length,
  });

  // Stages 1 + 2 combine. If either set is non-empty, return early.
  const combinedEarly = [...stage1Errors, ...stage2Errors];
  if (combinedEarly.length > 0) {
    // Failing stage is whichever produced errors; stage 2 supersedes
    // stage 1 here only if stage 1 was clean (ast !== null implies
    // stage 1 at least yielded an AST, possibly with recoverable
    // warnings; the failing stage from the caller's perspective is 2
    // when stage 1 reported zero errors).
    return failCompile(fail, stage1Errors.length > 0 ? 1 : 2, combinedEarly);
  }

  const primitiveSelectionFailure = rejectInvalidPrimitiveSelection(
    ast,
    opts,
    fail,
  );
  if (primitiveSelectionFailure !== undefined) return primitiveSelectionFailure;

  // -----------------------------------------------------------------------
  // Stage 3: Semantic resolution — halts on any error
  // -----------------------------------------------------------------------
  const referenceSnapshot = createSemanticReferenceSnapshot(
    ast,
    sourceReferences,
    opts,
  );
  const semanticResult = await semanticResolve(ast, {
    toolResolver: opts.toolResolver,
    personaResolver: opts.personaResolver,
    ...(opts.toolsetResolver !== undefined
      ? { toolsetResolver: opts.toolsetResolver }
      : {}),
    ...(opts.profileRegistry !== undefined
      ? { profileRegistry: opts.profileRegistry }
      : {}),
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.referencePolicy !== undefined
      ? { referencePolicy: opts.referencePolicy }
      : {}),
    ...(opts.admissionProfile !== undefined
      ? { admissionProfile: opts.admissionProfile }
      : {}),
    ...(opts.primitiveRegistry !== undefined
      ? { primitiveRegistry: opts.primitiveRegistry }
      : {}),
    ...(opts.primitiveBindings !== undefined
      ? { primitiveBindings: opts.primitiveBindings }
      : {}),
    ...referenceSnapshot,
  });

  emit({
    type: "flow:compile_semantic_resolved",
    compileId,
    resolvedCount: semanticResult.resolved.size,
    personaCount: semanticResult.resolvedPersonas.size,
    errorCount: semanticResult.errors.length,
  });

  if (semanticResult.errors.length > 0) {
    return failCompile(
      fail,
      3,
      toSemanticErrors(semanticResult.errors, sourceReferences.dslSourceMap),
    );
  }

  const { resolved, resolvedPersonas } = semanticResult;
  const semanticWarnings = toSemanticWarnings(
    semanticResult.warnings,
    sourceReferences.dslSourceMap,
  );

  // -----------------------------------------------------------------------
  // Stage 4: Route + lower
  // -----------------------------------------------------------------------
  const { target, bitmask } = routeTarget(ast);
  const requirements = bindFlowRequirementsToPrimitiveRegistry(
    ast,
    collectFlowRequirements(ast),
    opts.primitiveRegistry,
    opts.primitiveBindings,
  );

  // Target admission gates, in the order a violation should be reported:
  // node kinds the target cannot represent, then v2 capability shortfalls,
  // then the structural on_error backstop.
  const unsupportedRuntimeNodes = collectUnsupportedRuntimeNodeErrors(
    ast,
    target,
  );
  if (unsupportedRuntimeNodes.length > 0) {
    return failCompile(fail, 4, unsupportedRuntimeNodes);
  }

  const unsupportedV2TargetErrors = collectUnsupportedV2TargetErrors(
    ast,
    target,
    sourceReferences,
    opts.targetCapabilities,
  );
  if (unsupportedV2TargetErrors.length > 0) {
    return failCompile(fail, 4, unsupportedV2TargetErrors);
  }

  const skillChainOnErrorErrors = collectSkillChainOnErrorErrors(ast, target);
  if (skillChainOnErrorErrors.length > 0) {
    return failCompile(fail, 4, skillChainOnErrorErrors);
  }

  const lowered = lowerAdmittedFlow({
    ast,
    target,
    resolved,
    resolvedPersonas,
    opts,
  });
  if (!lowered.ok) return failCompile(fail, 4, lowered.errors);

  const { artifact, ports } = lowered;
  const compilationWarnings = [
    ...semanticWarnings,
    ...toCompilationWarnings(lowered.warnings),
    ...conformanceWarnings(requirements),
    ...lowered.suspendedExitWarnings,
  ];

  // Collect fleet/knowledge steps from the AST and attach to the artifact so
  // runtimes that execute fleet nodes can find them without re-walking the tree.
  const fleetSteps: LoweredFleetStep[] = collectFleetSteps(ast);
  if (fleetSteps.length > 0) {
    (artifact as Record<string, unknown>)["fleetSteps"] = fleetSteps;
  }
  const classificationEnvelope = createFlowCompiledClassificationEnvelope(
    ast,
    compileId,
    requirements.semanticHash,
    referenceSnapshot,
    resolved,
    opts.primitiveRegistry,
    opts.primitiveBindings,
  );
  attachFlowCompiledClassificationEnvelope(artifact, classificationEnvelope);

  // Best-effort node/edge counts. The `artifact` shapes differ by target;
  // we read common fields defensively to keep the emit site target-agnostic.
  const { nodeCount, edgeCount } = countArtifact(target, artifact);

  emit({
    type: "flow:compile_lowered",
    compileId,
    target,
    nodeCount,
    edgeCount,
    warningCount: compilationWarnings.length,
  });

  emit({
    type: "flow:compile_completed",
    compileId,
    target,
    durationMs: Date.now() - startedAt,
  });

  return {
    target,
    artifact,
    classificationEnvelope,
    ...(ports !== undefined ? { ports } : {}),
    warnings: compilationWarnings,
    reasons: targetReasons(target, bitmask),
    requirements,
    compileId,
    evidence: buildCompileEvidence({
      ast,
      artifact,
      compileId,
      target,
      sourceKind,
      sourceHash,
      semanticHash: requirements.semanticHash,
      correlation: invocationOptions.correlation,
      subflows: subflowEvidence,
      fragments: invocationOptions.fragmentExpansions,
    }),
    diagnosticCountsByCategory: countDiagnosticsByCategory(compilationWarnings),
  };
}
