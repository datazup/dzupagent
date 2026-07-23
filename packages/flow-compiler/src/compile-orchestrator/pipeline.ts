/**
 * @dzupagent/flow-compiler — four-stage compile pipeline (internal).
 *
 * This module owns {@link runCompile}, the four-stage compile pipeline that
 * backs the public `createFlowCompiler` factory, along with the shared
 * `CompileOrchestratorDeps`/`FlowCompileEvent` contracts. It is intentionally
 * NOT part of the package public barrel (`index.ts`); `index.ts` stays a thin
 * façade that wires dependencies (resolvers + the `emit` callback) and
 * delegates through the `../compile-orchestrator.js` re-export.
 *
 * The orchestration was previously expressed as closures inside
 * `createFlowCompiler`, capturing `opts` and `emit` from factory scope. It is
 * now expressed as plain functions that receive those captures as an explicit
 * `CompileOrchestratorDeps` parameter (dependency injection), so the pipeline
 * is independently testable and the public barrel no longer carries the bulk
 * of the implementation.
 *
 * Stage pipeline:
 *   1. parseFlow       — JSON/object → FlowNode AST  (errors: stage 1)
 *   2. validateShape   — structural validation         (errors: stage 2)
 *   3. semanticResolve — tool/persona ref resolution  (errors: stage 3, halts)
 *   4. routeTarget + lower — emit artifact            (errors: stage 4)
 *
 * Since Wave 11 `runCompile` is always asynchronous. Sync resolvers pay a
 * single unconditional microtask per compile — a negligible cost relative to
 * parse + shape-validate + lower. See ADR `DECISIONS_WAVE_11.md`.
 */

import { parseFlow } from "@dzupagent/flow-ast";
import type { ParseInput } from "@dzupagent/flow-ast";
import type { DzupEvent } from "@dzupagent/core";

import { validateShape } from "../stages/shape-validate.js";
import { semanticResolve } from "../stages/semantic.js";
import {
  collectUnsupportedRuntimeNodes,
  routeTarget,
} from "../route-target.js";
import { lowerSkillChain } from "../lower/lower-skill-chain.js";
import { lowerPipelineFlat } from "../lower/lower-pipeline-flat.js";
import { lowerPipelineLoop } from "../lower/lower-pipeline-loop.js";
import { hasOnError } from "../route-target.js";
import { collectFleetSteps } from "../lower/lower-fleet-nodes.js";
import type { LoweredFleetStep } from "../lower/lower-fleet-nodes.js";
import { inlineSubflows } from "../stages/subflow-inline.js";
import { collectFlowRequirements } from "../capability-manifest.js";
import {
  attachFlowCompiledClassificationEnvelope,
  createFlowCompiledClassificationEnvelope,
} from "../classification-envelope.js";

import type {
  CompilerOptions,
  CompileInvocationOptions,
  CompilationError,
  CompileFailure,
  FlowCompileSourceKind,
  CompileSuccess,
  FlowCompileSubflowEvidence,
} from "../types.js";

import {
  buildCompileEvidence,
  extractFragmentExpansions,
  hashSource,
} from "./evidence.js";
import {
  conformanceWarnings,
  countArtifact,
  countDiagnosticsByCategory,
  defaultSourceKind,
  extractSuggestionFromMessage,
  jsonPointerToNodePath,
  targetReasons,
  toCompilationWarnings,
  toSemanticWarnings,
} from "./diagnostics.js";
import {
  createSemanticReferenceSnapshot,
  type SourceReferenceSnapshot,
} from "./reference-snapshot.js";

// Flow compiler event shapes are part of the canonical `DzupEvent` union in
// `@dzupagent/core` (Wave 11 ADR §4). We narrow to the relevant subset here
// so `emit` site types remain tight without reintroducing the legacy cast.
export type FlowCompileEvent = Extract<
  DzupEvent,
  {
    type:
      | "flow:compile_started"
      | "flow:compile_parsed"
      | "flow:compile_shape_validated"
      | "flow:compile_semantic_resolved"
      | "flow:compile_lowered"
      | "flow:compile_completed"
      | "flow:compile_failed";
  }
>;

/**
 * Dependencies injected into the compile orchestration by the
 * `createFlowCompiler` façade. These are exactly the values the pipeline
 * previously closed over from factory scope:
 *
 *  - `opts`: the resolver/registry/target options supplied at factory time.
 *  - `emit`: the lifecycle-event sink. A no-op when inner-event forwarding is
 *    off; otherwise bound to the supplied `DzupEventBus`.
 */
export interface CompileOrchestratorDeps {
  readonly opts: CompilerOptions;
  readonly emit: (e: FlowCompileEvent) => void;
}

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

  if (parseResult.ast === null) {
    emit({
      type: "flow:compile_failed",
      compileId,
      stage: 1,
      errorCount: stage1Errors.length,
      durationMs: Date.now() - startedAt,
    });
    return {
      errors: stage1Errors,
      compileId,
      diagnosticCountsByCategory: countDiagnosticsByCategory(stage1Errors),
    };
  }

  let ast = parseResult.ast;

  if (opts.flowDocumentResolver !== undefined) {
    const inlineResult = await inlineSubflows(ast, opts.flowDocumentResolver, {
      currentFlowRef: invocationOptions.currentFlowRef,
    });
    if (inlineResult.diagnostics.length > 0) {
      emit({
        type: "flow:compile_failed",
        compileId,
        stage: 2,
        errorCount: inlineResult.diagnostics.length,
        durationMs: Date.now() - startedAt,
      });
      return {
        errors: inlineResult.diagnostics,
        compileId,
        diagnosticCountsByCategory: countDiagnosticsByCategory(
          inlineResult.diagnostics
        ),
      };
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
    const failingStage: 1 | 2 = stage1Errors.length > 0 ? 1 : 2;
    emit({
      type: "flow:compile_failed",
      compileId,
      stage: failingStage,
      errorCount: combinedEarly.length,
      durationMs: Date.now() - startedAt,
    });
    return {
      errors: combinedEarly,
      compileId,
      diagnosticCountsByCategory: countDiagnosticsByCategory(combinedEarly),
    };
  }

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
    const stage3Errors: CompilationError[] = semanticResult.errors.map((e) => ({
      stage: 3 as const,
      code: e.code,
      message: e.message,
      nodePath: e.nodePath,
      category: e.category ?? "resolution",
      ...extractSuggestionFromMessage(e.message),
      ...(e.span !== undefined ? { span: e.span } : {}),
    }));
    emit({
      type: "flow:compile_failed",
      compileId,
      stage: 3,
      errorCount: stage3Errors.length,
      durationMs: Date.now() - startedAt,
    });
    return {
      errors: stage3Errors,
      compileId,
      diagnosticCountsByCategory: countDiagnosticsByCategory(stage3Errors),
    };
  }

  const { resolved, resolvedPersonas } = semanticResult;
  const semanticWarnings = toSemanticWarnings(semanticResult.warnings);
  // -----------------------------------------------------------------------
  // Stage 4: Route + lower
  // -----------------------------------------------------------------------
  const { target, bitmask } = routeTarget(ast);
  const requirements = collectFlowRequirements(ast);

  // Stage 4: reject runtime leaves that the selected target cannot represent.
  const unsupportedRuntimeNodes = collectUnsupportedRuntimeNodes(ast, target);
  if (unsupportedRuntimeNodes.length > 0) {
    const stage4Errors: CompilationError[] = unsupportedRuntimeNodes.map(
      (node) => ({
        stage: 4 as const,
        code: "UNSUPPORTED_RUNTIME_NODE_FOR_TARGET",
        message:
          `Node type "${node.type}" at "${node.path}" is valid in the AST but cannot be represented by ` +
          `the "${target}" generic compiler target. Use a runtime that executes this node kind or add a ` +
          "reviewed executable target contract before emitting artifacts.",
        nodePath: node.path,
        category: "lowering",
      })
    );
    emit({
      type: "flow:compile_failed",
      compileId,
      stage: 4,
      errorCount: stage4Errors.length,
      durationMs: Date.now() - startedAt,
    });
    return {
      errors: stage4Errors,
      compileId,
      diagnosticCountsByCategory: countDiagnosticsByCategory(stage4Errors),
    };
  }

  // Stage 4 defense-in-depth: skill-chain target must not carry on_error.
  // validateShape (stage 2) already catches this via OI-4, but if a caller
  // constructs an AST directly and bypasses stage 2, this backstop fires.
  if (target === "skill-chain" && hasOnError(ast)) {
    const stage4Error: CompilationError = {
      stage: 4,
      code: "UNSUPPORTED_FIELD",
      message: "on_error is only legal in pipeline-targeted flows",
      nodePath: "root",
      category: "lowering",
    };
    emit({
      type: "flow:compile_failed",
      compileId,
      stage: 4,
      errorCount: 1,
      durationMs: Date.now() - startedAt,
    });
    return {
      errors: [stage4Error],
      compileId,
      diagnosticCountsByCategory: countDiagnosticsByCategory([stage4Error]),
    };
  }

  let artifact: unknown;
  let warnings: string[];
  try {
    if (target === "skill-chain") {
      const out = lowerSkillChain({ ast, resolved, mode: "executable" });
      artifact = out.artifact;
      warnings = out.warnings;
    } else if (target === "workflow-builder" || target === "planning-dag") {
      const out = lowerPipelineFlat({
        ast,
        resolved,
        resolvedPersonas,
        mode: "executable",
      });
      artifact = out.artifact;
      warnings = out.warnings;
    } else {
      // target === 'pipeline'
      const out = lowerPipelineLoop({
        ast,
        resolved,
        resolvedPersonas,
        mode: "executable",
      });
      artifact = out.artifact;
      warnings = out.warnings;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const emptyArtifact = /no (?:nodes|action nodes) (?:produced|found)/i.test(
      message
    );
    const stage4Error: CompilationError = {
      stage: 4,
      code: emptyArtifact ? "EMPTY_TARGET_ARTIFACT" : "LOWERING_FAILED",
      message: emptyArtifact
        ? `The "${target}" target produced no executable nodes. Add an executable anchor or use a host/runtime that declares the required node capabilities.`
        : `The "${target}" target failed to lower the flow: ${message}`,
      nodePath: "root",
      category: "lowering",
    };
    emit({
      type: "flow:compile_failed",
      compileId,
      stage: 4,
      errorCount: 1,
      durationMs: Date.now() - startedAt,
    });
    return {
      errors: [stage4Error],
      compileId,
      diagnosticCountsByCategory: countDiagnosticsByCategory([stage4Error]),
    };
  }

  const compilationWarnings = [
    ...semanticWarnings,
    ...toCompilationWarnings(warnings),
    ...conformanceWarnings(requirements),
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
    warnings: compilationWarnings,
    reasons: targetReasons(target, bitmask),
    requirements,
    compileId,
    evidence: buildCompileEvidence({
      ast,
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
