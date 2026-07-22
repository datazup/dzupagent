/**
 * @dzupagent/flow-compiler — document + DSL compile entry points (internal).
 *
 * Owns {@link runCompileDocument} and {@link runCompileDsl}, the two
 * source-shaped entry points that prepare their input, delegate the root to
 * {@link runCompile}, and (for documents) re-attach document-level policy and
 * durability. Extracted verbatim from the former monolithic
 * `compile-orchestrator.ts` — structural move only, no behavior change. See
 * MJ-01 decomposition track.
 */

import type {
  FlowDocumentPolicy,
  FlowDurabilityPolicy,
} from "@dzupagent/flow-ast";

import {
  computeDurabilityDiagnostics,
  computeDurabilityErrors,
} from "../stages/durability-diagnostics.js";
import {
  checkpointPolicyFromPolicy,
  checkpointStrategyFromPolicy,
  executionLogPolicyFromPolicy,
  resumePolicyFromPolicy,
} from "../lower/lower-durability-strategy.js";
import {
  prepareFlowInputFromDocument,
  prepareFlowInputFromDsl,
} from "../authoring-input.js";
import { currentFlowRefFromDocument } from "../stages/subflow-inline.js";

import type { CompileSuccess, CompileFailure } from "../types.js";

import { runCompile } from "./pipeline.js";
import type { CompileOrchestratorDeps } from "./pipeline.js";
import { countDiagnosticsByCategory } from "./diagnostics.js";
import { extractFragmentExpansions } from "./evidence.js";

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
    currentFlowRef: currentFlowRefFromDocument(document),
    fragmentExpansions: extractFragmentExpansions(document),
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
    const checkpoint = checkpointPolicyFromPolicy(documentDurability);
    if (checkpoint !== undefined) {
      (result.artifact as Record<string, unknown>)["checkpoint"] = checkpoint;
    }
    const executionLog = executionLogPolicyFromPolicy(documentDurability);
    if (executionLog !== undefined) {
      (result.artifact as Record<string, unknown>)["executionLog"] =
        executionLog;
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
// Document-level policy extraction
// ---------------------------------------------------------------------------

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
