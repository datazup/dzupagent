/**
 * @dzupagent/flow-compiler — compile-stage orchestration (internal).
 *
 * This module owns the four-stage compile pipeline that backs the public
 * `createFlowCompiler` factory. It is intentionally NOT part of the package
 * public barrel (`index.ts`); `index.ts` stays a thin façade that wires
 * dependencies (resolvers + the `emit` callback) and delegates here.
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

import { createHash } from "node:crypto";
import { parseFlow } from "@dzupagent/flow-ast";
import type {
  FlowDocumentPolicy,
  FlowDurabilityPolicy,
  FlowNode,
  ParseInput,
} from "@dzupagent/flow-ast";
import type { DzupEvent } from "@dzupagent/core";

import { validateShape } from "./stages/shape-validate.js";
import { semanticResolve } from "./stages/semantic.js";
import {
  computeDurabilityDiagnostics,
  computeDurabilityErrors,
} from "./stages/durability-diagnostics.js";
import { collectUnsupportedRuntimeNodes, routeTarget } from "./route-target.js";
import { lowerSkillChain } from "./lower/lower-skill-chain.js";
import { lowerPipelineFlat } from "./lower/lower-pipeline-flat.js";
import { lowerPipelineLoop } from "./lower/lower-pipeline-loop.js";
import {
  checkpointStrategyFromPolicy,
  resumePolicyFromPolicy,
} from "./lower/lower-durability-strategy.js";
import { hasOnError } from "./route-target.js";
import { collectFleetSteps } from "./lower/lower-fleet-nodes.js";
import type { LoweredFleetStep } from "./lower/lower-fleet-nodes.js";
import {
  prepareFlowInputFromDocument,
  prepareFlowInputFromDsl,
} from "./authoring-input.js";
import { collectFlowArtifactMetadata } from "./flow-artifact-metadata.js";

import type {
  CompilerOptions,
  CompileInvocationOptions,
  CompilationError,
  CompilationTarget,
  CompilationTargetReason,
  CompilationWarning,
  CompileFailure,
  FlowCompileEvidence,
  FlowCompileSourceKind,
  CompileSuccess,
} from "./types.js";

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
  invocationOptions: CompileInvocationOptions = {}
): Promise<CompileSuccess | CompileFailure> {
  const { opts, emit } = deps;
  const compileId = crypto.randomUUID();
  const startedAt = Date.now();
  const sourceKind = invocationOptions.sourceKind ?? defaultSourceKind(input);
  const sourceHash = hashSource(invocationOptions.source ?? input);

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

  const ast = parseResult.ast;

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

  // -----------------------------------------------------------------------
  // Stage 4: Route + lower
  // -----------------------------------------------------------------------
  const { target, bitmask } = routeTarget(ast);

  // Stage 4: reject unsupported runtime node types before attempting lowering.
  // Nodes like 'agent', 'validate', 'prompt', and 'return_to' are valid in the
  // AST but cannot be lowered by the generic compiler targets.
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
  if (target === "skill-chain") {
    const out = lowerSkillChain({ ast, resolved, mode: "executable" });
    artifact = out.artifact;
    warnings = out.warnings;
  } else if (target === "workflow-builder") {
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

  // Collect fleet/knowledge steps from the AST and attach to the artifact so
  // runtimes that execute fleet nodes can find them without re-walking the tree.
  const fleetSteps: LoweredFleetStep[] = collectFleetSteps(ast);
  if (fleetSteps.length > 0) {
    (artifact as Record<string, unknown>)["fleetSteps"] = fleetSteps;
  }

  // Best-effort node/edge counts. The `artifact` shapes differ by target;
  // we read common fields defensively to keep the emit site target-agnostic.
  const { nodeCount, edgeCount } = countArtifact(target, artifact);

  emit({
    type: "flow:compile_lowered",
    compileId,
    target,
    nodeCount,
    edgeCount,
    warningCount: warnings.length,
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
    warnings: toCompilationWarnings(warnings),
    reasons: targetReasons(target, bitmask),
    compileId,
    evidence: buildCompileEvidence({
      ast,
      compileId,
      target,
      sourceKind,
      sourceHash,
      correlation: invocationOptions.correlation,
    }),
    diagnosticCountsByCategory: countDiagnosticsByCategory(
      toCompilationWarnings(warnings)
    ),
  };
}

/**
 * Compile a full flow document (root + document-level policy). Prepares the
 * input, delegates the root to {@link runCompile}, then re-attaches any
 * document-level policy to a successful result.
 */
export async function runCompileDocument(
  deps: CompileOrchestratorDeps,
  document: unknown
): Promise<CompileSuccess | CompileFailure> {
  const prepared = prepareFlowInputFromDocument(document);
  if (!prepared.ok) {
    return {
      compileId: crypto.randomUUID(),
      errors: prepared.errors,
      diagnosticCountsByCategory: countDiagnosticsByCategory(prepared.errors),
    };
  }

  // Extract document-level policy before handing off only the root to runCompile().
  // The policy is validated by validateFlowDocumentShape (inside prepareFlowInputFromDocument)
  // so by the time we reach here the fields are guaranteed to be well-typed.
  const documentPolicy = extractDocumentPolicy(document);
  // P0 durability contract: extract the top-level durability profile and compute
  // advisory diagnostics (D4/D5). Additive — no runtime behavior change.
  const documentDurability = extractDocumentDurability(document);
  const durabilityWarnings = computeDurabilityDiagnostics(document);

  // Gap 4 (W1 Slice 2): an explicit `requireResumePoint: true` with no reachable
  // resume point is a hard compile error — fail fast before lowering.
  const durabilityErrors = computeDurabilityErrors(document);
  if (durabilityErrors.length > 0) {
    return {
      compileId: crypto.randomUUID(),
      errors: durabilityErrors,
      diagnosticCountsByCategory: countDiagnosticsByCategory(durabilityErrors),
    };
  }

  const result = await runCompile(deps, prepared.flowInput, {
    sourceKind: "flow-document",
    source: document,
  });

  if ("errors" in result) return result;

  // W1 Slice 2: lower the document-level durability policy onto the emitted
  // PipelineDefinition. Only pipeline-shaped targets (`workflow-builder` /
  // `pipeline`) produce a PipelineDefinition; `skill-chain` artifacts have a
  // different shape and are left untouched. Absent policy ⇒ artifact unchanged
  // (byte-identical). The `CHECKPOINT_STRATEGY_COARSENED` warning is emitted by
  // the durability-diagnostics stage (canonical home), so the helper's warnings
  // are intentionally discarded here to avoid a duplicate.
  const isPipelineArtifact =
    result.target !== "skill-chain" &&
    typeof result.artifact === "object" &&
    result.artifact !== null;
  if (isPipelineArtifact) {
    const { checkpointStrategy: runtimeCheckpointStrategy } =
      checkpointStrategyFromPolicy(documentDurability);
    if (runtimeCheckpointStrategy !== undefined) {
      (result.artifact as Record<string, unknown>)["checkpointStrategy"] =
        runtimeCheckpointStrategy;
    }
    const resume = resumePolicyFromPolicy(documentDurability);
    if (resume !== undefined) {
      (result.artifact as Record<string, unknown>)["resume"] = resume;
    }
  }

  const mergedWarnings =
    durabilityWarnings.length > 0
      ? [...result.warnings, ...durabilityWarnings]
      : result.warnings;

  return {
    ...result,
    warnings: mergedWarnings,
    ...(documentPolicy !== undefined ? { documentPolicy } : {}),
    ...(documentDurability !== undefined ? { documentDurability } : {}),
    ...(durabilityWarnings.length > 0
      ? {
          diagnosticCountsByCategory:
            countDiagnosticsByCategory(mergedWarnings),
        }
      : {}),
  };
}

/**
 * Compile a DzupFlow text-DSL source. Prepares the input then delegates to
 * {@link runCompile}.
 */
export async function runCompileDsl(
  deps: CompileOrchestratorDeps,
  source: unknown
): Promise<CompileSuccess | CompileFailure> {
  const prepared = prepareFlowInputFromDsl(source);
  if (!prepared.ok) {
    return {
      compileId: crypto.randomUUID(),
      errors: prepared.errors,
      diagnosticCountsByCategory: countDiagnosticsByCategory(prepared.errors),
    };
  }
  return runCompile(deps, prepared.flowInput, {
    sourceKind: "dzupflow-dsl",
    source,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultSourceKind(input: ParseInput): FlowCompileSourceKind {
  return typeof input === "string" ? "flow-json-string" : "flow-object";
}

function hashSource(source: unknown): string {
  return `sha256:${createHash("sha256")
    .update(stableStringify(source))
    .digest("hex")}`;
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "function") return JSON.stringify("[Function]");
  if (typeof value === "symbol") return JSON.stringify(value.toString());
  if (typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (seen.has(value)) return JSON.stringify("[Circular]");

  seen.add(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`
    );
  return `{${entries.join(",")}}`;
}

function buildCompileEvidence(args: {
  ast: FlowNode;
  compileId: string;
  target: CompilationTarget;
  sourceKind: FlowCompileSourceKind;
  sourceHash: string;
  correlation?: CompileInvocationOptions["correlation"];
}): FlowCompileEvidence {
  const metadata = collectFlowArtifactMetadata(args.ast);
  const canonicalNodePaths: FlowCompileEvidence["canonicalNodePaths"] = {};
  const canonicalNodeIds = new Set<string>();

  for (const [path, node] of Object.entries(metadata.nodes)) {
    canonicalNodePaths[path] = {
      type: node.type,
      ...(node.id !== undefined ? { id: node.id } : {}),
    };
    if (node.id !== undefined && node.id.length > 0) {
      canonicalNodeIds.add(node.id);
    }
  }

  const eventCorrelationId =
    args.correlation?.eventCorrelationId ?? args.compileId;

  return {
    schema: "dzupagent.flowCompileEvidence/v1",
    sourceKind: args.sourceKind,
    sourceHash: args.sourceHash,
    compileId: args.compileId,
    canonicalNodeIds: [...canonicalNodeIds].sort(),
    canonicalNodePaths,
    loweredTarget: args.target,
    correlationIds: {
      compileId: args.compileId,
      eventCorrelationId,
      ...(args.correlation?.runId ? { runId: args.correlation.runId } : {}),
    },
  };
}

function countDiagnosticsByCategory(
  diagnostics: Array<{ category?: string }>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    const category = diagnostic.category ?? "internal";
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}

/**
 * Count nodes/edges on a lowered artifact for telemetry. Returns zeroes
 * defensively on unexpected shapes — telemetry must never crash a compile.
 */
function countArtifact(
  target: "skill-chain" | "workflow-builder" | "pipeline",
  artifact: unknown
): { nodeCount: number; edgeCount: number } {
  if (artifact === null || typeof artifact !== "object") {
    return { nodeCount: 0, edgeCount: 0 };
  }
  const obj = artifact as { nodes?: unknown; edges?: unknown; steps?: unknown };
  if (target === "skill-chain") {
    return {
      nodeCount: Array.isArray(obj.steps) ? obj.steps.length : 0,
      edgeCount: 0,
    };
  }
  return {
    nodeCount: Array.isArray(obj.nodes) ? obj.nodes.length : 0,
    edgeCount: Array.isArray(obj.edges) ? obj.edges.length : 0,
  };
}

function jsonPointerToNodePath(pointer: string): string | undefined {
  if (pointer.length === 0) return "root";

  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));

  let path = "root";
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      path += `[${part}]`;
    } else {
      path += `.${part}`;
    }
  }
  return path;
}

function extractSuggestionFromMessage(message: string): {
  suggestion?: string;
} {
  const match = /Did you mean:\s*"([^"]+)"/.exec(message);
  return match ? { suggestion: match[1] } : {};
}

function toCompilationWarnings(warnings: string[]): CompilationWarning[] {
  return warnings.map((message) => ({
    stage: 4 as const,
    code: "LOWERING_WARNING",
    category: "lowering",
    message,
  }));
}

function targetReasons(
  target: CompilationTarget,
  bitmask: number
): CompilationTargetReason[] {
  const reasons: CompilationTargetReason[] = [];

  if (bitmask === 0 && target === "skill-chain") {
    reasons.push({
      code: "SEQUENTIAL_ONLY",
      message:
        "No branching, suspend, or loop features were detected; routed to skill-chain.",
    });
    return reasons;
  }

  if ((bitmask & (1 << 0)) !== 0) {
    reasons.push({
      code: "BRANCH_PRESENT",
      message: "Branch control flow is present; skill-chain is not sufficient.",
    });
  }
  if ((bitmask & (1 << 1)) !== 0) {
    reasons.push({
      code: "PARALLEL_PRESENT",
      message:
        "Parallel control flow is present; graph-style lowering is required.",
    });
  }
  if ((bitmask & (1 << 2)) !== 0) {
    reasons.push({
      code: "SUSPEND_PRESENT",
      message: "Suspend-capable nodes are present; routed beyond skill-chain.",
    });
  }
  if ((bitmask & (1 << 3)) !== 0) {
    reasons.push({
      code: "FOR_EACH_PRESENT",
      message: "Loop semantics are present; routed to pipeline.",
    });
  }

  return reasons;
}

/**
 * Defensively extract `policy` from a raw document object. Called only after
 * `prepareFlowInputFromDocument` has already validated the shape, so the
 * cast is safe. Returns `undefined` when the field is absent.
 */
function extractDocumentPolicy(
  document: unknown
): FlowDocumentPolicy | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const raw = (document as Record<string, unknown>)["policy"];
  if (typeof raw !== "object" || raw === null) return undefined;
  const policy: FlowDocumentPolicy = {};
  const p = raw as Record<string, unknown>;
  if (typeof p["budgetCents"] === "number")
    policy.budgetCents = p["budgetCents"] as number;
  if (typeof p["timeoutMs"] === "number")
    policy.timeoutMs = p["timeoutMs"] as number;
  if (typeof p["workingDirectory"] === "string")
    policy.workingDirectory = p["workingDirectory"] as string;
  return Object.keys(policy).length > 0 ? policy : undefined;
}

/**
 * Extract the top-level `durability` block (P0). The document has already
 * passed `validateFlowDocumentShape` by the time we reach here, so the block —
 * when present and an object — is well-typed; we pass it through verbatim.
 */
function extractDocumentDurability(
  document: unknown
): FlowDurabilityPolicy | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const raw = (document as Record<string, unknown>)["durability"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  return raw as FlowDurabilityPolicy;
}
