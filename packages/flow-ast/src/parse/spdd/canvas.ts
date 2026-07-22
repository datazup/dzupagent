import type {
  SpddGenerateCanvasNode,
  SpddValidateCanvasNode,
  SpddReviewCanvasNode,
  SpddProjectPlanNode,
} from "../../types.js";
import { type ParseContext, parseCommonNodeFields } from "../shared.js";
import { requireStringField } from "./field-helpers.js";

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
