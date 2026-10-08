/**
 * lowering.ts — Stage 4 emission: route-dispatched lowering, artifact
 * validation, and suspended-exit admission.
 *
 * These three steps are one unit rather than three because each consumes the
 * previous one's output and all of them fail the same way. Splitting them
 * across the caller would mean threading `artifact`, `warnings` and `ports`
 * back out as mutable locals -- which is exactly what the entry module used to
 * do, and why the three lowerer branches each had to assign the same three
 * variables.
 *
 * @module compile-orchestrator/lowering
 */

import type { FlowNode, ResolvedTool } from "@dzupagent/flow-ast";
import type {
  DslV2MultiPortSaveBinding,
  DslV2PolicyNarrowingBinding,
  DslV2RetryPolicyBinding,
  DslV2TerminalCatchBinding,
} from "@dzupagent/flow-dsl";
import { PipelineDefinitionSchema } from "@dzupagent/runtime-contracts/pipeline-artifact";

import { lowerSkillChain } from "../lower/lower-skill-chain.js";
import { lowerPipelineFlat } from "../lower/lower-pipeline-flat.js";
import { lowerPipelineLoop } from "../lower/lower-pipeline-loop.js";
import type { LoweredPorts } from "../lower/_shared-types.js";
import { admitSuspendedExits } from "../suspended-exit-admission.js";
import { insertPipelineApprovalGates } from "./v2-pipeline-approval.js";
import { applyPipelineCatches } from "./v2-pipeline-catch.js";
import { applyPipelinePolicies } from "./v2-pipeline-policy.js";
import { applyPipelineRetries } from "./v2-pipeline-retry.js";
import { applyPipelineSaves } from "./v2-pipeline-save.js";
import type {
  CompilationError,
  CompilationTarget,
  CompilationWarning,
  CompilerOptions,
} from "../types.js";

/** Semantic resolution output the lowerers read. */
export interface LoweringInput {
  readonly ast: FlowNode;
  readonly target: CompilationTarget;
  readonly resolved: Map<string, ResolvedTool>;
  readonly resolvedPersonas: Map<string, string>;
  readonly opts: CompilerOptions;
  /** V2 retry bindings the `pipeline` target admitted (S5-R2). */
  readonly v2RetryPolicies?: readonly DslV2RetryPolicyBinding[];
  /** V2 catch bindings the `pipeline` target admitted (S5-C2). */
  readonly v2TerminalCatches?: readonly DslV2TerminalCatchBinding[];
  /** V2 multi-port save bindings the `pipeline` target admitted (S5-S2). */
  readonly v2MultiPortSaves?: readonly DslV2MultiPortSaveBinding[];
  /** V2 policy narrowings the `pipeline` target admitted (S5-PC). */
  readonly v2PolicyNarrowings?: readonly DslV2PolicyNarrowingBinding[];
}

/**
 * Either a lowered artifact or the stage-4 errors that stopped it. Every
 * failure this module produces is stage 4, so the caller does not have to
 * carry a stage back out.
 */
export type LoweringResult =
  | {
      readonly ok: true;
      readonly artifact: unknown;
      readonly ports: LoweredPorts | undefined;
      readonly warnings: string[];
      readonly suspendedExitWarnings: CompilationWarning[];
    }
  | { readonly ok: false; readonly errors: CompilationError[] };

/** Dispatch to the lowerer the router selected, converting throws to errors. */
function lowerForTarget(input: LoweringInput):
  | {
      readonly artifact: unknown;
      readonly warnings: string[];
      readonly ports: LoweredPorts | undefined;
    }
  | { readonly error: CompilationError } {
  const { ast, target, resolved, resolvedPersonas } = input;
  try {
    if (target === "skill-chain") {
      const out = lowerSkillChain({ ast, resolved, mode: "executable" });
      return {
        artifact: out.artifact,
        warnings: out.warnings,
        ports: undefined,
      };
    }
    if (target === "workflow-builder" || target === "planning-dag") {
      const out = lowerPipelineFlat({
        ast,
        resolved,
        resolvedPersonas,
        mode: "executable",
      });
      return {
        artifact: out.artifact,
        warnings: out.warnings,
        ports: out.ports,
      };
    }
    // target === 'pipeline'
    const out = lowerPipelineLoop({
      ast,
      resolved,
      resolvedPersonas,
      mode: "executable",
      includeForEachEconomicsV2Provenance:
        input.opts.includeForEachEconomicsV2Provenance === true,
    });
    return { artifact: out.artifact, warnings: out.warnings, ports: out.ports };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A lowerer that produced nothing is a flow-authoring problem, not an
    // internal fault, so it gets its own code and an actionable message. The
    // distinction is carried in the thrown message because the lowerers share
    // no error type.
    const emptyArtifact = /no (?:nodes|action nodes) (?:produced|found)/i.test(
      message,
    );
    return {
      error: {
        stage: 4,
        code: emptyArtifact ? "EMPTY_TARGET_ARTIFACT" : "LOWERING_FAILED",
        message: emptyArtifact
          ? `The "${target}" target produced no executable nodes. Add an executable anchor or use a host/runtime that declares the required node capabilities.`
          : `The "${target}" target failed to lower the flow: ${message}`,
        nodePath: "root",
        category: "lowering",
      },
    };
  }
}

/**
 * Re-validate a lowered pipeline artifact against the schema its consumers
 * parse it with.
 *
 * Skill-chain artifacts are not pipelines and are skipped. For every other
 * target this catches a lowerer that returned successfully but produced a
 * shape the runtime would reject -- a failure that would otherwise surface far
 * from the compiler.
 */
function validateLoweredArtifact(
  artifact: unknown,
  target: CompilationTarget,
): CompilationError | undefined {
  if (target === "skill-chain") return undefined;
  const parsed = PipelineDefinitionSchema.safeParse(artifact);
  if (parsed.success) return undefined;
  return {
    stage: 4,
    code: "LOWERING_FAILED",
    message:
      `The "${target}" target produced an invalid pipeline artifact: ` +
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    nodePath: "root",
    category: "lowering",
  };
}

/**
 * F-R2 port consumer: the suspended-exit set carries admission authority.
 *
 * Unattended flows fail closed on a suspended exit unless the operator passed
 * the explicit acknowledgment option; interactive is untouched. Node labels are
 * read off the artifact so a diagnostic can name the step an operator sees
 * rather than its generated id.
 */
function admitPorts(
  ports: LoweredPorts,
  artifact: unknown,
  opts: CompilerOptions,
): {
  readonly errors: CompilationError[];
  readonly warnings: CompilationWarning[];
} {
  const nodeLabels = new Map<string, string>();
  const artifactNodes = (
    artifact as { nodes?: Array<{ id: string; name?: string }> }
  ).nodes;
  for (const node of artifactNodes ?? []) {
    if (node.name !== undefined) nodeLabels.set(node.id, node.name);
  }
  return admitSuspendedExits({
    ports,
    admissionProfile: opts.admissionProfile ?? "interactive",
    acknowledgeSuspendedExits: opts.acknowledgeSuspendedExits ?? false,
    describeNode: (id) => nodeLabels.get(id) ?? id,
  });
}

/** Fail closed for V2 bindings whose step has no single node to carry them. */
function unmappedV2Errors(
  authoredPaths: readonly string[],
  code: string,
  label: string,
  field: string,
): CompilationError[] {
  return authoredPaths.map((authoredPath) => ({
    stage: 4 as const,
    code,
    message:
      `${label} at "${authoredPath}" has no single lowered primitive node on the "pipeline" target ` +
      "to carry it. Artifact emission is blocked.",
    nodePath: `${authoredPath}.${field}`,
    category: "lowering" as const,
  }));
}

/** Run stage 4 end to end: lower, validate the artifact, admit the ports. */
export function lowerAdmittedFlow(input: LoweringInput): LoweringResult {
  const lowered = lowerForTarget(input);
  if ("error" in lowered) return { ok: false, errors: [lowered.error] };

  if (input.target === "pipeline") {
    const unmapped = [
      ...unmappedV2Errors(
        applyPipelineRetries(lowered.artifact, input.v2RetryPolicies ?? []),
        "V2_RETRY_TARGET_UNSUPPORTED",
        "Retry policy",
        "retry",
      ),
      ...unmappedV2Errors(
        applyPipelineCatches(lowered.artifact, input.v2TerminalCatches ?? []),
        "V2_CATCH_TARGET_UNSUPPORTED",
        "Terminal catch",
        "catch",
      ),
      ...unmappedV2Errors(
        applyPipelineSaves(lowered.artifact, input.v2MultiPortSaves ?? []),
        "V2_MULTI_SAVE_TARGET_UNSUPPORTED",
        "Multi-port save",
        "save",
      ),
      ...unmappedV2Errors(
        applyPipelinePolicies(lowered.artifact, input.v2PolicyNarrowings ?? []),
        "V2_POLICY_TARGET_UNSUPPORTED",
        "Policy narrowing",
        "policy",
      ),
    ];
    if (unmapped.length > 0) return { ok: false, errors: unmapped };
    // An approval-required step suspends at a gate for a decision (S5-PO).
    const approvalGates = insertPipelineApprovalGates(lowered.artifact);
    lowered.ports?.suspensionSites.push(...approvalGates);
  }

  const invalidArtifact = validateLoweredArtifact(
    lowered.artifact,
    input.target,
  );
  if (invalidArtifact !== undefined) {
    return { ok: false, errors: [invalidArtifact] };
  }

  let suspendedExitWarnings: CompilationWarning[] = [];
  if (lowered.ports !== undefined) {
    const decision = admitPorts(lowered.ports, lowered.artifact, input.opts);
    if (decision.errors.length > 0) {
      return { ok: false, errors: decision.errors };
    }
    suspendedExitWarnings = decision.warnings;
  }

  return {
    ok: true,
    artifact: lowered.artifact,
    ports: lowered.ports,
    warnings: lowered.warnings,
    suspendedExitWarnings,
  };
}
