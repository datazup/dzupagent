import type {
  SpddAgentSwarmNode,
  SpddArmDispatchNode,
  SpddBuildSourcePackNode,
  SpddCollectProofNode,
  SpddCreateSyncProposalNode,
  SpddGenerateCanvasNode,
  SpddImportSourcesNode,
  SpddProjectPlanNode,
  SpddReviewCanvasNode,
  SpddRunAnalysisNode,
  SpddRunValidationNode,
  SpddScanDriftNode,
  SpddSwarmSubTask,
  SpddValidateCanvasNode,
} from "@dzupagent/flow-ast";

import { DSL_ERROR } from "./errors.js";
import {
  COMMON_NODE_KEYS,
  isPlainObject,
  normalizeCommonNodeFields,
  normalizeStringArray,
  reportUnsupportedFields,
} from "./normalize-value-helpers.js";
import type { DslDiagnostic } from "./types.js";

// ---------------------------------------------------------------------------
// spdd.* normalizers. The formatter (format-spdd-nodes.ts) and the flow-ast
// parser/validator have carried all 13 kinds since Phase 3 Slice 3.1, but the
// DSL normalizer had no arm for any of them, so an authored spdd node failed
// re-parse with UNKNOWN_NODE_TYPE and no spdd kind round-tripped. The key sets
// and required/optional split below mirror format-spdd-nodes.ts field-for-field
// so a field can only be emitted if it can also be read back.
// ---------------------------------------------------------------------------

const RUN_ID = "spddRunId";
const OUTPUT_KEY = "outputKey";

const keys = (...extra: string[]): Set<string> =>
  new Set<string>([...COMMON_NODE_KEYS, RUN_ID, OUTPUT_KEY, ...extra]);

const IMPORT_SOURCES_KEYS = keys("sourceRefs");
const BUILD_SOURCE_PACK_KEYS = keys("sourceRefsKey", "featureId");
const RUN_ANALYSIS_KEYS = keys("planArtifactId", "sourceArtifactIds");
const GENERATE_CANVAS_KEYS = keys("promptAssetVersionId", "title", "objective");
const PROMPT_ASSET_KEYS = keys("promptAssetVersionId");
const ARM_DISPATCH_KEYS = keys("planRunId");
const RUN_VALIDATION_KEYS = keys("planRunId", "executionRunId", "reviewerId");
const COLLECT_PROOF_KEYS = keys("planRunId", "taskId");
const CREATE_SYNC_PROPOSAL_KEYS = keys("driftFindingIdsKey");
const AGENT_SWARM_KEYS = keys("subTasks");

function requiredString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  diagnostics: DslDiagnostic[]
): string {
  const value = raw[key];
  if (typeof value === "string" && value.length > 0) return value;
  diagnostics.push({
    phase: "normalize",
    code: DSL_ERROR.MISSING_REQUIRED_FIELD,
    message: `${key} is required`,
    path: `${path}.${key}`,
  });
  return "";
}

/** Copies `key` onto `node` only when it is a non-empty string. */
function assignOptionalString<T extends object>(
  node: T,
  raw: Record<string, unknown>,
  key: keyof T & string
): void {
  const value = raw[key];
  if (typeof value === "string" && value.length > 0) {
    (node as Record<string, unknown>)[key] = value;
  }
}

/**
 * Normalizes `spdd.agent_swarm` sub-tasks. `role` is required and `input` must
 * be an object; a malformed entry is reported rather than silently dropped, so
 * a lossy author edit cannot pass as an empty swarm.
 */
function normalizeSubTasks(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddSwarmSubTask[] {
  const value = raw["subTasks"];
  if (!Array.isArray(value)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "subTasks is required",
      path: `${path}.subTasks`,
    });
    return [];
  }
  const out: SpddSwarmSubTask[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}.subTasks[${index}]`;
    if (!isPlainObject(entry)) {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: "subTask must be an object",
        path: entryPath,
      });
      return;
    }
    const role = entry["role"];
    if (typeof role !== "string" || role.length === 0) {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.MISSING_REQUIRED_FIELD,
        message: "role is required",
        path: `${entryPath}.role`,
      });
      return;
    }
    const input = entry["input"];
    const subTask: SpddSwarmSubTask = {
      role,
      input: isPlainObject(input) ? input : {},
    };
    const personaRef = entry["personaRef"];
    if (typeof personaRef === "string" && personaRef.length > 0) {
      subTask.personaRef = personaRef;
    }
    out.push(subTask);
  });
  return out;
}

/** Fields every spdd node carries: common node fields + spddRunId + outputKey. */
function spddBase(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): { spddRunId: string; outputKey: string } {
  return {
    spddRunId: requiredString(raw, RUN_ID, path, diagnostics),
    outputKey: requiredString(raw, OUTPUT_KEY, path, diagnostics),
  };
}

export function normalizeSpddImportSources(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddImportSourcesNode {
  reportUnsupportedFields(raw, IMPORT_SOURCES_KEYS, path, diagnostics);
  const sourceRefs = raw["sourceRefs"];
  if (!Array.isArray(sourceRefs)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "sourceRefs is required",
      path: `${path}.sourceRefs`,
    });
  }
  return {
    type: "spdd.import_sources",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    sourceRefs: Array.isArray(sourceRefs) ? [...sourceRefs] : [],
  };
}

export function normalizeSpddBuildSourcePack(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddBuildSourcePackNode {
  reportUnsupportedFields(raw, BUILD_SOURCE_PACK_KEYS, path, diagnostics);
  const node: SpddBuildSourcePackNode = {
    type: "spdd.build_source_pack",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    sourceRefsKey: requiredString(raw, "sourceRefsKey", path, diagnostics),
  };
  assignOptionalString(node, raw, "featureId");
  return node;
}

export function normalizeSpddRunAnalysis(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddRunAnalysisNode {
  reportUnsupportedFields(raw, RUN_ANALYSIS_KEYS, path, diagnostics);
  const node: SpddRunAnalysisNode = {
    type: "spdd.run_analysis",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    planArtifactId: requiredString(raw, "planArtifactId", path, diagnostics),
  };
  if (raw["sourceArtifactIds"] !== undefined) {
    node.sourceArtifactIds = normalizeStringArray(
      raw["sourceArtifactIds"],
      `${path}.sourceArtifactIds`,
      diagnostics
    );
  }
  return node;
}

export function normalizeSpddGenerateCanvas(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddGenerateCanvasNode {
  reportUnsupportedFields(raw, GENERATE_CANVAS_KEYS, path, diagnostics);
  const node: SpddGenerateCanvasNode = {
    type: "spdd.generate_canvas",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    promptAssetVersionId: requiredString(
      raw,
      "promptAssetVersionId",
      path,
      diagnostics
    ),
  };
  assignOptionalString(node, raw, "title");
  assignOptionalString(node, raw, "objective");
  return node;
}

export function normalizeSpddValidateCanvas(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddValidateCanvasNode {
  reportUnsupportedFields(raw, PROMPT_ASSET_KEYS, path, diagnostics);
  return {
    type: "spdd.validate_canvas",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    promptAssetVersionId: requiredString(
      raw,
      "promptAssetVersionId",
      path,
      diagnostics
    ),
  };
}

export function normalizeSpddReviewCanvas(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddReviewCanvasNode {
  reportUnsupportedFields(raw, PROMPT_ASSET_KEYS, path, diagnostics);
  return {
    type: "spdd.review_canvas",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    promptAssetVersionId: requiredString(
      raw,
      "promptAssetVersionId",
      path,
      diagnostics
    ),
  };
}

export function normalizeSpddProjectPlan(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddProjectPlanNode {
  reportUnsupportedFields(raw, PROMPT_ASSET_KEYS, path, diagnostics);
  return {
    type: "spdd.project_plan",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    promptAssetVersionId: requiredString(
      raw,
      "promptAssetVersionId",
      path,
      diagnostics
    ),
  };
}

export function normalizeSpddArmDispatch(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddArmDispatchNode {
  reportUnsupportedFields(raw, ARM_DISPATCH_KEYS, path, diagnostics);
  return {
    type: "spdd.arm_dispatch",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    planRunId: requiredString(raw, "planRunId", path, diagnostics),
  };
}

export function normalizeSpddRunValidation(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddRunValidationNode {
  reportUnsupportedFields(raw, RUN_VALIDATION_KEYS, path, diagnostics);
  const node: SpddRunValidationNode = {
    type: "spdd.run_validation",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    planRunId: requiredString(raw, "planRunId", path, diagnostics),
    executionRunId: requiredString(raw, "executionRunId", path, diagnostics),
  };
  assignOptionalString(node, raw, "reviewerId");
  return node;
}

export function normalizeSpddCollectProof(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddCollectProofNode {
  reportUnsupportedFields(raw, COLLECT_PROOF_KEYS, path, diagnostics);
  const node: SpddCollectProofNode = {
    type: "spdd.collect_proof",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    planRunId: requiredString(raw, "planRunId", path, diagnostics),
  };
  assignOptionalString(node, raw, "taskId");
  return node;
}

export function normalizeSpddScanDrift(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddScanDriftNode {
  reportUnsupportedFields(raw, PROMPT_ASSET_KEYS, path, diagnostics);
  return {
    type: "spdd.scan_drift",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    promptAssetVersionId: requiredString(
      raw,
      "promptAssetVersionId",
      path,
      diagnostics
    ),
  };
}

export function normalizeSpddCreateSyncProposal(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddCreateSyncProposalNode {
  reportUnsupportedFields(raw, CREATE_SYNC_PROPOSAL_KEYS, path, diagnostics);
  return {
    type: "spdd.create_sync_proposal",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    driftFindingIdsKey: requiredString(
      raw,
      "driftFindingIdsKey",
      path,
      diagnostics
    ),
  };
}

export function normalizeSpddAgentSwarm(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpddAgentSwarmNode {
  reportUnsupportedFields(raw, AGENT_SWARM_KEYS, path, diagnostics);
  return {
    type: "spdd.agent_swarm",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    ...spddBase(raw, path, diagnostics),
    subTasks: normalizeSubTasks(raw, path, diagnostics),
  };
}
