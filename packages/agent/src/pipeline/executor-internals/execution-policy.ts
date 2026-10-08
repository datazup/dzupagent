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

import type { NodeResult } from "../pipeline-runtime-types.js";

export const APPROVAL_REQUIRED_CODE = "PIPELINE_APPROVAL_REQUIRED";
export const BUDGET_EXCEEDED_CODE = "PIPELINE_BUDGET_EXCEEDED";
export const BUDGET_COST_UNKNOWN_CODE = "PIPELINE_BUDGET_COST_UNKNOWN";
export const TIMEOUT_EXCEEDED_CODE = "PIPELINE_TIMEOUT_EXCEEDED";
export const TIMEOUT_DURATION_UNKNOWN_CODE = "PIPELINE_TIMEOUT_DURATION_UNKNOWN";

interface ExecutionPolicyLike {
  requireApproval?: unknown;
  budgetCents?: unknown;
  timeoutMs?: unknown;
}

function policyOf(node: { id: string }): ExecutionPolicyLike | undefined {
  return (node as { executionPolicy?: ExecutionPolicyLike }).executionPolicy;
}

/**
 * The run error for a node that requires approval, or `undefined` when the
 * node may run. An approval-required node is never executed (fail closed).
 */
export function approvalRequiredError(
  node: { id: string },
): string | undefined {
  if (policyOf(node)?.requireApproval !== true) return undefined;
  return `${APPROVAL_REQUIRED_CODE}: node "${node.id}" requires approval and was not executed`;
}

/** The node's cumulative cost budget in cents, when it declares one. */
export function nodeBudgetCents(node: { id: string }): number | undefined {
  const budget = policyOf(node)?.budgetCents;
  return typeof budget === "number" ? budget : undefined;
}

/**
 * The run error for a budgeted node whose cost cannot be read. Without a
 * cost source the budget cannot be enforced, so the node is not executed.
 */
export function budgetCostSourceMissingError(
  node: { id: string },
  hasCostSource: boolean,
): string | undefined {
  if (hasCostSource || nodeBudgetCents(node) === undefined) return undefined;
  return `${BUDGET_COST_UNKNOWN_CODE}: node "${node.id}" declares budgetCents but no node cost source is configured`;
}

/**
 * Running cost of one budgeted node across its attempts. `charge` returns a
 * terminal failed result once the cost is unreadable or the total exceeds
 * the budget, and `undefined` while the node is within budget.
 */
export function createNodeBudget(
  nodeId: string,
  budgetCents: number,
  costOf: (nodeId: string, result: NodeResult) => number | undefined,
): { charge(result: NodeResult): NodeResult | undefined } {
  let spentCents = 0;
  return {
    charge(result) {
      const cost = costOf(nodeId, result);
      if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
        return policyFailure(
          nodeId,
          `${BUDGET_COST_UNKNOWN_CODE}: node "${nodeId}" attempt cost ${String(cost)} is not a finite non-negative number`,
          { code: BUDGET_COST_UNKNOWN_CODE },
        );
      }
      spentCents += cost;
      if (spentCents <= budgetCents) return undefined;
      return policyFailure(
        nodeId,
        `${BUDGET_EXCEEDED_CODE}: node "${nodeId}" spent ${spentCents} of ${budgetCents} cents`,
        { code: BUDGET_EXCEEDED_CODE, costCents: spentCents, budgetCents },
      );
    },
  };
}

/** The node's cumulative time limit in milliseconds, when it declares one. */
export function nodeTimeoutMs(node: { id: string }): number | undefined {
  const timeout = policyOf(node)?.timeoutMs;
  return typeof timeout === "number" ? timeout : undefined;
}

/**
 * Running time of one node with a cumulative limit: each attempt's reported
 * `durationMs` plus each retry backoff. `charge` and `chargeBackoff` return
 * a terminal failed result once the duration is unreadable or the total
 * exceeds the limit, and `undefined` while the node is within it.
 */
export function createNodeClock(
  nodeId: string,
  timeoutMs: number,
): {
  charge(result: NodeResult): NodeResult | undefined;
  chargeBackoff(backoffMs: number): NodeResult | undefined;
} {
  let usedMs = 0;
  const add = (ms: number): NodeResult | undefined => {
    usedMs += ms;
    if (usedMs <= timeoutMs) return undefined;
    return policyFailure(
      nodeId,
      `${TIMEOUT_EXCEEDED_CODE}: node "${nodeId}" used ${usedMs} of ${timeoutMs} ms`,
      { code: TIMEOUT_EXCEEDED_CODE, durationMs: usedMs, timeoutMs },
    );
  };
  return {
    charge(result) {
      const ms = result.durationMs;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
        return policyFailure(
          nodeId,
          `${TIMEOUT_DURATION_UNKNOWN_CODE}: node "${nodeId}" attempt duration ${String(ms)} is not a finite non-negative number`,
          { code: TIMEOUT_DURATION_UNKNOWN_CODE },
        );
      }
      return add(ms);
    },
    chargeBackoff: add,
  };
}

function policyFailure(
  nodeId: string,
  error: string,
  errorMetadata: Record<string, unknown>,
): NodeResult {
  return { nodeId, output: undefined, durationMs: 0, error, errorMetadata };
}
