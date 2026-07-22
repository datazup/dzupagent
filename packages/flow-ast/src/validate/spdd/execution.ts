import type {
  FlowNode,
  SpddArmDispatchNode,
  SpddRunValidationNode,
  SpddCollectProofNode,
} from "../../types.js";
import { validateCommonNodeFields } from "../shared.js";
import type { SchemaIssue } from "../shared.js";
import { requireString } from "./helpers.js";

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
