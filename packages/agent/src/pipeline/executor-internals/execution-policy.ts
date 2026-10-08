/**
 * Node execution policy checked before a node runs.
 *
 * The persisted shape is `PipelineNodeBase.executionPolicy` in
 * `@dzupagent/runtime-contracts/pipeline-artifact`. It is read structurally
 * here, as `terminalCatch` is, so the runtime does not depend on a contract
 * build that already carries the field.
 *
 * @module pipeline/executor-internals/execution-policy
 */

export const APPROVAL_REQUIRED_CODE = "PIPELINE_APPROVAL_REQUIRED";

/**
 * The run error for a node that requires approval, or `undefined` when the
 * node may run. An approval-required node is never executed (fail closed).
 */
export function approvalRequiredError(
  node: { id: string },
): string | undefined {
  const policy = (node as { executionPolicy?: { requireApproval?: unknown } })
    .executionPolicy;
  if (policy?.requireApproval !== true) return undefined;
  return `${APPROVAL_REQUIRED_CODE}: node "${node.id}" requires approval and was not executed`;
}
