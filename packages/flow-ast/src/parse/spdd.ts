import type {
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
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from "./shared.js";

function requireStringField(
  obj: Record<string, unknown>,
  field: string,
  nodeType: string,
  pointer: string,
  ctx: ParseContext
): string | null {
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `${nodeType}.${field} must be a non-empty string, received ${describeJsType(
        value
      )}`,
      pointer: joinPointer(pointer, field),
    });
    return null;
  }
  return value;
}

function requireArrayField(
  obj: Record<string, unknown>,
  field: string,
  nodeType: string,
  pointer: string,
  ctx: ParseContext
): unknown[] | null {
  const value = obj[field];
  if (!Array.isArray(value)) {
    ctx.errors.push({
      code: "EXPECTED_ARRAY",
      message: `${nodeType}.${field} must be an array, received ${describeJsType(
        value
      )}`,
      pointer: joinPointer(pointer, field),
    });
    return null;
  }
  return value;
}

function requireSubTasksField(
  obj: Record<string, unknown>,
  nodeType: string,
  pointer: string,
  ctx: ParseContext
): SpddSwarmSubTask[] | null {
  const raw = requireArrayField(obj, "subTasks", nodeType, pointer, ctx);
  if (raw === null) return null;
  const subTasks: SpddSwarmSubTask[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const itemPointer = joinPointer(
      joinPointer(pointer, "subTasks"),
      String(i)
    );
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: `${nodeType}.subTasks items must be objects, received ${describeJsType(
          item
        )}`,
        pointer: itemPointer,
      });
      return null;
    }
    const record = item as Record<string, unknown>;
    const role = requireStringField(record, "role", nodeType, itemPointer, ctx);
    if (role === null) return null;
    const personaRef =
      typeof record.personaRef === "string" ? record.personaRef : undefined;
    const input =
      typeof record.input === "object" &&
      record.input !== null &&
      !Array.isArray(record.input)
        ? (record.input as Record<string, unknown>)
        : {};
    subTasks.push(
      personaRef === undefined ? { role, input } : { role, personaRef, input }
    );
  }
  return subTasks;
}

export function parseSpddImportSources(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddImportSourcesNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.import_sources",
    pointer,
    ctx
  );
  const sourceRefs = requireArrayField(
    obj,
    "sourceRefs",
    "spdd.import_sources",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.import_sources",
    pointer,
    ctx
  );
  if (spddRunId === null || sourceRefs === null || outputKey === null)
    return null;
  for (let i = 0; i < sourceRefs.length; i++) {
    const item = sourceRefs[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: `spdd.import_sources.sourceRefs items must be objects, received ${describeJsType(
          item
        )}`,
        pointer: joinPointer(joinPointer(pointer, "sourceRefs"), String(i)),
      });
      return null;
    }
  }
  return {
    type: "spdd.import_sources",
    ...common,
    spddRunId,
    sourceRefs,
    outputKey,
  };
}

export function parseSpddBuildSourcePack(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddBuildSourcePackNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.build_source_pack",
    pointer,
    ctx
  );
  const sourceRefsKey = requireStringField(
    obj,
    "sourceRefsKey",
    "spdd.build_source_pack",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.build_source_pack",
    pointer,
    ctx
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
  if (typeof obj.featureId === "string") node.featureId = obj.featureId;
  return node;
}

export function parseSpddRunAnalysis(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddRunAnalysisNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.run_analysis",
    pointer,
    ctx
  );
  const planArtifactId = requireStringField(
    obj,
    "planArtifactId",
    "spdd.run_analysis",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.run_analysis",
    pointer,
    ctx
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
  if (Array.isArray(obj.sourceArtifactIds)) {
    node.sourceArtifactIds = obj.sourceArtifactIds as string[];
  }
  return node;
}

export function parseSpddGenerateCanvas(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddGenerateCanvasNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.generate_canvas",
    pointer,
    ctx
  );
  const promptAssetVersionId = requireStringField(
    obj,
    "promptAssetVersionId",
    "spdd.generate_canvas",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.generate_canvas",
    pointer,
    ctx
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
  if (typeof obj.title === "string") node.title = obj.title;
  if (typeof obj.objective === "string") node.objective = obj.objective;
  return node;
}

export function parseSpddValidateCanvas(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddValidateCanvasNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.validate_canvas",
    pointer,
    ctx
  );
  const promptAssetVersionId = requireStringField(
    obj,
    "promptAssetVersionId",
    "spdd.validate_canvas",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.validate_canvas",
    pointer,
    ctx
  );
  if (spddRunId === null || promptAssetVersionId === null || outputKey === null)
    return null;
  return {
    type: "spdd.validate_canvas",
    ...common,
    spddRunId,
    promptAssetVersionId,
    outputKey,
  };
}

export function parseSpddReviewCanvas(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddReviewCanvasNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.review_canvas",
    pointer,
    ctx
  );
  const promptAssetVersionId = requireStringField(
    obj,
    "promptAssetVersionId",
    "spdd.review_canvas",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.review_canvas",
    pointer,
    ctx
  );
  if (spddRunId === null || promptAssetVersionId === null || outputKey === null)
    return null;
  return {
    type: "spdd.review_canvas",
    ...common,
    spddRunId,
    promptAssetVersionId,
    outputKey,
  };
}

export function parseSpddProjectPlan(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddProjectPlanNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.project_plan",
    pointer,
    ctx
  );
  const promptAssetVersionId = requireStringField(
    obj,
    "promptAssetVersionId",
    "spdd.project_plan",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.project_plan",
    pointer,
    ctx
  );
  if (spddRunId === null || promptAssetVersionId === null || outputKey === null)
    return null;
  return {
    type: "spdd.project_plan",
    ...common,
    spddRunId,
    promptAssetVersionId,
    outputKey,
  };
}

export function parseSpddArmDispatch(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddArmDispatchNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.arm_dispatch",
    pointer,
    ctx
  );
  const planRunId = requireStringField(
    obj,
    "planRunId",
    "spdd.arm_dispatch",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.arm_dispatch",
    pointer,
    ctx
  );
  if (spddRunId === null || planRunId === null || outputKey === null)
    return null;
  return {
    type: "spdd.arm_dispatch",
    ...common,
    spddRunId,
    planRunId,
    outputKey,
  };
}

export function parseSpddRunValidation(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddRunValidationNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.run_validation",
    pointer,
    ctx
  );
  const planRunId = requireStringField(
    obj,
    "planRunId",
    "spdd.run_validation",
    pointer,
    ctx
  );
  const executionRunId = requireStringField(
    obj,
    "executionRunId",
    "spdd.run_validation",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.run_validation",
    pointer,
    ctx
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
  if (typeof obj.reviewerId === "string") node.reviewerId = obj.reviewerId;
  return node;
}

export function parseSpddCollectProof(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddCollectProofNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.collect_proof",
    pointer,
    ctx
  );
  const planRunId = requireStringField(
    obj,
    "planRunId",
    "spdd.collect_proof",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.collect_proof",
    pointer,
    ctx
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
  if (typeof obj.taskId === "string") node.taskId = obj.taskId;
  return node;
}

export function parseSpddScanDrift(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddScanDriftNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.scan_drift",
    pointer,
    ctx
  );
  const promptAssetVersionId = requireStringField(
    obj,
    "promptAssetVersionId",
    "spdd.scan_drift",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.scan_drift",
    pointer,
    ctx
  );
  if (spddRunId === null || promptAssetVersionId === null || outputKey === null)
    return null;
  return {
    type: "spdd.scan_drift",
    ...common,
    spddRunId,
    promptAssetVersionId,
    outputKey,
  };
}

export function parseSpddCreateSyncProposal(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddCreateSyncProposalNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.create_sync_proposal",
    pointer,
    ctx
  );
  const driftFindingIdsKey = requireStringField(
    obj,
    "driftFindingIdsKey",
    "spdd.create_sync_proposal",
    pointer,
    ctx
  );
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.create_sync_proposal",
    pointer,
    ctx
  );
  if (spddRunId === null || driftFindingIdsKey === null || outputKey === null)
    return null;
  return {
    type: "spdd.create_sync_proposal",
    ...common,
    spddRunId,
    driftFindingIdsKey,
    outputKey,
  };
}

export function parseSpddAgentSwarm(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): SpddAgentSwarmNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);
  const spddRunId = requireStringField(
    obj,
    "spddRunId",
    "spdd.agent_swarm",
    pointer,
    ctx
  );
  const subTasks = requireSubTasksField(obj, "spdd.agent_swarm", pointer, ctx);
  const outputKey = requireStringField(
    obj,
    "outputKey",
    "spdd.agent_swarm",
    pointer,
    ctx
  );
  if (spddRunId === null || subTasks === null || outputKey === null)
    return null;
  return {
    type: "spdd.agent_swarm",
    ...common,
    spddRunId,
    subTasks,
    outputKey,
  };
}
