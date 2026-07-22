import type {
  FlowNode,
  SpddGenerateCanvasNode,
  SpddValidateCanvasNode,
  SpddReviewCanvasNode,
  SpddProjectPlanNode,
} from "../../types.js";
import { validateCommonNodeFields } from "../shared.js";
import type { SchemaIssue } from "../shared.js";
import { requireString } from "./helpers.js";

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
