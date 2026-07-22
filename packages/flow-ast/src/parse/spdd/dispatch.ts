import type {
  SpddArmDispatchNode,
  SpddRunValidationNode,
  SpddCollectProofNode,
} from "../../types.js";
import { type ParseContext, parseCommonNodeFields } from "../shared.js";
import { requireStringField } from "./field-helpers.js";

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
