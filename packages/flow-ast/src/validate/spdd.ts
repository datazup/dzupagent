import type {
  FlowNode,
  SpddImportSourcesNode,
  SpddBuildSourcePackNode,
  SpddRunAnalysisNode,
  SpddGenerateCanvasNode,
  SpddValidateCanvasNode,
  SpddReviewCanvasNode,
  SpddProjectPlanNode,
  SpddArmDispatchNode,
  SpddRunValidationNode,
  SpddCollectProofNode,
  SpddScanDriftNode,
  SpddCreateSyncProposalNode,
  SpddAgentSwarmNode,
  SpddSwarmSubTask,
} from "../types.js";
import {
  describeJsType,
  isPlainObject,
  joinPath,
} from "../validation-helpers.js";
import { validateCommonNodeFields } from "./shared.js";
import type { SchemaIssue } from "./shared.js";

function requireString(
  obj: Record<string, unknown>,
  path: string,
  field: string,
  nodeType: string,
  issues: SchemaIssue[]
): string | null {
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    issues.push({
      path: joinPath(path, field),
      code: "MISSING_REQUIRED_FIELD",
      message: `${nodeType}.${field} is required (non-empty string), received ${describeJsType(
        value
      )}`,
    });
    return null;
  }
  return value;
}

function requireSubTasks(
  obj: Record<string, unknown>,
  path: string,
  nodeType: string,
  issues: SchemaIssue[]
): SpddSwarmSubTask[] | null {
  const value = obj["subTasks"];
  if (!Array.isArray(value)) {
    issues.push({
      path: joinPath(path, "subTasks"),
      code: "MISSING_REQUIRED_FIELD",
      message: `${nodeType}.subTasks is required (array), received ${describeJsType(
        value
      )}`,
    });
    return null;
  }

  const subTasks: SpddSwarmSubTask[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    const itemPath = joinPath(joinPath(path, "subTasks"), String(index));
    if (!isPlainObject(item)) {
      issues.push({
        path: itemPath,
        code: "MISSING_REQUIRED_FIELD",
        message: `${nodeType}.subTasks items must be objects, received ${describeJsType(
          item
        )}`,
      });
      return null;
    }

    const role = requireString(item, itemPath, "role", nodeType, issues);
    if (role === null) return null;
    const personaRef =
      typeof item.personaRef === "string" ? item.personaRef : undefined;
    const input = isPlainObject(item.input)
      ? (item.input as Record<string, unknown>)
      : {};
    subTasks.push(
      personaRef === undefined ? { role, input } : { role, personaRef, input }
    );
  }

  return subTasks;
}

function requireArray(
  obj: Record<string, unknown>,
  path: string,
  field: string,
  nodeType: string,
  issues: SchemaIssue[]
): unknown[] | null {
  const value = obj[field];
  if (!Array.isArray(value)) {
    issues.push({
      path: joinPath(path, field),
      code: "MISSING_REQUIRED_FIELD",
      message: `${nodeType}.${field} is required (array), received ${describeJsType(
        value
      )}`,
    });
    return null;
  }
  return value;
}

export function validateSpddImportSources(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.import_sources",
    issues
  );
  const sourceRefs = requireArray(
    obj,
    path,
    "sourceRefs",
    "spdd.import_sources",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.import_sources",
    issues
  );
  if (spddRunId === null || sourceRefs === null || outputKey === null)
    return null;
  const node: SpddImportSourcesNode = {
    type: "spdd.import_sources",
    ...common,
    spddRunId,
    sourceRefs,
    outputKey,
  };
  return node;
}

export function validateSpddBuildSourcePack(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.build_source_pack",
    issues
  );
  const sourceRefsKey = requireString(
    obj,
    path,
    "sourceRefsKey",
    "spdd.build_source_pack",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.build_source_pack",
    issues
  );
  if (spddRunId === null || sourceRefsKey === null || outputKey === null)
    return null;
  const node: SpddBuildSourcePackNode = {
    type: "spdd.build_source_pack",
    ...common,
    spddRunId,
    sourceRefsKey,
    outputKey,
  };
  if (typeof obj["featureId"] === "string") node.featureId = obj["featureId"];
  return node;
}

export function validateSpddRunAnalysis(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.run_analysis",
    issues
  );
  const planArtifactId = requireString(
    obj,
    path,
    "planArtifactId",
    "spdd.run_analysis",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.run_analysis",
    issues
  );
  if (spddRunId === null || planArtifactId === null || outputKey === null)
    return null;
  const node: SpddRunAnalysisNode = {
    type: "spdd.run_analysis",
    ...common,
    spddRunId,
    planArtifactId,
    outputKey,
  };
  if (Array.isArray(obj["sourceArtifactIds"])) {
    node.sourceArtifactIds = obj["sourceArtifactIds"] as string[];
  }
  return node;
}

export function validateSpddGenerateCanvas(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.generate_canvas",
    issues
  );
  const promptAssetVersionId = requireString(
    obj,
    path,
    "promptAssetVersionId",
    "spdd.generate_canvas",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.generate_canvas",
    issues
  );
  if (spddRunId === null || promptAssetVersionId === null || outputKey === null)
    return null;
  const node: SpddGenerateCanvasNode = {
    type: "spdd.generate_canvas",
    ...common,
    spddRunId,
    promptAssetVersionId,
    outputKey,
  };
  if (typeof obj["title"] === "string") node.title = obj["title"];
  if (typeof obj["objective"] === "string") node.objective = obj["objective"];
  return node;
}

export function validateSpddValidateCanvas(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.validate_canvas",
    issues
  );
  const promptAssetVersionId = requireString(
    obj,
    path,
    "promptAssetVersionId",
    "spdd.validate_canvas",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.validate_canvas",
    issues
  );
  if (spddRunId === null || promptAssetVersionId === null || outputKey === null)
    return null;
  const node: SpddValidateCanvasNode = {
    type: "spdd.validate_canvas",
    ...common,
    spddRunId,
    promptAssetVersionId,
    outputKey,
  };
  return node;
}

export function validateSpddReviewCanvas(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.review_canvas",
    issues
  );
  const promptAssetVersionId = requireString(
    obj,
    path,
    "promptAssetVersionId",
    "spdd.review_canvas",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.review_canvas",
    issues
  );
  if (spddRunId === null || promptAssetVersionId === null || outputKey === null)
    return null;
  const node: SpddReviewCanvasNode = {
    type: "spdd.review_canvas",
    ...common,
    spddRunId,
    promptAssetVersionId,
    outputKey,
  };
  return node;
}

export function validateSpddProjectPlan(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.project_plan",
    issues
  );
  const promptAssetVersionId = requireString(
    obj,
    path,
    "promptAssetVersionId",
    "spdd.project_plan",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.project_plan",
    issues
  );
  if (spddRunId === null || promptAssetVersionId === null || outputKey === null)
    return null;
  const node: SpddProjectPlanNode = {
    type: "spdd.project_plan",
    ...common,
    spddRunId,
    promptAssetVersionId,
    outputKey,
  };
  return node;
}

export function validateSpddArmDispatch(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.arm_dispatch",
    issues
  );
  const planRunId = requireString(
    obj,
    path,
    "planRunId",
    "spdd.arm_dispatch",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.arm_dispatch",
    issues
  );
  if (spddRunId === null || planRunId === null || outputKey === null)
    return null;
  const node: SpddArmDispatchNode = {
    type: "spdd.arm_dispatch",
    ...common,
    spddRunId,
    planRunId,
    outputKey,
  };
  return node;
}

export function validateSpddRunValidation(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.run_validation",
    issues
  );
  const planRunId = requireString(
    obj,
    path,
    "planRunId",
    "spdd.run_validation",
    issues
  );
  const executionRunId = requireString(
    obj,
    path,
    "executionRunId",
    "spdd.run_validation",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.run_validation",
    issues
  );
  if (
    spddRunId === null ||
    planRunId === null ||
    executionRunId === null ||
    outputKey === null
  )
    return null;
  const node: SpddRunValidationNode = {
    type: "spdd.run_validation",
    ...common,
    spddRunId,
    planRunId,
    executionRunId,
    outputKey,
  };
  if (typeof obj["reviewerId"] === "string")
    node.reviewerId = obj["reviewerId"];
  return node;
}

export function validateSpddCollectProof(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.collect_proof",
    issues
  );
  const planRunId = requireString(
    obj,
    path,
    "planRunId",
    "spdd.collect_proof",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.collect_proof",
    issues
  );
  if (spddRunId === null || planRunId === null || outputKey === null)
    return null;
  const node: SpddCollectProofNode = {
    type: "spdd.collect_proof",
    ...common,
    spddRunId,
    planRunId,
    outputKey,
  };
  if (typeof obj["taskId"] === "string") node.taskId = obj["taskId"];
  return node;
}

export function validateSpddScanDrift(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.scan_drift",
    issues
  );
  const promptAssetVersionId = requireString(
    obj,
    path,
    "promptAssetVersionId",
    "spdd.scan_drift",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.scan_drift",
    issues
  );
  if (spddRunId === null || promptAssetVersionId === null || outputKey === null)
    return null;
  const node: SpddScanDriftNode = {
    type: "spdd.scan_drift",
    ...common,
    spddRunId,
    promptAssetVersionId,
    outputKey,
  };
  return node;
}

export function validateSpddCreateSyncProposal(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.create_sync_proposal",
    issues
  );
  const driftFindingIdsKey = requireString(
    obj,
    path,
    "driftFindingIdsKey",
    "spdd.create_sync_proposal",
    issues
  );
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.create_sync_proposal",
    issues
  );
  if (spddRunId === null || driftFindingIdsKey === null || outputKey === null)
    return null;
  const node: SpddCreateSyncProposalNode = {
    type: "spdd.create_sync_proposal",
    ...common,
    spddRunId,
    driftFindingIdsKey,
    outputKey,
  };
  return node;
}

export function validateSpddAgentSwarm(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const spddRunId = requireString(
    obj,
    path,
    "spddRunId",
    "spdd.agent_swarm",
    issues
  );
  const subTasks = requireSubTasks(obj, path, "spdd.agent_swarm", issues);
  const outputKey = requireString(
    obj,
    path,
    "outputKey",
    "spdd.agent_swarm",
    issues
  );
  if (spddRunId === null || subTasks === null || outputKey === null)
    return null;
  const node: SpddAgentSwarmNode = {
    type: "spdd.agent_swarm",
    ...common,
    spddRunId,
    subTasks,
    outputKey,
  };
  return node;
}
