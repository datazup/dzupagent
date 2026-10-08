/**
 * v2-pipeline-policy.ts — lower V2 `policy:` onto `PipelineRuntime` nodes
 * (DZA-DSL-V2-EXECUTOR-S5-20261008-PC).
 *
 * Only the opt-in `pipeline` target admits a policy narrowing, and only on an
 * unguarded top-level step: loop, for-each and fork body executors do not
 * consult `executionPolicy`. The authored fields are copied as they are,
 * matching the local-host oracle's effective policy (the compiler passes no
 * inherited policy): `requireApproval` fails the run before the step runs,
 * and `timeoutMs` / `budgetCents` cap the summed attempt duration and cost.
 *
 * @module compile-orchestrator/v2-pipeline-policy
 */

import type { DslV2PolicyNarrowingBinding } from "@dzupagent/flow-dsl";
import type { NodeExecutionPolicy } from "@dzupagent/runtime-contracts/pipeline-artifact";

import { isTopLevelStep, topLevelStepNode } from "./v2-pipeline-retry.js";

/** Why a binding cannot lower onto `pipeline`, or `undefined` when it can. */
export function pipelinePolicyRefusal(
  binding: DslV2PolicyNarrowingBinding,
): string | undefined {
  return isTopLevelStep(binding.authoredPath)
    ? undefined
    : "policy is admitted only on top-level steps";
}

/** The runtime execution policy equivalent to one V2 policy narrowing. */
export function lowerPipelinePolicy(
  binding: DslV2PolicyNarrowingBinding,
): NodeExecutionPolicy {
  const { requireApproval, budgetCents, timeoutMs } = binding.narrowing;
  return {
    ...(requireApproval === true ? { requireApproval } : {}),
    ...(budgetCents === undefined ? {} : { budgetCents }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/**
 * Attach the admitted policy bindings to the lowered artifact in place.
 * Returns the authored paths whose step has no single primitive node to carry
 * the policy, so the caller fails closed instead of dropping it.
 */
export function applyPipelinePolicies(
  artifact: unknown,
  bindings: readonly DslV2PolicyNarrowingBinding[],
): string[] {
  const unmapped: string[] = [];
  for (const binding of bindings) {
    const target = topLevelStepNode(artifact, binding);
    if (target === undefined) {
      unmapped.push(binding.authoredPath);
      continue;
    }
    target.executionPolicy = lowerPipelinePolicy(binding);
  }
  return unmapped;
}
